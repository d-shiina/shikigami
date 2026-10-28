//! Review evidence: what an AI changed in a scenario, why, and how it checked
//! the result, so a human can review a revision in Studio and send it back
//! with a reason the AI reads over MCP.
//!
//! Four kinds of records hang off a scenario's revisions:
//!
//! - the change journal ([`crate::store::HistoryEntry`]) carries the AI's own
//!   `summary` of each edit and the IDs of the steps it touched;
//! - `testRun`: a run an AI started over MCP, with its result;
//! - `observation`: a screen the AI looked at (inspect_ui / inspect_page) or
//!   tried a step on (test_step) and named as the basis of an edit: the UI
//!   tree as text and, where the adapter can take one, a masked screenshot;
//! - `review`: a human's verdict on a revision (approved / sent back, with a
//!   reason and notes on individual steps).
//!
//! Everything lives in the per-PC part of the workspace next to the journal
//! (`history/<scenario-id>/evidence.jsonl`, `observations/<id>/`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::ids::{ObservationId, RunId, ScenarioId, StepId};
use crate::ops::EditOp;
use crate::store::{Actor, ChangeKind, HistoryEntry};

/// Longest change summary kept (characters); longer ones are cut.
pub const MAX_SUMMARY_CHARS: usize = 2000;
/// Longest review reason or step note kept (characters).
pub const MAX_REVIEW_TEXT_CHARS: usize = 4000;
/// Largest UI tree stored with an observation (bytes); longer trees are cut.
pub const MAX_TREE_BYTES: usize = 256 * 1024;
/// Largest screenshot stored with an observation (bytes); larger ones are dropped.
pub const MAX_SCREENSHOT_BYTES: usize = 2 * 1024 * 1024;
/// Observations no edit referred to are deleted after this many days.
pub const UNLINKED_OBSERVATION_DAYS: i64 = 3;

/// What produced an observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ObservationSource {
    InspectPage,
    InspectUi,
    TestStep,
    /// The screen when an interactive run in Studio paused on an error.
    RunPause,
}

/// Input for recording an observation.
#[derive(Debug, Clone)]
pub struct NewObservation {
    pub source: ObservationSource,
    /// Short description for lists, e.g. the window title or page URL.
    pub title: String,
    /// What was looked at or tried: inspect params, or the tested step.
    pub request: Value,
    /// test_step only: the step's outcome (`succeeded`, `failed`, ...).
    pub status: Option<String>,
    /// test_step only: the step's output, already masked.
    pub output: Option<Value>,
    /// The UI as text (accessibility / UIA tree), already masked.
    pub tree: Option<String>,
    /// PNG or JPEG bytes, already masked.
    pub screenshot: Option<Vec<u8>>,
}

/// A screen an AI looked at, stored under `observations/<id>/`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: ObservationId,
    pub source: ObservationSource,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    pub actor: Actor,
    pub title: String,
    pub request: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    /// File name of the UI tree (`tree.txt`) in the observation's folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_file: Option<String>,
    /// File name of the screenshot (`screenshot.png` / `.jpg`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_file: Option<String>,
    /// What was cut or left out to keep the size down.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// Revisions whose edits named this observation as their basis.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub linked: Vec<ObservationLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObservationLink {
    pub scenario_id: ScenarioId,
    pub revision: u64,
}

/// An observation with the contents of its files, for Studio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObservationContent {
    #[serde(flatten)]
    pub observation: Observation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<String>,
    /// `data:image/png;base64,...`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_data_url: Option<String>,
}

/// A human's verdict on a revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewVerdict {
    Approved,
    /// Sent back to the AI (差し戻し) with a reason.
    Rejected,
}

/// A note on one step in a review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepNote {
    pub step_id: StepId,
    pub note: String,
}

/// Input for a review (Studio).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewReview {
    /// The revision that was reviewed; must still be the current one.
    pub revision: u64,
    pub verdict: ReviewVerdict,
    /// Why it was sent back (required for `rejected`) or a remark.
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub steps: Vec<StepNote>,
}

/// Result of a run an AI started to test a revision (the revision that ran
/// is the evidence record's `revision`).
#[derive(Debug, Clone, PartialEq)]
pub struct TestRun {
    pub run_id: RunId,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub step_id: Option<StepId>,
    pub version: Option<u32>,
    pub started_at: OffsetDateTime,
    pub finished_at: OffsetDateTime,
}

impl From<TestRun> for EvidenceDetail {
    fn from(r: TestRun) -> Self {
        Self::TestRun {
            run_id: r.run_id,
            status: r.status,
            error_code: r.error_code,
            error_message: r.error_message,
            step_id: r.step_id,
            version: r.version,
            started_at: r.started_at,
            finished_at: r.finished_at,
        }
    }
}

/// One line of `history/<scenario-id>/evidence.jsonl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// Revision this record belongs to.
    pub revision: u64,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    pub actor: Actor,
    #[serde(flatten)]
    pub detail: EvidenceDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EvidenceDetail {
    /// A run an AI started over MCP to test `revision`.
    TestRun {
        run_id: RunId,
        /// `succeeded`, `failed`, `cancelled`, ...
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        /// Step the run failed at.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step_id: Option<StepId>,
        /// Named version the run's content matched.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<u32>,
        #[serde(with = "time::serde::rfc3339")]
        #[schemars(with = "String")]
        started_at: OffsetDateTime,
        #[serde(with = "time::serde::rfc3339")]
        #[schemars(with = "String")]
        finished_at: OffsetDateTime,
    },
    /// An observation named by the edit that created `revision`.
    Observation {
        observation_id: ObservationId,
        source: ObservationSource,
        title: String,
        /// Steps that edit touched.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        step_ids: Vec<StepId>,
        has_screenshot: bool,
    },
    Review {
        verdict: ReviewVerdict,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        reason: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        steps: Vec<StepNote>,
    },
}

impl Evidence {
    pub fn review_verdict(&self) -> Option<ReviewVerdict> {
        match &self.detail {
            EvidenceDetail::Review { verdict, .. } => Some(*verdict),
            _ => None,
        }
    }
}

/// One change in a review timeline (a journal entry without its ops).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    pub revision: u64,
    pub kind: ChangeKind,
    pub actor: Actor,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub at: OffsetDateTime,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_ids: Vec<StepId>,
}

impl From<&HistoryEntry> for ChangeRecord {
    fn from(e: &HistoryEntry) -> Self {
        Self {
            revision: e.revision,
            kind: e.kind,
            actor: e.actor.clone(),
            at: e.at,
            label: e.label.clone(),
            summary: e.summary.clone(),
            step_ids: e.step_ids.clone(),
        }
    }
}

/// What to review: the changes since the last approval and their evidence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTimeline {
    pub scenario_id: ScenarioId,
    /// Current revision of the scenario.
    pub revision: u64,
    /// Changes and evidence after this revision are listed (by default the
    /// last approved revision, or 0).
    pub since_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_approval: Option<Evidence>,
    /// The latest review when it sent the scenario back and nobody approved
    /// it since: what the AI still has to address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_feedback: Option<Evidence>,
    /// Oldest first.
    pub changes: Vec<ChangeRecord>,
    /// Test runs, observations and reviews, oldest first.
    pub evidence: Vec<Evidence>,
}

/// Builds the timeline from the full journal and evidence log.
pub(crate) fn timeline(
    scenario_id: ScenarioId,
    revision: u64,
    since: Option<u64>,
    journal: &[HistoryEntry],
    evidence: Vec<Evidence>,
) -> ReviewTimeline {
    let last_approval = evidence
        .iter()
        .rev()
        .find(|e| e.review_verdict() == Some(ReviewVerdict::Approved))
        .cloned();
    let open_feedback = open_feedback(&evidence);
    let since = since.unwrap_or_else(|| last_approval.as_ref().map_or(0, |a| a.revision));
    ReviewTimeline {
        scenario_id,
        revision,
        since_revision: since,
        last_approval,
        open_feedback,
        changes: journal
            .iter()
            .filter(|e| e.revision > since)
            .map(ChangeRecord::from)
            .collect(),
        evidence: evidence
            .into_iter()
            .filter(|e| e.revision > since)
            .collect(),
    }
}

/// The latest review, when it is a rejection.
pub(crate) fn open_feedback(evidence: &[Evidence]) -> Option<Evidence> {
    evidence
        .iter()
        .rev()
        .find(|e| e.review_verdict().is_some())
        .filter(|e| e.review_verdict() == Some(ReviewVerdict::Rejected))
        .cloned()
}

/// Steps an edit touched, read from its inverse ops (which carry the IDs
/// Core assigned to added steps).
pub(crate) fn touched_steps(inverse: &[EditOp]) -> Vec<StepId> {
    let mut out: Vec<StepId> = Vec::new();
    for op in inverse.iter().rev() {
        let id = match op {
            EditOp::RemoveStep { step_id }
            | EditOp::UpdateStep { step_id, .. }
            | EditOp::MoveStep { step_id, .. } => step_id,
            EditOp::AddStep { step, .. } => &step.id,
            _ => continue,
        };
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// Trims and cuts free text; `None` when empty.
pub(crate) fn clean_text(text: Option<String>, max_chars: usize) -> Option<String> {
    let text = text?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    })
}

/// Cuts `text` to at most `max` bytes on a character boundary.
pub(crate) fn cut_bytes(text: &mut String, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}

/// File extension for screenshot bytes, from their signature.
pub(crate) fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else {
        None
    }
}

/// Standard base64 (for screenshot data URLs).
pub(crate) fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ABC[(n >> (18 - 6 * i)) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_trims_and_cuts() {
        assert_eq!(clean_text(Some("  ".into()), 10), None);
        assert_eq!(
            clean_text(Some(" 理由 ".into()), 10).as_deref(),
            Some("理由")
        );
        assert_eq!(
            clean_text(Some("あいうえお".into()), 3).as_deref(),
            Some("あいう…")
        );
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn cut_bytes_keeps_char_boundaries() {
        let mut s = "ああ".to_owned();
        assert!(cut_bytes(&mut s, 4));
        assert_eq!(s, "あ");
    }
}
