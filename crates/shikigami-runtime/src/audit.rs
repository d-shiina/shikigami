//! One audit trail for a PC: who changed, published and ran which flow,
//! from Studio, the CLI, an AI over MCP, a schedule or a management server
//! (docs/audit.md). It is read from the records each part already keeps,
//! so nothing is written twice and nothing can disagree:
//!
//! - `history/<flow>/journal.jsonl`: every change to a flow, with its actor;
//! - `versions/<flow>/publish.jsonl`: every publish, with who did it;
//! - `audit/mcp.jsonl`: every MCP tool call, including reads and refusals;
//! - `runs/<run>/report.json`: every run, with where it came from.
//!
//! `records.keepDays` in `policy.json` also drops MCP calls older than that
//! (the change journal is kept: undo needs it).

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use shikigami_core::FlowId;
use shikigami_core::store::{Actor, ActorKind, ChangeKind, FileStore};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::event::{RunStatus, RunTrigger};
use crate::record;

/// Where an entry was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuditSource {
    /// A change to a flow (create, edit, undo, redo, delete).
    Change,
    Publish,
    /// A tool call over MCP.
    Mcp,
    Run,
}

/// One line of the audit trail.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub source: AuditSource,
    /// `studio`, `cli`, `mcp`, `schedule`, `remote`, `system`…
    pub actor: String,
    /// The client, the schedule or the person on the server, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    /// `edit`, `publish`, `run`, an MCP tool name…
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// A change's label, a publish note, a run's outcome.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

/// What to read.
#[derive(Debug, Clone, Default)]
pub struct AuditQuery {
    pub since: Option<OffsetDateTime>,
    pub until: Option<OffsetDateTime>,
    pub flow_id: Option<FlowId>,
}

impl AuditQuery {
    fn wants(&self, at: OffsetDateTime, flow: Option<&str>) -> bool {
        self.since.is_none_or(|s| at >= s)
            && self.until.is_none_or(|u| at < u)
            && self
                .flow_id
                .as_ref()
                .is_none_or(|f| flow == Some(f.as_str()))
    }
}

fn actor_kind(kind: ActorKind) -> &'static str {
    match kind {
        ActorKind::Studio => "studio",
        ActorKind::Mcp => "mcp",
        ActorKind::Cli => "cli",
        ActorKind::System => "system",
    }
}

fn change_kind(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Create => "create",
        ChangeKind::Edit => "edit",
        ChangeKind::Undo => "undo",
        ChangeKind::Redo => "redo",
        ChangeKind::Delete => "delete",
    }
}

fn actor(a: &Actor) -> (String, Option<String>) {
    (actor_kind(a.kind).to_owned(), a.name.clone())
}

/// The flows this PC has a journal for (deleted ones too) or the
/// workspace holds now.
fn flow_ids(store: &FileStore) -> Vec<FlowId> {
    let mut ids: Vec<String> = Vec::new();
    for dir in [
        store.local_root().join("history"),
        store.root().join("versions"),
        store.root().join("flows"),
    ] {
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.flatten() {
                if e.path().is_dir()
                    && let Some(name) = e.file_name().to_str()
                {
                    ids.push(name.to_owned());
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .map(FlowId::new)
        .filter(FlowId::is_well_formed)
        .collect()
}

fn changes(store: &FileStore, q: &AuditQuery, out: &mut Vec<AuditEntry>) {
    for id in flow_ids(store) {
        if q.flow_id.as_ref().is_some_and(|f| *f != id) {
            continue;
        }
        for e in store.read_journal(&id, usize::MAX).unwrap_or_default() {
            if !q.wants(e.at, Some(id.as_str())) {
                continue;
            }
            let (actor, who) = actor(&e.actor);
            out.push(AuditEntry {
                at: e.at,
                source: AuditSource::Change,
                actor,
                who,
                action: change_kind(e.kind).to_owned(),
                flow_id: Some(id.to_string()),
                revision: Some(e.revision),
                version: None,
                run_id: None,
                ok: true,
                error_code: None,
                detail: e.summary.clone().unwrap_or(e.label),
            });
        }
        for p in store.read_publish_log(&id).unwrap_or_default() {
            if !q.wants(p.at, Some(id.as_str())) {
                continue;
            }
            let (actor, who) = actor(&p.by);
            out.push(AuditEntry {
                at: p.at,
                source: AuditSource::Publish,
                actor,
                who,
                action: if p.version.is_some() {
                    "publish"
                } else {
                    "unpublish"
                }
                .to_owned(),
                flow_id: Some(id.to_string()),
                revision: None,
                version: p.version,
                run_id: None,
                ok: true,
                error_code: None,
                detail: p.note,
            });
        }
    }
}

/// `audit/mcp.jsonl` of the PC.
pub fn mcp_log(local_root: &Path) -> std::path::PathBuf {
    local_root.join("audit").join("mcp.jsonl")
}

fn time_of(line: &Value) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(line.get("at")?.as_str()?, &Rfc3339).ok()
}

fn mcp_calls(local_root: &Path, q: &AuditQuery, out: &mut Vec<AuditEntry>) {
    let Ok(file) = fs::File::open(mcp_log(local_root)) else {
        return;
    };
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(at) = time_of(&v) else {
            continue;
        };
        let flow = text(&v, "flowId").or_else(|| text(&v, "scenarioId"));
        if !q.wants(at, flow.as_deref()) {
            continue;
        }
        out.push(AuditEntry {
            at,
            source: AuditSource::Mcp,
            actor: "mcp".into(),
            who: text(&v, "client"),
            action: text(&v, "tool").unwrap_or_default(),
            flow_id: flow,
            revision: v.get("revision").and_then(Value::as_u64),
            version: None,
            run_id: text(&v, "runId"),
            ok: v.get("ok").and_then(Value::as_bool).unwrap_or(true),
            error_code: text(&v, "errorCode"),
            detail: text(&v, "class").unwrap_or_default(),
        });
    }
}

fn trigger(t: Option<RunTrigger>) -> &'static str {
    match t {
        Some(RunTrigger::Studio) => "studio",
        Some(RunTrigger::Cli) => "cli",
        Some(RunTrigger::Mcp) => "mcp",
        Some(RunTrigger::Schedule) => "schedule",
        Some(RunTrigger::Remote) => "remote",
        None => "unknown",
    }
}

fn runs(local_root: &Path, q: &AuditQuery, out: &mut Vec<AuditEntry>) {
    for id in record::list_runs(local_root).unwrap_or_default() {
        let Ok(Some(r)) = record::read_report(local_root, &id) else {
            continue;
        };
        if !q.wants(r.started_at, Some(r.flow_id.as_str())) {
            continue;
        }
        let status = serde_json::to_value(r.status)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        out.push(AuditEntry {
            at: r.started_at,
            source: AuditSource::Run,
            actor: trigger(r.origin.trigger).to_owned(),
            who: r.origin.requested_by.clone(),
            action: "run".into(),
            flow_id: Some(r.flow_id.to_string()),
            revision: Some(r.revision),
            version: r.version,
            run_id: Some(r.run_id.to_string()),
            ok: r.status == RunStatus::Succeeded,
            error_code: r.error.as_ref().map(|e| e.code.clone()),
            detail: status,
        });
    }
}

/// The audit trail of this PC, oldest first.
pub fn collect(store: &FileStore, q: &AuditQuery) -> Vec<AuditEntry> {
    let mut out = Vec::new();
    changes(store, q, &mut out);
    mcp_calls(store.local_root(), q, &mut out);
    runs(store.local_root(), q, &mut out);
    out.sort_by_key(|e| e.at);
    out
}

/// Takes the lock that every writer of an append-only log (`log`) holds
/// while it appends, and that [`prune_mcp_log`] holds for the whole
/// read–rewrite–replace, so no line written meanwhile is lost. The lock is
/// on a sibling `<log>.lock` file (not the log itself, which the pruner
/// replaces) and covers other processes too: the MCP server and a run
/// finishing are separate processes. It is released when the file drops.
///
/// # Errors
/// The lock file could not be created or locked.
pub fn lock_log(log: &Path) -> std::io::Result<fs::File> {
    if let Some(dir) = log.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut name = log.as_os_str().to_owned();
    name.push(".lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(std::path::PathBuf::from(name))?;
    file.lock()?;
    Ok(file)
}

/// Drops MCP calls older than `keep_days` from `audit/mcp.jsonl`. Returns
/// how many lines went; failures are logged and change nothing.
pub fn prune_mcp_log(local_root: &Path, keep_days: u32) -> usize {
    let path = mcp_log(local_root);
    if !path.exists() {
        return 0;
    }
    let _lock = match lock_log(&path) {
        Ok(lock) => lock,
        Err(e) => {
            tracing::warn!(error = %e, "could not lock the MCP audit log");
            return 0;
        }
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return 0;
    };
    let cutoff = OffsetDateTime::now_utc() - time::Duration::days(i64::from(keep_days));
    let mut kept = Vec::new();
    let mut removed = 0;
    for line in text.lines() {
        let old = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| time_of(&v))
            .is_some_and(|at| at < cutoff);
        if old {
            removed += 1;
        } else if !line.trim().is_empty() {
            kept.push(line);
        }
    }
    if removed == 0 {
        return 0;
    }
    // Unique per process; the lock already keeps two pruners apart.
    let tmp = path.with_extension(format!("jsonl.{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        for line in &kept {
            f.write_all(line.as_bytes())?;
            f.write_all(b"\n")?;
        }
        f.sync_all()?;
        fs::rename(&tmp, &path)
    };
    match write() {
        Ok(()) => removed,
        Err(e) => {
            tracing::warn!(error = %e, "could not drop old MCP audit lines");
            let _ = fs::remove_file(&tmp);
            0
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::event::{RunOrigin, RunReport};
    use shikigami_core::service::NewFlow;
    use shikigami_core::version::PublishInput;
    use shikigami_core::{FlowService, RunId, StepRegistry};

    #[test]
    fn changes_publishes_ai_calls_and_runs_read_as_one_trail() {
        let dir = tempfile::tempdir().unwrap();
        let svc = FlowService::new(
            FileStore::open(dir.path()).unwrap(),
            StepRegistry::with_builtins(),
        );
        let created = svc
            .create(
                NewFlow {
                    name: "受注".into(),
                    ..NewFlow::default()
                },
                Actor::named(ActorKind::Mcp, "claude-code"),
            )
            .unwrap();
        let id = created.flow.id.clone();
        svc.publish(&id, PublishInput::default(), Actor::new(ActorKind::Studio))
            .unwrap();
        let local = svc.store().local_root().to_path_buf();
        fs::create_dir_all(local.join("audit")).unwrap();
        let old = "2000-01-01T00:00:00Z";
        let now = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
        fs::write(
            mcp_log(&local),
            format!(
                "{{\"at\":\"{old}\",\"tool\":\"list_flows\",\"class\":\"read\",\"ok\":true}}\n\
                 {{\"at\":\"{now}\",\"tool\":\"run_flow\",\"class\":\"run\",\"client\":\"claude-code\",\"ok\":false,\"errorCode\":\"APPROVAL_REQUIRED\",\"flowId\":\"{id}\"}}\n"
            ),
        )
        .unwrap();
        let run = RunId::generate();
        let mut origin = RunOrigin::new(RunTrigger::Schedule).requested_by("毎朝");
        origin.machine = Some("PC-01".into());
        let report = RunReport {
            run_id: run.clone(),
            flow_id: id.clone(),
            flow_name: "受注".into(),
            revision: 1,
            version: Some(1),
            status: RunStatus::Failed,
            started_at: OffsetDateTime::now_utc(),
            finished_at: OffsetDateTime::now_utc(),
            error: None,
            outputs: serde_json::Map::new(),
            subflows: Vec::new(),
            origin,
        };
        record::RunRecorder::create(&local, &run)
            .unwrap()
            .finish(&report)
            .unwrap();

        let all = collect(svc.store(), &AuditQuery::default());
        let actions: Vec<(&str, &str)> = all
            .iter()
            .map(|e| (e.actor.as_str(), e.action.as_str()))
            .collect();
        assert_eq!(actions[0], ("mcp", "list_flows"), "{actions:?}");
        assert!(actions.contains(&("mcp", "create")));
        assert!(actions.contains(&("studio", "publish")));
        assert!(actions.contains(&("mcp", "run_flow")));
        let ran = all.iter().find(|e| e.source == AuditSource::Run).unwrap();
        assert_eq!(ran.actor, "schedule");
        assert_eq!(ran.who.as_deref(), Some("毎朝"));
        assert!(!ran.ok);

        // Filters: by time and by flow.
        let recent = collect(
            svc.store(),
            &AuditQuery {
                since: Some(OffsetDateTime::now_utc() - time::Duration::days(1)),
                ..AuditQuery::default()
            },
        );
        assert!(recent.iter().all(|e| e.action != "list_flows"));
        let other = collect(
            svc.store(),
            &AuditQuery {
                flow_id: Some(FlowId::new("scn_other")),
                ..AuditQuery::default()
            },
        );
        assert!(other.is_empty());

        // keepDays drops old AI calls only.
        assert_eq!(prune_mcp_log(&local, 30), 1);
        let left = collect(svc.store(), &AuditQuery::default());
        assert!(left.iter().all(|e| e.action != "list_flows"));
        assert!(left.iter().any(|e| e.action == "run_flow"));
    }
}
