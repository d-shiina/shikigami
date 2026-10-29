//! Drives the server through a real MCP client over an in-memory transport,
//! the same way Claude Code or Codex talk to it over stdio.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation, JsonObject,
};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Value, json};
use shikigami_core::{
    Actor, ActorKind, FileStore, NewReview, ReviewVerdict, ScenarioId, ScenarioService, StepNote,
};
use shikigami_mcp::{ServerOptions, ShikigamiMcp, ToolClass};
use shikigami_runtime::Runtime;

struct Harness {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    client: RunningService<RoleClient, ClientConfig>,
}

async fn start(options: ServerOptions) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let runtime = Runtime::new();
    let service = Arc::new(ScenarioService::new(
        FileStore::open(&root).unwrap(),
        runtime.registry().clone(),
    ));
    let server = ShikigamiMcp::new(service, runtime, options);
    let (server_io, client_io) = tokio::io::duplex(1 << 20);
    tokio::spawn(async move {
        let running = server.serve(server_io).await.unwrap();
        let _ = running.waiting().await;
    });
    let info = ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("test-client", "1.0"),
    );
    let client = info.serve(client_io).await.unwrap();
    Harness {
        _dir: dir,
        root,
        client,
    }
}

impl Harness {
    /// Calls a tool and returns (isError, structuredContent).
    async fn call(&self, name: &'static str, args: Value) -> (bool, Value) {
        let args: JsonObject = serde_json::from_value(args).unwrap();
        let result = self
            .client
            .call_tool(CallToolRequestParams::new(name).with_arguments(args))
            .await
            .unwrap();
        (
            result.is_error.unwrap_or(false),
            result.structured_content.unwrap_or(Value::Null),
        )
    }

    async fn ok(&self, name: &'static str, args: Value) -> Value {
        let (is_error, value) = self.call(name, args).await;
        assert!(!is_error, "{name} failed: {value}");
        value
    }

    /// A second, independent service on the same workspace — what Studio or
    /// the CLI in another process would see.
    fn other_process(&self) -> ScenarioService {
        ScenarioService::new(
            FileStore::open(&self.root).unwrap(),
            Runtime::new().registry().clone(),
        )
    }
}

#[tokio::test]
async fn ai_builds_validates_and_runs_a_scenario() {
    let h = start(ServerOptions::default()).await;

    let created = h
        .ok(
            "create_scenario",
            json!({
                "name": "合計を出す",
                "variables": [
                    { "name": "items", "type": "array", "direction": "input", "default": [1, 2, 3] },
                    { "name": "sum", "type": "number", "direction": "output", "default": 0 }
                ]
            }),
        )
        .await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["scenario"]["revision"], 1);

    let added = h
        .ok(
            "add_step",
            json!({
                "scenarioId": id,
                "expectedRevision": 1,
                "step": {
                    "type": "control.forEach",
                    "params": { "items": "items", "itemVar": "n" },
                    "blocks": { "body": [
                        { "type": "variable.set", "params": { "name": "sum", "expression": "sum + n" } }
                    ] }
                }
            }),
        )
        .await;
    assert_eq!(added["scenario"]["revision"], 2);
    let loop_id = added["scenario"]["steps"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let report = h.ok("validate_scenario", json!({ "scenarioId": id })).await;
    assert_eq!(report["valid"], true, "{report}");

    let run = h
        .ok(
            "run_scenario",
            json!({ "scenarioId": id, "inputs": { "items": [10, 20] }, "waitMs": 10000 }),
        )
        .await;
    assert_eq!(run["finished"], true);
    assert_eq!(run["report"]["status"], "succeeded");
    assert_eq!(run["report"]["outputs"]["sum"], 30);
    let run_id = run["runId"].as_str().unwrap().to_owned();

    let logs = h.ok("get_run_logs", json!({ "runId": run_id })).await;
    assert_eq!(logs["finished"], true);
    let types: Vec<&str> = logs["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert_eq!(types.first(), Some(&"runStarted"));
    assert_eq!(types.last(), Some(&"runFinished"));
    let last = logs["lastSeq"].as_u64().unwrap();
    let more = h
        .ok("get_run_logs", json!({ "runId": run_id, "afterSeq": last }))
        .await;
    assert_eq!(more["events"], json!([]));

    let sums = h
        .ok(
            "get_run_logs",
            json!({ "runId": run_id, "variable": "sum" }),
        )
        .await;
    let trace: Vec<(Value, Option<&str>)> = sums["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            assert_eq!(e["type"], "variableChanged");
            (e["value"].clone(), e["stepId"].as_str())
        })
        .collect();
    let set_id = added["scenario"]["steps"][0]["blocks"]["body"][0]["id"]
        .as_str()
        .unwrap();
    assert_eq!(
        trace,
        [
            (json!(0), None),
            (json!(10), Some(set_id)),
            (json!(30), Some(set_id)),
        ]
    );

    let status = h.ok("get_run_status", json!({ "runId": run_id })).await;
    assert_eq!(status["active"], false);
    assert_eq!(status["report"]["status"], "succeeded");

    let runs = h.ok("list_runs", json!({ "scenarioId": id })).await;
    assert_eq!(runs["runs"][0]["runId"], run_id.as_str());

    // The change is visible to another process and attributed to the client.
    let other = h.other_process();
    let sid = ScenarioId::new(id.as_str());
    assert_eq!(other.get(&sid).unwrap().steps[0].id.as_str(), loop_id);
    let history = other.history(&sid, 10).unwrap();
    assert_eq!(history[0].actor.kind, ActorKind::Mcp);
    assert_eq!(history[0].actor.name.as_deref(), Some("test-client"));

    // Undo through MCP is the same shared stack Studio uses.
    let undone = h.ok("undo", json!({ "scenarioId": id })).await;
    assert_eq!(undone["scenario"]["revision"], 3);
    assert_eq!(
        undone["scenario"]
            .get("steps")
            .map_or(0, |s| s.as_array().unwrap().len()),
        0
    );
    let redone = h.ok("redo", json!({ "scenarioId": id })).await;
    assert_eq!(redone["scenario"]["steps"][0]["id"], loop_id.as_str());

    // Every call is audited.
    let audit = std::fs::read_to_string(h.root.join("audit/mcp.jsonl")).unwrap();
    let lines: Vec<Value> = audit
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(
        lines
            .iter()
            .any(|l| l["tool"] == "run_scenario" && l["ok"] == true)
    );
    assert!(lines.iter().all(|l| l["client"] == "test-client"));

    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn stale_revision_is_reported_as_a_tool_error() {
    let h = start(ServerOptions::default()).await;
    let created = h.ok("create_scenario", json!({ "name": "競合" })).await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();

    // A human edits in Studio meanwhile.
    let other = h.other_process();
    other
        .edit(
            &ScenarioId::new(id.as_str()),
            Some(1),
            vec![
                serde_json::from_value(json!({
                    "op": "addStep",
                    "step": { "type": "log.message", "params": { "message": "人間" } }
                }))
                .unwrap(),
            ],
            shikigami_core::Actor::new(ActorKind::Studio),
        )
        .unwrap();

    let (is_error, value) = h
        .call(
            "add_step",
            json!({
                "scenarioId": id,
                "expectedRevision": 1,
                "step": { "type": "log.message", "params": { "message": "AI" } }
            }),
        )
        .await;
    assert!(is_error);
    assert_eq!(value["code"], "REVISION_CONFLICT");
    assert_eq!(value["details"]["actual"], 2);

    // Invalid drafts are saved but cannot run.
    h.ok(
        "add_step",
        json!({ "scenarioId": id, "step": { "type": "log.message", "params": {} } }),
    )
    .await;
    let (is_error, value) = h.call("run_scenario", json!({ "scenarioId": id })).await;
    assert!(is_error);
    assert_eq!(value["code"], "VALIDATION_FAILED");

    let (is_error, value) = h.call("get_run_status", json!({ "runId": "../etc" })).await;
    assert!(is_error);
    assert_eq!(value["code"], "INVALID_RUN_ID");

    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn long_runs_can_be_polled_and_stopped() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_scenario",
            json!({ "name": "待つ", "steps": [ { "type": "flow.delay", "params": { "ms": 60000 } } ] }),
        )
        .await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();

    let run = h.ok("run_scenario", json!({ "scenarioId": id })).await;
    assert_eq!(run["finished"], false);
    let run_id = run["runId"].as_str().unwrap().to_owned();

    let status = h.ok("get_run_status", json!({ "runId": run_id })).await;
    assert_eq!(status["active"], true);

    h.ok("stop_scenario", json!({ "runId": run_id })).await;
    let mut final_status = Value::Null;
    for _ in 0..100 {
        let s = h.ok("get_run_status", json!({ "runId": run_id })).await;
        if s["active"] == false {
            final_status = s;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(final_status["report"]["status"], "cancelled");

    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn read_only_server_exposes_only_read_tools() {
    let h = start(ServerOptions {
        allow: vec![ToolClass::Read],
        ..ServerOptions::default()
    })
    .await;
    let tools = h.client.list_all_tools().await.unwrap();
    let names: Vec<_> = tools.iter().map(|t| t.name.to_string()).collect();
    assert!(names.contains(&"get_scenario".to_owned()));
    assert!(!names.contains(&"add_step".to_owned()));
    assert!(!names.contains(&"run_scenario".to_owned()));
    for tool in &tools {
        let hints = tool.annotations.as_ref().unwrap();
        assert_eq!(hints.read_only_hint, Some(true), "{}", tool.name);
    }

    let result = h
        .client
        .call_tool(
            CallToolRequestParams::new("create_scenario")
                .with_arguments(serde_json::from_value(json!({ "name": "x" })).unwrap()),
        )
        .await;
    assert!(result.is_err() || result.unwrap().is_error == Some(true));
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn every_tool_has_an_object_input_schema_and_description() {
    let h = start(ServerOptions::default()).await;
    let tools = h.client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 38);
    for tool in tools {
        assert_eq!(
            tool.input_schema.get("type"),
            Some(&json!("object")),
            "{}",
            tool.name
        );
        assert!(
            tool.description.as_deref().is_some_and(|d| !d.is_empty()),
            "{} has no description",
            tool.name
        );
    }
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn a_run_that_cannot_be_recorded_is_not_started() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_scenario",
            json!({ "name": "記録不可", "steps": [ { "type": "log.message", "params": { "message": "x" } } ] }),
        )
        .await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();
    // A file where the runs directory should be makes recording fail.
    std::fs::write(h.root.join("runs"), b"not a directory").unwrap();

    let (is_error, value) = h.call("run_scenario", json!({ "scenarioId": id })).await;
    assert!(is_error);
    assert_eq!(value["code"], "IO_ERROR");
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn test_step_runs_one_step_without_touching_scenarios() {
    let h = start(ServerOptions::default()).await;
    let out = h.ok(
        "test_step",
        json!({ "step": { "type": "variable.set", "params": { "name": "x", "expression": "1 + 2" } } }),
    )
    .await;
    assert_eq!(out["status"], "succeeded");
    let out = h
        .ok(
            "test_step",
            json!({ "step": { "type": "control.fail", "params": { "message": "だめ" } } }),
        )
        .await;
    assert_eq!(out["status"], "failed");
    assert_eq!(out["error"]["message"], "だめ");
    let (is_error, e) = h
        .call("test_step", json!({ "step": { "type": "nope.step" } }))
        .await;
    assert!(is_error);
    assert_eq!(e["code"], "UNKNOWN_STEP_TYPE");
    // Without a browser adapter, inspect_page says so.
    let (is_error, e) = h.call("inspect_page", json!({ "url": "http://x/" })).await;
    assert!(is_error);
    assert_eq!(e["code"], "ADAPTER_UNAVAILABLE");
    let (is_error, e) = h.call("inspect_ui", json!({})).await;
    assert!(is_error);
    assert_eq!(e["code"], "ADAPTER_UNAVAILABLE");
    let scenarios = h.ok("list_scenarios", json!({})).await;
    assert_eq!(scenarios["scenarios"].as_array().map(Vec::len), Some(0));
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn versions_diff_restore_and_bundle_round_trip() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_scenario",
            json!({
                "name": "版テスト",
                "steps": [{ "id": "stp_a", "type": "log.message", "params": { "message": "a" } }]
            }),
        )
        .await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();
    let v = h
        .ok(
            "create_version",
            json!({ "scenarioId": id, "name": "v1", "note": "最初の版", "expectedRevision": 1 }),
        )
        .await;
    assert_eq!(v["version"]["number"], 1);

    h.ok(
        "update_step",
        json!({ "scenarioId": id, "stepId": "stp_a", "patch": { "params": { "message": "b" } } }),
    )
    .await;
    // Defaults: latest version vs. current content.
    let diff = h.ok("diff_versions", json!({ "scenarioId": id })).await;
    assert_eq!(diff["from"]["version"], 1);
    assert_eq!(diff["steps"][0]["kind"], "changed");
    assert_eq!(diff["steps"][0]["fields"][0]["field"], "params.message");

    let restored = h
        .ok("restore_version", json!({ "scenarioId": id, "number": 1 }))
        .await;
    assert_eq!(restored["scenario"]["steps"][0]["params"]["message"], "a");
    assert_eq!(restored["canUndo"], true);

    let listed = h.ok("list_versions", json!({ "scenarioId": id })).await;
    assert_eq!(listed["versions"][0]["note"], "最初の版");
    let got = h
        .ok("get_version", json!({ "scenarioId": id, "number": 1 }))
        .await;
    assert_eq!(got["scenario"]["id"], id.as_str());

    let exported = h.ok("export_scenario", json!({ "scenarioId": id })).await;
    let bundle = exported["bundle"].clone();
    assert_eq!(bundle["format"], "shikigami.scenarioBundle");
    let (is_error, conflict) = h
        .call("import_scenario", json!({ "bundle": bundle.clone() }))
        .await;
    assert!(is_error);
    assert_eq!(conflict["code"], "IMPORT_CONFLICT");
    let copy = h
        .ok(
            "import_scenario",
            json!({ "bundle": bundle, "onConflict": "copy" }),
        )
        .await;
    assert_eq!(copy["mode"], "copied");
    assert_eq!(copy["versionsAdded"], 1);
    assert_ne!(copy["scenario"]["id"], id.as_str());
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn secrets_are_named_but_never_revealed() {
    let h = start(ServerOptions::default()).await;
    // The user registers a login in Studio (same workspace, other process).
    shikigami_secrets::Vault::open(&h.root)
        .set(shikigami_secrets::SecretInput {
            name: "受注システム".into(),
            username: Some("tanaka".into()),
            password: Some("hunter2".into()),
            sites: Some(vec!["https://orders.example.com/login".into()]),
            ..Default::default()
        })
        .unwrap();

    let listed = h.ok("list_secrets", json!({})).await;
    assert_eq!(listed["secrets"][0]["name"], "受注システム");
    assert_eq!(
        listed["secrets"][0]["sites"],
        json!(["https://orders.example.com"])
    );
    assert_eq!(
        listed["secrets"][0]["fields"],
        json!(["username", "password"])
    );
    let text = listed.to_string();
    assert!(!text.contains("hunter2") && !text.contains("tanaka"));

    // Secrets may only be typed into input fields, never logged.
    let (is_error, result) = h
        .call(
            "test_step",
            json!({ "step": { "type": "log.message", "params": { "message": { "secret": "受注システム", "field": "password" } } } }),
        )
        .await;
    assert!(is_error || result["status"] != "succeeded", "{result}");
    assert!(
        result.to_string().contains("SECRET_NOT_ALLOWED"),
        "{result}"
    );
    assert!(!result.to_string().contains("hunter2"));

    // Secret inputs cannot be passed through the AI client.
    let created = h
        .ok(
            "create_scenario",
            json!({
                "name": "ログイン",
                "variables": [{ "name": "pw", "type": "string", "direction": "input", "secret": true }]
            }),
        )
        .await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();
    let (is_error, result) = h
        .call(
            "run_scenario",
            json!({ "scenarioId": id, "inputs": { "pw": "hunter2" } }),
        )
        .await;
    assert!(is_error);
    assert_eq!(result["code"], "SECRET_INPUT_REJECTED");
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn changes_carry_summaries_evidence_and_review_feedback() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_scenario",
            json!({ "name": "レビュー", "summary": "  空のシナリオを作成  " }),
        )
        .await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();

    // What the AI tried before writing the step is kept as an observation.
    let tried = h
        .ok(
            "test_step",
            json!({ "step": { "type": "log.message", "name": "試し", "params": { "message": "hi" } } }),
        )
        .await;
    let obs = tried["observationId"].as_str().unwrap().to_owned();
    assert!(obs.starts_with("obs_"));

    // An unknown observation fails the edit before anything changes.
    let (is_error, e) = h
        .call(
            "add_step",
            json!({ "scenarioId": id, "step": { "type": "log.message", "params": { "message": "x" } }, "observations": ["obs_missing"] }),
        )
        .await;
    assert!(is_error);
    assert_eq!(e["code"], "OBSERVATION_NOT_FOUND");

    let added = h
        .ok(
            "add_step",
            json!({
                "scenarioId": id,
                "expectedRevision": 1,
                "step": { "type": "log.message", "params": { "message": "hi" } },
                "summary": "あいさつを記録する手順を追加",
                "observations": [obs],
            }),
        )
        .await;
    let step_id = added["scenario"]["steps"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let run = h
        .ok("run_scenario", json!({ "scenarioId": id, "waitMs": 10000 }))
        .await;
    assert_eq!(run["report"]["status"], "succeeded");

    let history = h.ok("get_history", json!({ "scenarioId": id })).await;
    assert_eq!(history["entries"][0]["summary"], "空のシナリオを作成");
    assert_eq!(
        history["entries"][1]["summary"],
        "あいさつを記録する手順を追加"
    );
    assert_eq!(history["entries"][1]["stepIds"], json!([step_id]));

    // The human sends revision 2 back from Studio (another process).
    let studio = h.other_process();
    let sid = ScenarioId::new(id.as_str());
    let stale = studio.submit_review(
        &sid,
        NewReview {
            revision: 1,
            verdict: ReviewVerdict::Rejected,
            reason: "古い".into(),
            steps: vec![],
        },
        Actor::new(ActorKind::Studio),
    );
    assert_eq!(stale.unwrap_err().code(), "REVISION_CONFLICT");
    let no_reason = studio.submit_review(
        &sid,
        NewReview {
            revision: 2,
            verdict: ReviewVerdict::Rejected,
            reason: " ".into(),
            steps: vec![],
        },
        Actor::new(ActorKind::Studio),
    );
    assert_eq!(no_reason.unwrap_err().code(), "INVALID_EDIT");
    studio
        .submit_review(
            &sid,
            NewReview {
                revision: 2,
                verdict: ReviewVerdict::Rejected,
                reason: "メッセージは日本語にしてください".into(),
                steps: vec![StepNote {
                    step_id: step_id.as_str().into(),
                    note: "「こんにちは」に".into(),
                }],
            },
            Actor::new(ActorKind::Studio),
        )
        .unwrap();

    let got = h.ok("get_scenario", json!({ "scenarioId": id })).await;
    assert_eq!(got["feedback"]["verdict"], "rejected");
    assert_eq!(
        got["feedback"]["reason"],
        "メッセージは日本語にしてください"
    );
    assert_eq!(got["feedback"]["steps"][0]["stepId"], step_id);

    let review = h.ok("get_review", json!({ "scenarioId": id })).await;
    assert_eq!(review["revision"], 2);
    assert_eq!(review["sinceRevision"], 0);
    assert_eq!(review["changes"].as_array().map(Vec::len), Some(2));
    let kinds: Vec<&str> = review["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["observation", "testRun", "review"]);
    assert_eq!(review["evidence"][0]["observationId"], obs);
    assert_eq!(review["evidence"][0]["stepIds"], json!([step_id]));
    assert_eq!(review["evidence"][1]["revision"], 2);
    assert_eq!(review["evidence"][1]["status"], "succeeded");
    assert_eq!(review["evidence"][1]["actor"]["name"], "test-client");
    assert_eq!(review["openFeedback"]["verdict"], "rejected");

    // Studio reads the observation with its contents.
    let content = studio
        .get_observation(&shikigami_core::ObservationId::new(obs.as_str()))
        .unwrap();
    assert_eq!(content.observation.status.as_deref(), Some("succeeded"));
    assert_eq!(content.observation.linked.len(), 1);

    // The AI fixes it; approval closes the feedback and starts a new round.
    h.ok(
        "update_step",
        json!({ "scenarioId": id, "stepId": step_id, "patch": { "params": { "message": "こんにちは" } }, "summary": "差し戻しに対応：日本語に変更" }),
    )
    .await;
    studio
        .submit_review(
            &sid,
            NewReview {
                revision: 3,
                verdict: ReviewVerdict::Approved,
                reason: String::new(),
                steps: vec![],
            },
            Actor::new(ActorKind::Studio),
        )
        .unwrap();
    let got = h.ok("get_scenario", json!({ "scenarioId": id })).await;
    assert!(got.get("feedback").is_none());
    let review = h.ok("get_review", json!({ "scenarioId": id })).await;
    assert_eq!(review["sinceRevision"], 3);
    assert_eq!(review["changes"].as_array().map(Vec::len), Some(0));
    assert_eq!(review["lastApproval"]["verdict"], "approved");
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn ai_asks_for_a_login_and_the_user_registers_it_in_studio() {
    let h = start(ServerOptions::default()).await;
    let asked = h
        .ok(
            "request_secret",
            json!({ "name": "Google", "sites": ["https://accounts.google.com/v3/signin"], "reason": "Google にログインするため" }),
        )
        .await;
    assert_eq!(asked["status"], "waiting");
    assert_eq!(asked["missing"]["registered"], false);
    assert_eq!(
        asked["request"]["sites"],
        json!(["https://accounts.google.com"])
    );

    // Studio (another process) sees the request and the user fills the form.
    let studio = shikigami_secrets::Vault::open(&h.root);
    let pending = studio.requests().unwrap();
    assert_eq!(pending[0].request.name, "Google");
    assert_eq!(pending[0].request.reason, "Google にログインするため");
    let root = h.root.clone();
    let register = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        shikigami_secrets::Vault::open(&root)
            .set(shikigami_secrets::SecretInput {
                name: "Google".into(),
                username: Some("me@example.com".into()),
                password: Some("hunter2-google".into()),
                sites: Some(vec!["https://accounts.google.com".into()]),
                ..Default::default()
            })
            .unwrap();
    });
    let done = h
        .ok(
            "request_secret",
            json!({ "name": "Google", "sites": ["https://accounts.google.com"], "waitMs": 10000 }),
        )
        .await;
    register.await.unwrap();
    assert_eq!(done["status"], "registered");
    assert_eq!(done["secret"]["fields"], json!(["username", "password"]));
    let text = done.to_string();
    assert!(!text.contains("hunter2-google") && !text.contains("me@example.com"));
    assert!(studio.requests().unwrap().is_empty());

    // A request the user dismisses ends the wait.
    let root = h.root.clone();
    let dismiss = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            shikigami_secrets::Vault::open(&root)
                .dismiss_request("社内")
                .unwrap()
        );
    });
    let declined = h
        .ok(
            "request_secret",
            json!({ "name": "社内", "fields": ["password"], "waitMs": 10000 }),
        )
        .await;
    dismiss.await.unwrap();
    assert_eq!(declined["status"], "dismissed");
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn ai_puts_files_in_the_scenario_folder_and_runs_with_relative_paths() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_scenario",
            json!({
                "name": "設定を読む",
                "variables": [{ "name": "day", "type": "number", "direction": "output", "default": 0 }]
            }),
        )
        .await;
    let id = created["scenario"]["id"].as_str().unwrap().to_owned();

    // A settings file the AI writes, and a file copied in from the PC.
    let settings = json!({
        "format": "shikigami.config",
        "items": [{ "name": "締め日", "type": "number", "value": 25, "description": "毎月の締め日" }]
    });
    h.ok(
        "write_project_file",
        json!({ "scenarioId": id, "path": "config/settings.json", "text": settings.to_string() }),
    )
    .await;
    let outside = h.root.join("受注.csv");
    std::fs::write(&outside, "番号\n1\n").unwrap();
    let copied = h
        .ok(
            "write_project_file",
            json!({ "scenarioId": id, "path": "input/受注.csv", "copyFrom": outside }),
        )
        .await;
    assert_eq!(copied["path"], "input/受注.csv");
    let (is_error, both) = h
        .call(
            "write_project_file",
            json!({ "scenarioId": id, "path": "input/x.csv", "text": "a", "copyFrom": outside }),
        )
        .await;
    assert!(is_error, "{both}");
    let (is_error, outside_folder) = h
        .call(
            "write_project_file",
            json!({ "scenarioId": id, "path": "../x.csv", "text": "a" }),
        )
        .await;
    assert!(is_error);
    assert_eq!(outside_folder["code"], "INVALID_PROJECT_PATH");

    let listed = h
        .ok("list_project_files", json!({ "scenarioId": id }))
        .await;
    let paths: Vec<&str> = listed["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["config/settings.json", "input/受注.csv"]);
    assert_eq!(listed["folders"][0], "input");

    let read = h
        .ok(
            "read_project_file",
            json!({ "scenarioId": id, "path": "input/受注.csv" }),
        )
        .await;
    assert_eq!(read["text"], "番号\n1\n");

    // The run resolves the relative path from the folder; test_step too
    // when told which scenario.
    h.ok(
        "update_scenario",
        json!({
            "scenarioId": id,
            "expectedRevision": 1,
            "ops": [{ "op": "addStep", "step": { "type": "variable.set", "params": { "name": "day", "value": 25 } } }]
        }),
    )
    .await;
    let run = h
        .ok("run_scenario", json!({ "scenarioId": id, "waitMs": 5000 }))
        .await;
    assert_eq!(run["report"]["status"], "succeeded", "{run}");
    let logs: Vec<_> = std::fs::read_dir(h.root.join("scenarios").join(&id).join("logs"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(logs.len(), 1, "{logs:?}");
    assert!(logs[0].ends_with("_succeeded.log"));

    h.ok(
        "delete_project_file",
        json!({ "scenarioId": id, "path": "input/受注.csv" }),
    )
    .await;
    let listed = h
        .ok("list_project_files", json!({ "scenarioId": id }))
        .await;
    assert_eq!(listed["files"].as_array().unwrap().len(), 2, "{listed}");
}
