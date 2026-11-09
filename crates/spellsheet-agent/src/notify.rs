//! Telling people how unattended runs ended: `notify` in `policy.json`
//! posts to Teams, Slack or any webhook (docs/schedules.md). Flows do
//! not have to send mail in a `catch` themselves.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Value, json};
use spellsheet_core::Policy;
use spellsheet_core::policy::{NotifyFormat, NotifyRule, RunOutcome};
use spellsheet_core::{FlowId, RunId};
use spellsheet_runtime::{RunEvent, RunEventEnvelope, RunOrigin, RunReport, RunStatus, RunTrigger};
use time::OffsetDateTime;

fn outcome(status: RunStatus) -> Option<RunOutcome> {
    match status {
        RunStatus::Succeeded => Some(RunOutcome::Succeeded),
        RunStatus::Failed => Some(RunOutcome::Failed),
        RunStatus::Cancelled => Some(RunOutcome::Cancelled),
        _ => None,
    }
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .user_agent(concat!("SpellSheet/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|e| tracing::warn!(error = %e, "no HTTP client for notifications"))
                .ok()
        })
        .as_ref()
}

fn title(report: &RunReport) -> String {
    let what = match report.status {
        RunStatus::Succeeded => "成功",
        RunStatus::Failed => "失敗",
        RunStatus::Cancelled => "取り消し",
        _ => "終了",
    };
    format!("【{what}】{}", report.flow_name)
}

fn trigger_text(report: &RunReport) -> String {
    origin_text(&report.origin)
}

fn origin_text(origin: &RunOrigin) -> String {
    let how = match origin.trigger {
        Some(RunTrigger::Schedule) => "スケジュール",
        Some(RunTrigger::Remote) => "管理サーバー",
        Some(RunTrigger::Cli) => "コマンド",
        Some(RunTrigger::Studio) => "Studio",
        Some(RunTrigger::Mcp) => "AI",
        None => "",
    };
    match &origin.requested_by {
        Some(who) if !how.is_empty() => format!("{how}（{who}）"),
        Some(who) => who.clone(),
        None => how.to_owned(),
    }
}

/// Where the run failed, in the names people see in Studio: the node, and
/// the node inside the called flow when it failed in there. The step ID is
/// only a fallback (an error without a label); the JSON format carries it.
fn place(error: &spellsheet_runtime::RunError) -> Option<String> {
    let node = error
        .step_label
        .clone()
        .or_else(|| error.step_id.as_ref().map(ToString::to_string))?;
    let inner = error.details.as_ref().and_then(|d| d.get("subFlow"));
    let flow = inner
        .and_then(|s| s.get("flowName"))
        .and_then(Value::as_str);
    let step = inner
        .and_then(|s| s.get("stepLabel"))
        .and_then(Value::as_str);
    Some(match (flow, step) {
        (Some(flow), Some(step)) => format!("「{node}」→ サブフロー「{flow}」の「{step}」"),
        _ => format!("「{node}」"),
    })
}

fn local(t: OffsetDateTime) -> String {
    let offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    let t = t.to_offset(offset);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

/// Name / value lines shown in every format.
fn facts(report: &RunReport) -> Vec<(&'static str, String)> {
    let mut out = vec![("フロー", report.flow_name.clone())];
    if let Some(error) = &report.error {
        out.push(("エラー", format!("{}: {}", error.code, error.message)));
        if let Some(place) = place(error) {
            out.push(("ノード", place));
        }
    }
    let how = trigger_text(report);
    if !how.is_empty() {
        out.push(("きっかけ", how));
    }
    if let Some(machine) = &report.origin.machine {
        out.push(("PC", machine.clone()));
    }
    out.push(("開始", local(report.started_at)));
    out.push(("終了", local(report.finished_at)));
    if let Some(v) = report.version {
        out.push(("版", format!("v{v}")));
    }
    out.push(("実行 ID", report.run_id.to_string()));
    out
}

/// The body posted for `report` in `format`.
pub fn message(report: &RunReport, format: NotifyFormat) -> Value {
    let facts = facts(report);
    match format {
        NotifyFormat::Teams => teams_card(
            &title(report),
            if report.status == RunStatus::Failed {
                "Attention"
            } else {
                "Default"
            },
            &facts,
        ),
        NotifyFormat::Slack => {
            let lines: Vec<String> = facts.iter().map(|(k, v)| format!("{k}: {v}")).collect();
            json!({ "text": format!("{}\n{}", title(report), lines.join("\n")) })
        }
        NotifyFormat::Json => json!({
            "event": "runFinished",
            "runId": report.run_id,
            "flowId": report.flow_id,
            "flowName": report.flow_name,
            "status": report.status,
            "version": report.version,
            "error": report.error.as_ref().map(|e| json!({
                "code": e.code, "message": e.message, "stepId": e.step_id, "stepLabel": e.step_label,
            })),
            "startedAt": report.started_at.format(&time::format_description::well_known::Rfc3339).ok(),
            "finishedAt": report.finished_at.format(&time::format_description::well_known::Rfc3339).ok(),
            "origin": report.origin,
            "title": title(report),
        }),
    }
}

/// The rules of `policy` that apply to `report`.
pub fn rules_for<'a>(policy: &'a Policy, report: &RunReport) -> Vec<&'a NotifyRule> {
    let Some(outcome) = outcome(report.status) else {
        return Vec::new();
    };
    policy
        .notify
        .iter()
        .filter(|r| r.applies(outcome, report.flow_id.as_str()))
        .collect()
}

/// Posts `report` to every webhook in the `notify` rules of the
/// `policy.json` at `policy_path` that apply to it. Failures are logged:
/// a notification never changes a run's result.
pub async fn notify(policy_path: &Path, report: &RunReport) {
    let policy = match Policy::load(policy_path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "notifications not sent: policy.json is broken");
            return;
        }
    };
    let rules = rules_for(&policy, report);
    if rules.is_empty() {
        return;
    }
    for rule in rules {
        post(rule, &message(report, rule.format)).await;
    }
}

/// An unattended run that started waiting for a person: nobody may be at
/// the PC, so `notify` rules with `waiting` in `on` say so while it waits
/// (it fails when its time runs out, which `failed` reports as usual).
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub run_id: RunId,
    pub flow_id: FlowId,
    pub flow_name: String,
    /// What the step asks the person to do.
    pub message: String,
    pub origin: RunOrigin,
    pub at: OffsetDateTime,
}

/// Follows a run's events and tells when a wait for a person starts.
#[derive(Debug, Default)]
pub struct WaitWatch {
    started: Option<(FlowId, String, RunOrigin)>,
}

impl WaitWatch {
    pub fn on_event(&mut self, e: &RunEventEnvelope) -> Option<Waiting> {
        match &e.event {
            RunEvent::RunStarted {
                flow_id,
                flow_name,
                origin,
                ..
            } if e.call_path.is_empty() => {
                self.started = Some((flow_id.clone(), flow_name.clone(), origin.clone()));
                None
            }
            RunEvent::HumanActionRequired { message, .. } => {
                let (flow_id, flow_name, origin) = self.started.clone()?;
                Some(Waiting {
                    run_id: e.run_id.clone(),
                    flow_id,
                    flow_name,
                    message: message.clone(),
                    origin,
                    at: e.at,
                })
            }
            _ => None,
        }
    }
}

fn waiting_title(w: &Waiting) -> String {
    format!("【操作待ち】{}", w.flow_name)
}

/// The body posted for `w` in `format`.
pub fn waiting_message(w: &Waiting, format: NotifyFormat) -> Value {
    let mut facts = vec![
        ("フロー", w.flow_name.clone()),
        ("待っていること", w.message.clone()),
    ];
    let how = origin_text(&w.origin);
    if !how.is_empty() {
        facts.push(("きっかけ", how));
    }
    if let Some(machine) = &w.origin.machine {
        facts.push(("PC", machine.clone()));
    }
    facts.push(("待ち始めた時刻", local(w.at)));
    facts.push(("実行 ID", w.run_id.to_string()));
    match format {
        NotifyFormat::Teams => teams_card(&waiting_title(w), "Warning", &facts),
        NotifyFormat::Slack => {
            let lines: Vec<String> = facts.iter().map(|(k, v)| format!("{k}: {v}")).collect();
            json!({ "text": format!("{}\n{}", waiting_title(w), lines.join("\n")) })
        }
        NotifyFormat::Json => json!({
            "event": "humanActionRequired",
            "runId": w.run_id,
            "flowId": w.flow_id,
            "flowName": w.flow_name,
            "message": w.message,
            "at": w.at.format(&time::format_description::well_known::Rfc3339).ok(),
            "origin": w.origin,
            "title": waiting_title(w),
        }),
    }
}

/// The rules of `policy` that ask for `waiting` and apply to `w`.
pub fn waiting_rules_for<'a>(policy: &'a Policy, w: &Waiting) -> Vec<&'a NotifyRule> {
    policy
        .notify
        .iter()
        .filter(|r| r.applies(RunOutcome::Waiting, w.flow_id.as_str()))
        .collect()
}

/// Posts `w` to every webhook in the `notify` rules that ask for `waiting`.
pub async fn notify_waiting(policy_path: &Path, w: &Waiting) {
    let policy = match Policy::load(policy_path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "notifications not sent: policy.json is broken");
            return;
        }
    };
    for rule in waiting_rules_for(&policy, w) {
        post(rule, &waiting_message(w, rule.format)).await;
    }
}

async fn post(rule: &NotifyRule, body: &Value) {
    let Some(client) = client() else {
        return;
    };
    match client.post(&rule.webhook).json(body).send().await {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => {
            tracing::warn!(status = %r.status(), "the notification webhook refused the message")
        }
        // The URL is the webhook's password (Slack paths, Teams query
        // strings): keep it out of the log.
        Err(e) => tracing::warn!(error = %e.without_url(), "could not send a notification"),
    }
}

fn teams_card(title: &str, color: &str, facts: &[(&str, String)]) -> Value {
    json!({
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "content": {
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                "type": "AdaptiveCard",
                "version": "1.4",
                "body": [
                    {
                        "type": "TextBlock",
                        "text": title,
                        "weight": "Bolder",
                        "size": "Medium",
                        "wrap": true,
                        "color": color,
                    },
                    {
                        "type": "FactSet",
                        "facts": facts.iter().map(|(k, v)| json!({ "title": k, "value": v })).collect::<Vec<_>>(),
                    }
                ]
            }
        }]
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn report(status: &str) -> RunReport {
        serde_json::from_value(json!({
            "runId": "run_1", "flowId": "scn_a", "flowName": "受注取り込み",
            "revision": 1, "version": 2, "status": status,
            "startedAt": "2026-11-06T00:00:00Z", "finishedAt": "2026-11-06T00:01:00Z",
            "error": {
                "code": "ELEMENT_NOT_FOUND", "message": "no button", "stepId": "s3", "stepLabel": "出荷",
                "details": { "subFlow": { "flowId": "scn_s", "flowName": "出荷の入力", "stepId": "t1", "stepLabel": "送信ボタン" } }
            },
            "outputs": { "secretish": "x" },
            "origin": { "trigger": "schedule", "requestedBy": "毎朝", "machine": "PC-01" }
        }))
        .unwrap()
    }

    #[test]
    fn only_matching_rules_send() {
        let policy: Policy = serde_json::from_value(json!({
            "notify": [
                { "webhook": "https://a.example/x" },
                { "webhook": "https://b.example/x", "on": ["succeeded", "failed"], "flows": ["scn_b"], "format": "slack" }
            ]
        }))
        .unwrap();
        assert!(policy.problems().is_empty());
        assert_eq!(rules_for(&policy, &report("failed")).len(), 1);
        assert!(rules_for(&policy, &report("succeeded")).is_empty());
        let bad: Policy =
            serde_json::from_value(json!({ "notify": [{ "webhook": "http://x.example" }] }))
                .unwrap();
        assert_eq!(bad.problems().len(), 1);
    }

    #[test]
    fn messages_say_what_failed_where_and_leave_outputs_out() {
        let r = report("failed");
        let slack = message(&r, NotifyFormat::Slack)["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(slack.starts_with("【失敗】受注取り込み"), "{slack}");
        assert!(slack.contains("ELEMENT_NOT_FOUND: no button"));
        assert!(slack.contains("スケジュール（毎朝）"));
        assert!(slack.contains("PC: PC-01"));
        // Where, in the names Studio shows; never the internal step ID.
        assert!(
            slack.contains("ノード: 「出荷」→ サブフロー「出荷の入力」の「送信ボタン」"),
            "{slack}"
        );
        assert!(!slack.contains("s3"));
        let teams = message(&r, NotifyFormat::Teams);
        assert_eq!(teams["attachments"][0]["content"]["type"], "AdaptiveCard");
        let json = message(&r, NotifyFormat::Json);
        assert_eq!(json["status"], "failed");
        assert_eq!(json["error"]["stepId"], "s3");
        assert_eq!(json["error"]["stepLabel"], "出荷");
        for m in [slack, teams.to_string(), json.to_string()] {
            assert!(!m.contains("secretish"));
        }
    }

    fn event(value: Value) -> RunEventEnvelope {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_wait_is_told_once_to_the_rules_that_ask_for_it() {
        let mut watch = WaitWatch::default();
        let start = event(json!({
            "runId": "run_1", "seq": 0, "at": "2026-11-09T00:00:00Z", "type": "runStarted",
            "flowId": "scn_a", "flowName": "受注取り込み", "revision": 1,
            "origin": { "trigger": "schedule", "requestedBy": "毎朝", "machine": "PC-01" }
        }));
        assert!(watch.on_event(&start).is_none());
        let wait = event(json!({
            "runId": "run_1", "seq": 3, "at": "2026-11-09T00:01:00Z", "type": "humanActionRequired",
            "stepId": "s2", "message": "ブラウザでサインインしてください"
        }));
        let waiting = watch.on_event(&wait).unwrap();
        assert_eq!(waiting.flow_name, "受注取り込み");
        assert_eq!(waiting.message, "ブラウザでサインインしてください");

        let policy: Policy = serde_json::from_value(json!({
            "notify": [
                { "webhook": "https://a.example/x" },
                { "webhook": "https://b.example/x", "on": ["failed", "waiting"], "format": "slack" }
            ]
        }))
        .unwrap();
        assert!(policy.problems().is_empty());
        let rules = waiting_rules_for(&policy, &waiting);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].webhook, "https://b.example/x");

        let slack = waiting_message(&waiting, NotifyFormat::Slack)["text"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(slack.starts_with("【操作待ち】受注取り込み"), "{slack}");
        assert!(slack.contains("待っていること: ブラウザでサインインしてください"));
        assert!(slack.contains("PC: PC-01"));
        assert!(!slack.contains("s2"));
        let teams = waiting_message(&waiting, NotifyFormat::Teams);
        assert_eq!(
            teams["attachments"][0]["content"]["body"][0]["color"],
            "Warning"
        );
        assert_eq!(
            waiting_message(&waiting, NotifyFormat::Json)["event"],
            "humanActionRequired"
        );
    }
}
