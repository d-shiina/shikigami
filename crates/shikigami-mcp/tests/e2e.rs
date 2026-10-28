//! Drives the server through a real MCP client over an in-memory transport,
//! the same way Claude Code or Codex talk to it over stdio.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, ClientCapabilities, ClientConfig, Implementation, JsonObject,
};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Value, json};
use shikigami_core::{ActorKind, FileStore, ScenarioId, ScenarioService};
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
    assert_eq!(tools.len(), 29);
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
