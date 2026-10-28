//! A person's approval of one AI action.
//!
//! When the workspace policy says `ask`, the MCP server does not run the
//! action. It files a request here, Studio shows it (「AI が承認を求めています」),
//! and a person approves or refuses that exact request. The AI repeats the
//! call with the request's `approvalId`; the server runs it only when the
//! request was approved, is still fresh, has not been used, and describes
//! the same action (`subject`). One approval is one action.
//!
//! Requests live in the per-PC part of the workspace (`approvals/`), next to
//! the MCP audit log: the AI client, its MCP server and the Studio that
//! answers run on the same PC.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{Duration, OffsetDateTime};

use crate::error::{CoreError, CoreResult};
use crate::ids::{ApprovalId, ScenarioId};
use crate::registry::RiskLevel;
use crate::store::{Actor, ActorKind, write_atomic};

/// How long a request waits for a person before it is dropped.
pub const PENDING_MINUTES: i64 = 30;
/// How long an approval can be used after the person gave it.
pub const APPROVED_MINUTES: i64 = 10;
/// Longest text kept from the AI's reason.
const MAX_REASON_CHARS: usize = 500;

/// AI actions the policy can hold for approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AiAction {
    RunScenario,
    TestStep,
    DeleteScenario,
}

impl AiAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RunScenario => "runScenario",
            Self::TestStep => "testStep",
            Self::DeleteScenario => "deleteScenario",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    /// Approved and already used by the action.
    Used,
}

/// What the MCP server files.
#[derive(Debug, Clone, PartialEq)]
pub struct NewApproval {
    pub action: AiAction,
    pub requested_by: Actor,
    pub scenario_id: Option<ScenarioId>,
    pub scenario_name: Option<String>,
    pub risk: RiskLevel,
    /// The step types that make it risky, e.g. `["file.delete"]`.
    pub step_types: Vec<String>,
    /// The exact action (tested step, run inputs and revision, ...), with
    /// secrets masked. Shown to the person and compared on use.
    pub subject: Value,
    /// The AI's explanation, shown as its own words.
    pub reason: Option<String>,
}

/// One request, `approvals/<id>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: ApprovalId,
    pub action: AiAction,
    pub status: ApprovalStatus,
    #[serde(with = "time::serde::rfc3339")]
    #[schemars(with = "String")]
    pub requested_at: OffsetDateTime,
    pub requested_by: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_id: Option<ScenarioId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_name: Option<String>,
    pub risk: RiskLevel,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_types: Vec<String>,
    pub subject: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(with = "time::serde::rfc3339::option")]
    #[schemars(with = "Option<String>")]
    pub decided_at: Option<OffsetDateTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<Actor>,
}

impl ApprovalRequest {
    fn expired(&self, now: OffsetDateTime) -> bool {
        match (self.status, self.decided_at) {
            (ApprovalStatus::Pending, _) => {
                now - self.requested_at > Duration::minutes(PENDING_MINUTES)
            }
            (ApprovalStatus::Approved, Some(at)) => now - at > Duration::minutes(APPROVED_MINUTES),
            // Refusals and used approvals are kept as long as an approval,
            // so a late retry still learns what happened.
            (_, Some(at)) => now - at > Duration::minutes(APPROVED_MINUTES),
            (_, None) => true,
        }
    }
}

/// The result of presenting an approval with an action.
#[derive(Debug, Clone, PartialEq)]
pub enum Redeem {
    /// Approved for exactly this action; now marked used.
    Granted,
    Pending(ApprovalRequest),
    Denied(ApprovalRequest),
}

/// The `approvals/` folder of one workspace on this PC.
#[derive(Debug, Clone)]
pub struct ApprovalStore {
    dir: PathBuf,
}

impl ApprovalStore {
    /// `local_root` is [`crate::FileStore::local_root`].
    pub fn new(local_root: &Path) -> Self {
        Self {
            dir: local_root.join("approvals"),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, id: &ApprovalId) -> CoreResult<PathBuf> {
        if !id.is_well_formed() {
            return Err(not_found(id));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    fn save(&self, request: &ApprovalRequest) -> CoreResult<()> {
        fs::create_dir_all(&self.dir)?;
        write_atomic(
            &self.path(&request.id)?,
            &serde_json::to_vec_pretty(request)?,
        )
    }

    pub fn get(&self, id: &ApprovalId) -> CoreResult<ApprovalRequest> {
        match fs::read(self.path(id)?) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == ErrorKind::NotFound => Err(not_found(id)),
            Err(e) => Err(e.into()),
        }
    }

    /// Files a request, or returns the pending one for the same action so a
    /// retrying AI does not pile up requests.
    pub fn request(&self, input: NewApproval) -> CoreResult<ApprovalRequest> {
        let now = OffsetDateTime::now_utc();
        if let Some(existing) = self.all()?.into_iter().find(|r| {
            r.status == ApprovalStatus::Pending
                && r.action == input.action
                && r.subject == input.subject
                && !r.expired(now)
        }) {
            return Ok(existing);
        }
        let reason = input
            .reason
            .map(|r| r.trim().chars().take(MAX_REASON_CHARS).collect::<String>())
            .filter(|r| !r.is_empty());
        let request = ApprovalRequest {
            id: ApprovalId::generate(),
            action: input.action,
            status: ApprovalStatus::Pending,
            requested_at: now,
            requested_by: input.requested_by,
            scenario_id: input.scenario_id,
            scenario_name: input.scenario_name,
            risk: input.risk,
            step_types: input.step_types,
            subject: input.subject,
            reason,
            decided_at: None,
            decided_by: None,
        };
        self.save(&request)?;
        Ok(request)
    }

    /// Every request still in force, oldest first. Expired ones are deleted.
    pub fn all(&self) -> CoreResult<Vec<ApprovalRequest>> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let now = OffsetDateTime::now_utc();
        let mut out = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let parsed = fs::read(&path)
                .map_err(CoreError::from)
                .and_then(|b| Ok(serde_json::from_slice::<ApprovalRequest>(&b)?));
            match parsed {
                Ok(r) if r.expired(now) => {
                    let _ = fs::remove_file(&path);
                    let _ = fs::remove_file(path.with_extension("used"));
                }
                Ok(r) => out.push(r),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "skipping unreadable approval request");
                }
            }
        }
        out.sort_by_key(|r| r.requested_at);
        Ok(out)
    }

    /// Requests waiting for a person, oldest first.
    pub fn pending(&self) -> CoreResult<Vec<ApprovalRequest>> {
        Ok(self
            .all()?
            .into_iter()
            .filter(|r| r.status == ApprovalStatus::Pending)
            .collect())
    }

    /// A person approves or refuses a pending request. AI clients cannot
    /// answer their own requests.
    pub fn decide(
        &self,
        id: &ApprovalId,
        approve: bool,
        actor: Actor,
    ) -> CoreResult<ApprovalRequest> {
        if actor.kind == ActorKind::Mcp {
            return Err(CoreError::Rejected {
                code: "APPROVAL_NOT_ALLOWED",
                message: "only a person can answer an approval request".into(),
                hint: Some("The user answers it in Shikigami Studio.".into()),
            });
        }
        let mut request = self.get(id)?;
        let now = OffsetDateTime::now_utc();
        if request.status != ApprovalStatus::Pending || request.expired(now) {
            return Err(CoreError::Rejected {
                code: "APPROVAL_CLOSED",
                message: format!("approval request {id} was already answered or expired"),
                hint: None,
            });
        }
        request.status = if approve {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Denied
        };
        request.decided_at = Some(now);
        request.decided_by = Some(actor);
        self.save(&request)?;
        Ok(request)
    }

    /// Presents approval `id` for an action. Granted only when it was
    /// approved for this very `action` and `subject`, is fresh and unused;
    /// it is then marked used.
    pub fn redeem(&self, id: &ApprovalId, action: AiAction, subject: &Value) -> CoreResult<Redeem> {
        let mut request = self.get(id)?;
        if request.action != action || &request.subject != subject {
            return Err(CoreError::Rejected {
                code: "APPROVAL_MISMATCH",
                message: format!("approval {id} was given for a different action"),
                hint: Some(
                    "An approval covers exactly the request it was filed for. Repeat the same call without approvalId to file a new request."
                        .into(),
                ),
            });
        }
        if request.expired(OffsetDateTime::now_utc()) {
            return Err(not_found(id));
        }
        match request.status {
            ApprovalStatus::Pending => Ok(Redeem::Pending(request)),
            ApprovalStatus::Denied => Ok(Redeem::Denied(request)),
            ApprovalStatus::Used => Err(used(id)),
            ApprovalStatus::Approved => {
                // Claim it atomically: of two servers redeeming at once,
                // only the one that creates the marker runs the action.
                let marker = self.path(id)?.with_extension("used");
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&marker)
                {
                    Ok(_) => {}
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => return Err(used(id)),
                    Err(e) => return Err(e.into()),
                }
                request.status = ApprovalStatus::Used;
                self.save(&request)?;
                Ok(Redeem::Granted)
            }
        }
    }
}

fn used(id: &ApprovalId) -> CoreError {
    CoreError::Rejected {
        code: "APPROVAL_USED",
        message: format!("approval {id} was already used"),
        hint: Some(
            "One approval runs the action once. Repeat the call without approvalId to ask again."
                .into(),
        ),
    }
}

fn not_found(id: &ApprovalId) -> CoreError {
    CoreError::Rejected {
        code: "APPROVAL_NOT_FOUND",
        message: format!("approval request {id} does not exist or expired"),
        hint: Some("Repeat the call without approvalId to file a new request.".into()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(subject: Value) -> NewApproval {
        NewApproval {
            action: AiAction::TestStep,
            requested_by: Actor::named(ActorKind::Mcp, "claude-code"),
            scenario_id: None,
            scenario_name: None,
            risk: RiskLevel::Dangerous,
            step_types: vec!["file.delete".into()],
            subject,
            reason: Some("  古いファイルを消して確かめる  ".into()),
        }
    }

    #[test]
    fn approval_runs_the_same_action_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = ApprovalStore::new(dir.path());
        let subject =
            json!({ "step": { "type": "file.delete", "params": { "path": "C:\\a.txt" } } });
        let r = store.request(input(subject.clone())).unwrap();
        assert_eq!(r.reason.as_deref(), Some("古いファイルを消して確かめる"));
        // A retry before the answer reuses the request.
        assert_eq!(store.request(input(subject.clone())).unwrap().id, r.id);
        assert_eq!(store.pending().unwrap().len(), 1);
        assert!(matches!(
            store.redeem(&r.id, AiAction::TestStep, &subject).unwrap(),
            Redeem::Pending(_)
        ));

        let ai = Actor::new(ActorKind::Mcp);
        assert_eq!(
            store.decide(&r.id, true, ai).unwrap_err().code(),
            "APPROVAL_NOT_ALLOWED"
        );
        store
            .decide(&r.id, true, Actor::new(ActorKind::Studio))
            .unwrap();
        assert!(store.pending().unwrap().is_empty());

        let other = json!({ "step": { "type": "file.delete", "params": { "path": "C:\\b.txt" } } });
        assert_eq!(
            store
                .redeem(&r.id, AiAction::TestStep, &other)
                .unwrap_err()
                .code(),
            "APPROVAL_MISMATCH"
        );
        assert_eq!(
            store.redeem(&r.id, AiAction::TestStep, &subject).unwrap(),
            Redeem::Granted
        );
        assert_eq!(
            store
                .redeem(&r.id, AiAction::TestStep, &subject)
                .unwrap_err()
                .code(),
            "APPROVAL_USED"
        );
    }

    #[test]
    fn two_servers_cannot_both_use_one_approval() {
        let dir = tempfile::tempdir().unwrap();
        let subject = json!({ "x": 1 });
        let r = ApprovalStore::new(dir.path())
            .request(input(subject.clone()))
            .unwrap();
        ApprovalStore::new(dir.path())
            .decide(&r.id, true, Actor::new(ActorKind::Studio))
            .unwrap();
        // Both read `Approved` before either saved `Used`.
        let a = ApprovalStore::new(dir.path());
        let b = ApprovalStore::new(dir.path());
        let mut granted = 0;
        for store in [&a, &b] {
            match store.redeem(&r.id, AiAction::TestStep, &subject) {
                Ok(Redeem::Granted) => granted += 1,
                Err(e) => assert_eq!(e.code(), "APPROVAL_USED"),
                Ok(other) => panic!("unexpected {other:?}"),
            }
            // Undo the status write so the second store sees `Approved` too.
            let mut stale = store.get(&r.id).unwrap();
            stale.status = ApprovalStatus::Approved;
            store.save(&stale).unwrap();
        }
        assert_eq!(granted, 1);
    }

    #[test]
    fn refusals_and_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let store = ApprovalStore::new(dir.path());
        let subject = json!({ "x": 1 });
        let r = store.request(input(subject.clone())).unwrap();
        store
            .decide(&r.id, false, Actor::new(ActorKind::Cli))
            .unwrap();
        assert!(matches!(
            store.redeem(&r.id, AiAction::TestStep, &subject).unwrap(),
            Redeem::Denied(_)
        ));
        assert_eq!(
            store
                .decide(&r.id, true, Actor::new(ActorKind::Studio))
                .unwrap_err()
                .code(),
            "APPROVAL_CLOSED"
        );

        let mut old = store.request(input(json!({ "y": 2 }))).unwrap();
        old.requested_at -= Duration::minutes(PENDING_MINUTES + 1);
        store.save(&old).unwrap();
        assert!(store.all().unwrap().iter().all(|r| r.id != old.id));
        assert_eq!(
            store
                .redeem(&old.id, AiAction::TestStep, &json!({ "y": 2 }))
                .unwrap_err()
                .code(),
            "APPROVAL_NOT_FOUND"
        );
        assert_eq!(
            store.get(&ApprovalId::new("../x")).unwrap_err().code(),
            "APPROVAL_NOT_FOUND"
        );
    }
}
