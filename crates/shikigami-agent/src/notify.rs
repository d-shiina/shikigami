//! Telling people how unattended runs ended: `notify` in `policy.json`
//! posts to Teams, Slack or any webhook (docs/schedules.md). Flows do
//! not have to send mail in a `catch` themselves.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Value, json};
use shikigami_core::Policy;
use shikigami_core::policy::{NotifyFormat, NotifyRule, RunOutcome};
use shikigami_runtime::{RunReport, RunStatus, RunTrigger};

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
                .user_agent(concat!("Shikigami/", env!("CARGO_PKG_VERSION")))
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
    let how = match report.origin.trigger {
        Some(RunTrigger::Schedule) => "スケジュール",
        Some(RunTrigger::Remote) => "管理サーバー",
        Some(RunTrigger::Cli) => "コマンド",
        Some(RunTrigger::Studio) => "Studio",
        Some(RunTrigger::Mcp) => "AI",
        None => "",
    };
    match &report.origin.requested_by {
        Some(who) if !how.is_empty() => format!("{how}（{who}）"),
        Some(who) => who.clone(),
        None => how.to_owned(),
    }
}

/// Name / value lines shown in every format.
fn facts(report: &RunReport) -> Vec<(&'static str, String)> {
    let local = |t: time::OffsetDateTime| {
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
    };
    let mut out = vec![("フロー", report.flow_name.clone())];
    if let Some(error) = &report.error {
        out.push(("エラー", format!("{}: {}", error.code, error.message)));
        if let Some(step) = &error.step_id {
            out.push(("ノード", step.to_string()));
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
        NotifyFormat::Teams => json!({
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
                            "text": title(report),
                            "weight": "Bolder",
                            "size": "Medium",
                            "wrap": true,
                            "color": if report.status == RunStatus::Failed { "Attention" } else { "Default" },
                        },
                        {
                            "type": "FactSet",
                            "facts": facts.iter().map(|(k, v)| json!({ "title": k, "value": v })).collect::<Vec<_>>(),
                        }
                    ]
                }
            }]
        }),
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
                "code": e.code, "message": e.message, "stepId": e.step_id,
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
    let Some(client) = client() else {
        return;
    };
    for rule in rules {
        let body = message(report, rule.format);
        match client.post(&rule.webhook).json(&body).send().await {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => {
                tracing::warn!(status = %r.status(), "the notification webhook refused the message")
            }
            // The URL is the webhook's password (Slack paths, Teams query
            // strings): keep it out of the log.
            Err(e) => tracing::warn!(error = %e.without_url(), "could not send a notification"),
        }
    }
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
            "error": { "code": "ELEMENT_NOT_FOUND", "message": "no button", "stepId": "s3" },
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
        let teams = message(&r, NotifyFormat::Teams);
        assert_eq!(teams["attachments"][0]["content"]["type"], "AdaptiveCard");
        let json = message(&r, NotifyFormat::Json);
        assert_eq!(json["status"], "failed");
        assert_eq!(json["error"]["stepId"], "s3");
        for m in [slack, teams.to_string(), json.to_string()] {
            assert!(!m.contains("secretish"));
        }
    }
}
