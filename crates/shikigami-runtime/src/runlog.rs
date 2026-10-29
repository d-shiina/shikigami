//! The readable log of a run, written into the scenario's folder:
//!
//! ```text
//! <scenario folder>/logs/20261029-140512_succeeded.log
//! <scenario folder>/logs/20261029-141003_failed.log
//! ```
//!
//! One file per run, named by when it started (local time) and how it
//! ended, so a person finds the failed runs by name. Only the newest
//! [`LOGS_KEPT`] are kept. The complete record AI clients read stays in the
//! run record (`runs/<run-id>/events.jsonl`); this file is for people.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use shikigami_core::project::{LOGS_FOLDER, LOGS_KEPT};
use shikigami_core::{Scenario, StepId, StepRegistry, expr};
use time::{OffsetDateTime, UtcOffset};

use crate::event::{RunEvent, RunEventEnvelope, RunStatus};

const RUNNING: &str = "running";

pub(crate) struct RunLog {
    dir: PathBuf,
    stamp: String,
    file: BufWriter<File>,
    offset: UtcOffset,
    /// What each step is called in the log: its name, else its type's label.
    names: HashMap<StepId, String>,
}

impl RunLog {
    /// Starts `logs/<stamp>_running.log`. `None` (and a warning) when the
    /// folder cannot be written: a run never fails for its log.
    pub(crate) fn create<'a>(
        project_dir: &Path,
        scenarios: impl IntoIterator<Item = &'a Scenario>,
        registry: &StepRegistry,
    ) -> Option<Self> {
        let dir = project_dir.join(LOGS_FOLDER);
        let offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
        let now = OffsetDateTime::now_utc().to_offset(offset);
        let base = format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        );
        let opened = fs::create_dir_all(&dir).and_then(|()| {
            // Two runs started in the same second get their own files.
            let mut n = 1;
            loop {
                let stamp = if n == 1 {
                    base.clone()
                } else {
                    format!("{base}-{n}")
                };
                // A finished run's log keeps its stamp too (it was renamed
                // from _running), so the stamp must be free under any status.
                if stamp_taken(&dir, &stamp) && n < 100 {
                    n += 1;
                    continue;
                }
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(dir.join(file_name(&stamp, RUNNING)))
                {
                    Ok(file) => return Ok((stamp, file)),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && n < 100 => n += 1,
                    Err(e) => return Err(e),
                }
            }
        });
        let (stamp, file) = match opened {
            Ok(opened) => opened,
            Err(e) => {
                tracing::warn!(dir = %dir.display(), error = %e, "could not start the run log");
                return None;
            }
        };
        let mut names = HashMap::new();
        for scenario in scenarios {
            for step in scenario.walk() {
                let name = if step.name.trim().is_empty() {
                    registry
                        .get(&step.step_type)
                        .map_or_else(|| step.step_type.clone(), |d| d.label.clone())
                } else {
                    step.name.clone()
                };
                names.insert(step.id.clone(), name);
            }
        }
        Some(Self {
            dir,
            stamp,
            file: BufWriter::new(file),
            offset,
            names,
        })
    }

    fn name(&self, id: &StepId) -> &str {
        self.names.get(id).map_or("", String::as_str)
    }

    /// Writes the line for one event (already masked by the emitter).
    pub(crate) fn write(&mut self, envelope: &RunEventEnvelope) {
        let Some(text) = self.describe(&envelope.event) else {
            return;
        };
        let at = envelope.at.to_offset(self.offset);
        let indent = "  ".repeat(envelope.call_path.len());
        let line = format!(
            "{:02}:{:02}:{:02}.{:03} {indent}{text}\n",
            at.hour(),
            at.minute(),
            at.second(),
            at.millisecond()
        );
        // A full disk must not stop the run.
        let _ = self
            .file
            .write_all(line.as_bytes())
            .and_then(|()| self.file.flush());
    }

    fn describe(&self, event: &RunEvent) -> Option<String> {
        Some(match event {
            RunEvent::RunStarted {
                scenario_name,
                revision,
                ..
            } => format!("START {scenario_name} (revision {revision})"),
            RunEvent::StepStarted {
                step_id,
                step_type,
                attempt,
            } => {
                let retry = if *attempt > 1 {
                    format!(" attempt {attempt}")
                } else {
                    String::new()
                };
                format!("> {} [{step_type} {step_id}]{retry}", self.name(step_id))
            }
            RunEvent::StepFinished {
                step_id,
                outcome,
                duration_ms,
                error,
                will_retry,
                ..
            } => {
                let mut text = format!(
                    "< {} {} ({duration_ms} ms)",
                    self.name(step_id),
                    serde_json::to_value(outcome)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_uppercase))
                        .unwrap_or_default()
                );
                if let Some(error) = error {
                    text.push_str(&format!("\n    {}: {}", error.code, error.message));
                    if let Some(hint) = error
                        .details
                        .as_ref()
                        .and_then(|d| d.get("hint"))
                        .and_then(Value::as_str)
                    {
                        text.push_str(&format!("\n    hint: {hint}"));
                    }
                    if *will_retry {
                        text.push_str("\n    (will retry)");
                    }
                }
                text
            }
            RunEvent::VariableChanged {
                variable, value, ..
            } => format!("  {variable} = {}", preview(value)),
            RunEvent::Log { level, message, .. } => {
                let level = serde_json::to_value(level)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_uppercase))
                    .unwrap_or_default();
                format!("  [{level}] {message}")
            }
            RunEvent::HumanActionRequired { step_id, message } => {
                format!("  WAITING {}: {message}", self.name(step_id))
            }
            RunEvent::Paused {
                step_id, reason, ..
            } => format!(
                "PAUSED at {} ({})",
                self.name(step_id),
                serde_json::to_value(reason)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default()
            ),
            RunEvent::Resumed { revision, .. } => match revision {
                Some(r) => format!("RESUMED on revision {r}"),
                None => "RESUMED".to_owned(),
            },
            RunEvent::RunFinished {
                status,
                error,
                duration_ms,
            } => {
                let mut text = format!(
                    "END {} ({duration_ms} ms)",
                    status_word(*status).to_uppercase()
                );
                if let Some(error) = error {
                    text.push_str(&format!("\n    {}: {}", error.code, error.message));
                    if let Some(step) = &error.step_id {
                        text.push_str(&format!("\n    at {} [{step}]", self.name(step)));
                    }
                }
                text
            }
        })
    }

    /// Renames the file after how the run ended and deletes the oldest
    /// logs beyond [`LOGS_KEPT`].
    pub(crate) fn finish(mut self, status: RunStatus) {
        let _ = self.file.flush();
        let Self {
            dir, stamp, file, ..
        } = self;
        drop(file);
        let from = dir.join(file_name(&stamp, RUNNING));
        let to = dir.join(file_name(&stamp, status_word(status)));
        if let Err(e) = fs::rename(&from, &to) {
            tracing::warn!(path = %from.display(), error = %e, "could not name the run log");
        }
        prune(&dir);
    }
}

fn stamp_taken(dir: &Path, stamp: &str) -> bool {
    let prefix = format!("{stamp}_");
    fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(&prefix))
    })
}

fn file_name(stamp: &str, status: &str) -> String {
    format!("{stamp}_{status}.log")
}

fn status_word(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Succeeded => "succeeded",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Pending | RunStatus::Running | RunStatus::Paused => RUNNING,
    }
}

/// Keeps the newest [`LOGS_KEPT`] run logs (by name: they start with the
/// time). Files the person put there that do not look like run logs stay.
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_run_log)
        })
        .collect();
    if logs.len() <= LOGS_KEPT {
        return;
    }
    logs.sort();
    let excess = logs.len() - LOGS_KEPT;
    for path in logs.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// `20261029-140512_failed.log`, `20261029-140512-2_succeeded.log`.
fn is_run_log(name: &str) -> bool {
    let b = name.as_bytes();
    name.ends_with(".log")
        && b.len() > 16
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'-'
        && b[9..15].iter().all(u8::is_ascii_digit)
}

fn preview(value: &Value) -> String {
    let text = match value {
        Value::String(s) => format!("{s:?}"),
        other => expr::to_display(other),
    };
    let mut chars = text.chars();
    let short: String = chars.by_ref().take(200).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_runs_stamp_is_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("20261029-140512_succeeded.log"), "").unwrap();
        assert!(stamp_taken(dir.path(), "20261029-140512"));
        assert!(!stamp_taken(dir.path(), "20261029-140512-2"));
    }

    #[test]
    fn run_logs_are_told_from_other_files() {
        assert!(is_run_log("20261029-140512_failed.log"));
        assert!(is_run_log("20261029-140512-2_succeeded.log"));
        assert!(!is_run_log("memo.log"));
        assert!(!is_run_log("20261029-140512_failed.txt"));
    }

    #[test]
    fn only_the_newest_logs_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..LOGS_KEPT + 3 {
            fs::write(
                dir.path().join(format!("20260101-{i:06}_succeeded.log")),
                "",
            )
            .unwrap();
        }
        fs::write(dir.path().join("memo.log"), "").unwrap();
        prune(dir.path());
        let mut names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), LOGS_KEPT + 1);
        assert!(names.contains(&"memo.log".to_owned()));
        assert!(!names.contains(&"20260101-000000_succeeded.log".to_owned()));
    }
}
