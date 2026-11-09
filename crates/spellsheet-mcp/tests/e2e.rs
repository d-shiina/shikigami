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
use spellsheet_core::{
    Actor, ActorKind, FileStore, FlowId, FlowService, NewReview, ReviewVerdict, StepNote,
};
use spellsheet_mcp::{ServerOptions, SpellSheetMcp, ToolClass};
use spellsheet_runtime::Runtime;

struct Harness {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    client: RunningService<RoleClient, ClientConfig>,
}

async fn start(options: ServerOptions) -> Harness {
    start_with(Runtime::new(), options).await
}

async fn start_with(runtime: Runtime, options: ServerOptions) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let service = Arc::new(FlowService::new(
        FileStore::open(&root).unwrap(),
        runtime.registry().clone(),
    ));
    let server = SpellSheetMcp::new(service, runtime, options);
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
    fn other_process(&self) -> FlowService {
        FlowService::new(
            FileStore::open(&self.root).unwrap(),
            Runtime::new().registry().clone(),
        )
    }
}

#[tokio::test]
async fn ai_builds_validates_and_runs_a_flow() {
    let h = start(ServerOptions::default()).await;

    let created = h
        .ok(
            "create_flow",
            json!({
                "name": "合計を出す",
                "variables": [
                    { "name": "items", "type": "array", "direction": "input", "default": [1, 2, 3] },
                    { "name": "sum", "type": "number", "direction": "output", "default": 0 }
                ]
            }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();
    assert_eq!(created["flow"]["revision"], 1);

    let added = h
        .ok(
            "add_step",
            json!({
                "flowId": id,
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
    assert_eq!(added["flow"]["revision"], 2);
    let loop_id = added["flow"]["steps"][0]["id"].as_str().unwrap().to_owned();

    let report = h.ok("validate_flow", json!({ "flowId": id })).await;
    assert_eq!(report["valid"], true, "{report}");

    let run = h
        .ok(
            "run_flow",
            json!({ "flowId": id, "inputs": { "items": [10, 20] }, "waitMs": 10000 }),
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
    let set_id = added["flow"]["steps"][0]["blocks"]["body"][0]["id"]
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

    let runs = h.ok("list_runs", json!({ "flowId": id })).await;
    assert_eq!(runs["runs"][0]["runId"], run_id.as_str());

    // The change is visible to another process and attributed to the client.
    let other = h.other_process();
    let sid = FlowId::new(id.as_str());
    assert_eq!(other.get(&sid).unwrap().steps[0].id.as_str(), loop_id);
    let history = other.history(&sid, 10).unwrap();
    assert_eq!(history[0].actor.kind, ActorKind::Mcp);
    assert_eq!(history[0].actor.name.as_deref(), Some("test-client"));

    // Undo through MCP is the same shared stack Studio uses.
    let undone = h.ok("undo", json!({ "flowId": id })).await;
    assert_eq!(undone["flow"]["revision"], 3);
    assert_eq!(
        undone["flow"]
            .get("steps")
            .map_or(0, |s| s.as_array().unwrap().len()),
        0
    );
    let redone = h.ok("redo", json!({ "flowId": id })).await;
    assert_eq!(redone["flow"]["steps"][0]["id"], loop_id.as_str());

    // Every call is audited.
    let audit = std::fs::read_to_string(h.root.join("audit/mcp.jsonl")).unwrap();
    let lines: Vec<Value> = audit
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(
        lines
            .iter()
            .any(|l| l["tool"] == "run_flow" && l["ok"] == true)
    );
    assert!(lines.iter().all(|l| l["client"] == "test-client"));

    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn stale_revision_is_reported_as_a_tool_error() {
    let h = start(ServerOptions::default()).await;
    let created = h.ok("create_flow", json!({ "name": "競合" })).await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();

    // A human edits in Studio meanwhile.
    let other = h.other_process();
    other
        .edit(
            &FlowId::new(id.as_str()),
            Some(1),
            vec![
                serde_json::from_value(json!({
                    "op": "addStep",
                    "step": { "type": "log.message", "params": { "message": "人間" } }
                }))
                .unwrap(),
            ],
            spellsheet_core::Actor::new(ActorKind::Studio),
        )
        .unwrap();

    let (is_error, value) = h
        .call(
            "add_step",
            json!({
                "flowId": id,
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
        json!({ "flowId": id, "step": { "type": "log.message", "params": {} } }),
    )
    .await;
    let (is_error, value) = h.call("run_flow", json!({ "flowId": id })).await;
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
            "create_flow",
            json!({ "name": "待つ", "steps": [ { "type": "flow.delay", "params": { "ms": 60000 } } ] }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();

    let run = h.ok("run_flow", json!({ "flowId": id })).await;
    assert_eq!(run["finished"], false);
    let run_id = run["runId"].as_str().unwrap().to_owned();

    let status = h.ok("get_run_status", json!({ "runId": run_id })).await;
    assert_eq!(status["active"], true);

    h.ok("stop_flow", json!({ "runId": run_id })).await;
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
    assert!(names.contains(&"get_flow".to_owned()));
    assert!(!names.contains(&"add_step".to_owned()));
    assert!(!names.contains(&"run_flow".to_owned()));
    for tool in &tools {
        let hints = tool.annotations.as_ref().unwrap();
        assert_eq!(hints.read_only_hint, Some(true), "{}", tool.name);
    }

    let result = h
        .client
        .call_tool(
            CallToolRequestParams::new("create_flow")
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
    assert_eq!(tools.len(), 42);
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
            "create_flow",
            json!({ "name": "記録不可", "steps": [ { "type": "log.message", "params": { "message": "x" } } ] }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();
    // A file where the runs directory should be makes recording fail.
    std::fs::write(h.root.join("runs"), b"not a directory").unwrap();

    let (is_error, value) = h.call("run_flow", json!({ "flowId": id })).await;
    assert!(is_error);
    assert_eq!(value["code"], "IO_ERROR");
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn test_step_takes_the_values_of_the_variables_it_reads() {
    let h = start(ServerOptions::default()).await;
    // A step from inside a forEach, tried as it is written in the flow.
    let step = json!({
        "type": "variable.set",
        "params": { "name": "x", "expression": "num(row.金額) * rate" },
    });
    let out = h
        .ok(
            "test_step",
            json!({ "step": step, "variables": { "row": { "金額": "1,200", "_row": 2 }, "rate": 2 } }),
        )
        .await;
    assert_eq!(out["status"], "succeeded", "{out}");
    assert_eq!(out["output"], 2400);
    // Templates in params too.
    let out = h
        .ok(
            "test_step",
            json!({
                "step": { "type": "variable.set", "params": { "name": "x", "value": "{{ row.顧客名 }}様" } },
                "variables": { "row": { "顧客名": "山田商事" } },
            }),
        )
        .await;
    assert_eq!(out["output"], "山田商事様");
    // Without the values the step cannot run, and says what is missing.
    let out = h.ok("test_step", json!({ "step": step })).await;
    assert_eq!(out["status"], "failed", "{out}");
    let text = out["error"].to_string();
    assert!(text.contains("row"), "{text}");
    assert!(out["hint"].as_str().unwrap().contains("`row`"), "{out}");
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn test_step_runs_one_step_without_touching_flows() {
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
    // A guessed name gets the real types for that purpose.
    let (is_error, e) = h
        .call("get_step_schema", json!({ "type": "control.pause" }))
        .await;
    assert!(is_error);
    assert_eq!(e["code"], "UNKNOWN_STEP_TYPE");
    assert_eq!(e["details"]["suggestions"][0], "flow.delay");
    assert!(
        e["details"]["hint"]
            .as_str()
            .unwrap_or_default()
            .contains("list_step_types")
    );
    // Without a browser adapter, inspect_page says so.
    let (is_error, e) = h.call("inspect_page", json!({ "url": "http://x/" })).await;
    assert!(is_error);
    assert_eq!(e["code"], "ADAPTER_UNAVAILABLE");
    let (is_error, e) = h.call("inspect_ui", json!({})).await;
    assert!(is_error);
    assert_eq!(e["code"], "ADAPTER_UNAVAILABLE");
    let flows = h.ok("list_flows", json!({})).await;
    assert_eq!(flows["flows"].as_array().map(Vec::len), Some(0));
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn versions_diff_restore_and_bundle_round_trip() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_flow",
            json!({
                "name": "版テスト",
                "steps": [{ "id": "stp_a", "type": "log.message", "params": { "message": "a" } }]
            }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();
    let v = h
        .ok(
            "create_version",
            json!({ "flowId": id, "name": "v1", "note": "最初の版", "expectedRevision": 1 }),
        )
        .await;
    assert_eq!(v["version"]["number"], 1);

    h.ok(
        "update_step",
        json!({ "flowId": id, "stepId": "stp_a", "patch": { "params": { "message": "b" } } }),
    )
    .await;
    // Defaults: latest version vs. current content.
    let diff = h.ok("diff_versions", json!({ "flowId": id })).await;
    assert_eq!(diff["from"]["version"], 1);
    assert_eq!(diff["steps"][0]["kind"], "changed");
    assert_eq!(diff["steps"][0]["fields"][0]["field"], "params.message");

    let restored = h
        .ok("restore_version", json!({ "flowId": id, "number": 1 }))
        .await;
    assert_eq!(restored["flow"]["steps"][0]["params"]["message"], "a");
    assert_eq!(restored["canUndo"], true);

    let listed = h.ok("list_versions", json!({ "flowId": id })).await;
    assert_eq!(listed["versions"][0]["note"], "最初の版");
    let got = h
        .ok("get_version", json!({ "flowId": id, "number": 1 }))
        .await;
    assert_eq!(got["flow"]["id"], id.as_str());

    let exported = h.ok("export_flow", json!({ "flowId": id })).await;
    let bundle = exported["bundle"].clone();
    assert_eq!(bundle["format"], "spellsheet.flowBundle");
    let (is_error, conflict) = h
        .call("import_flow", json!({ "bundle": bundle.clone() }))
        .await;
    assert!(is_error);
    assert_eq!(conflict["code"], "IMPORT_CONFLICT");
    let copy = h
        .ok(
            "import_flow",
            json!({ "bundle": bundle, "onConflict": "copy" }),
        )
        .await;
    assert_eq!(copy["mode"], "copied");
    assert_eq!(copy["versionsAdded"], 1);
    assert_ne!(copy["flow"]["id"], id.as_str());
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn secrets_are_named_but_never_revealed() {
    let h = start(ServerOptions::default()).await;
    // The user registers a login in Studio (same workspace, other process).
    spellsheet_secrets::Vault::open(&h.root)
        .set(spellsheet_secrets::SecretInput {
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
    assert!(listed.get("sameSite").is_none());

    // A second account of the same site: the AI is told not to pick one.
    spellsheet_secrets::Vault::open(&h.root)
        .set(spellsheet_secrets::SecretInput {
            name: "受注システム（申請）".into(),
            username: Some("suzuki".into()),
            password: Some("hunter3".into()),
            sites: Some(vec!["https://orders.example.com".into()]),
            ..Default::default()
        })
        .unwrap();
    let listed = h.ok("list_secrets", json!({})).await;
    assert_eq!(
        listed["sameSite"],
        json!([{ "site": "https://orders.example.com", "secrets": ["受注システム", "受注システム（申請）"] }])
    );
    assert!(listed["sameSiteHint"].as_str().unwrap().contains("choices"));

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
            "create_flow",
            json!({
                "name": "ログイン",
                "variables": [{ "name": "pw", "type": "string", "direction": "input", "secret": true }]
            }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();
    let (is_error, result) = h
        .call(
            "run_flow",
            json!({ "flowId": id, "inputs": { "pw": "hunter2" } }),
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
            "create_flow",
            json!({ "name": "レビュー", "summary": "  空のフローを作成  " }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();

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
            json!({ "flowId": id, "step": { "type": "log.message", "params": { "message": "x" } }, "observations": ["obs_missing"] }),
        )
        .await;
    assert!(is_error);
    assert_eq!(e["code"], "OBSERVATION_NOT_FOUND");

    let added = h
        .ok(
            "add_step",
            json!({
                "flowId": id,
                "expectedRevision": 1,
                "step": { "type": "log.message", "params": { "message": "hi" } },
                "summary": "あいさつを記録する手順を追加",
                "checks": [" 英語のあいさつでよい？ ", "", "英語のあいさつでよい？"],
                "observations": [obs],
            }),
        )
        .await;
    let step_id = added["flow"]["steps"][0]["id"].as_str().unwrap().to_owned();
    let run = h
        .ok("run_flow", json!({ "flowId": id, "waitMs": 10000 }))
        .await;
    assert_eq!(run["report"]["status"], "succeeded");

    let history = h.ok("get_history", json!({ "flowId": id })).await;
    assert_eq!(history["entries"][0]["summary"], "空のフローを作成");
    assert_eq!(
        history["entries"][1]["summary"],
        "あいさつを記録する手順を追加"
    );
    assert_eq!(history["entries"][1]["stepIds"], json!([step_id]));
    assert_eq!(
        history["entries"][1]["checks"],
        json!(["英語のあいさつでよい？"])
    );
    assert!(
        history["entries"][0]
            .get("checks")
            .is_none_or(|c| c.as_array().is_some_and(Vec::is_empty))
    );

    // The human sends revision 2 back from Studio (another process).
    let studio = h.other_process();
    let sid = FlowId::new(id.as_str());
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

    let got = h.ok("get_flow", json!({ "flowId": id })).await;
    assert_eq!(got["feedback"]["verdict"], "rejected");
    assert_eq!(
        got["feedback"]["reason"],
        "メッセージは日本語にしてください"
    );
    assert_eq!(got["feedback"]["steps"][0]["stepId"], step_id);

    let review = h.ok("get_review", json!({ "flowId": id })).await;
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
        .get_observation(&spellsheet_core::ObservationId::new(obs.as_str()))
        .unwrap();
    assert_eq!(content.observation.status.as_deref(), Some("succeeded"));
    assert_eq!(content.observation.linked.len(), 1);

    // The AI fixes it; approval closes the feedback and starts a new round.
    h.ok(
        "update_step",
        json!({ "flowId": id, "stepId": step_id, "patch": { "params": { "message": "こんにちは" } }, "summary": "差し戻しに対応：日本語に変更" }),
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
    let got = h.ok("get_flow", json!({ "flowId": id })).await;
    assert!(got.get("feedback").is_none());
    let review = h.ok("get_review", json!({ "flowId": id })).await;
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
    let studio = spellsheet_secrets::Vault::open(&h.root);
    let pending = studio.requests().unwrap();
    assert_eq!(pending[0].request.name, "Google");
    assert_eq!(pending[0].request.reason, "Google にログインするため");
    let root = h.root.clone();
    let register = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        spellsheet_secrets::Vault::open(&root)
            .set(spellsheet_secrets::SecretInput {
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
            spellsheet_secrets::Vault::open(&root)
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
async fn publishing_and_the_policy_keep_people_in_charge() {
    use spellsheet_core::{ApprovalId, ApprovalStore, Policy, PublishInput};

    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_flow",
            json!({ "name": "公開テスト", "steps": [ { "type": "log.message", "params": { "message": "hi" } } ] }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();
    let studio = h.other_process();
    let approvals = ApprovalStore::new(studio.store().local_root());
    let person = || Actor::new(ActorKind::Studio);

    // Nothing runs unattended until a person publishes.
    let (is_error, e) = h
        .call("run_flow", json!({ "flowId": id, "published": true }))
        .await;
    assert!(is_error);
    assert_eq!(e["code"], "NOT_PUBLISHED");
    studio
        .publish(&FlowId::new(id.as_str()), PublishInput::default(), person())
        .unwrap();
    let got = h.ok("get_flow", json!({ "flowId": id })).await;
    assert_eq!(got["published"]["version"], 1);
    assert_eq!(got["published"]["matchesCurrent"], true);
    let out = h
        .ok(
            "run_flow",
            json!({ "flowId": id, "published": true, "waitMs": 10000 }),
        )
        .await;
    assert_eq!(out["report"]["version"], 1);

    // policy.json: a site list and stricter AI rules.
    let policy_path = Policy::path(&h.root);
    std::fs::write(
        &policy_path,
        r#"{ "sites": ["https://ok.example"], "ai": { "runFlow": { "safe": "deny" }, "testStep": { "safe": "ask" } } }"#,
    )
    .unwrap();
    let policy = h.ok("get_policy", json!({})).await;
    assert_eq!(policy["policy"]["sites"][0], "https://ok.example");
    let (_, e) = h.call("run_flow", json!({ "flowId": id })).await;
    assert_eq!(e["code"], "POLICY_DENIED");
    let (_, e) = h
        .call("inspect_page", json!({ "url": "https://evil.example/" }))
        .await;
    assert_eq!(e["code"], "SITE_NOT_ALLOWED");

    // "ask": the person approves exactly one action in Studio.
    let step = json!({ "type": "variable.set", "params": { "name": "x", "expression": "1 + 2" } });
    let (_, e) = h
        .call(
            "test_step",
            json!({ "step": step, "approvalReason": "計算を確かめたい" }),
        )
        .await;
    assert_eq!(e["code"], "APPROVAL_REQUIRED");
    let approval = e["details"]["approvalId"].as_str().unwrap().to_owned();
    let pending = approvals.pending().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].reason.as_deref(), Some("計算を確かめたい"));
    assert!(
        approvals
            .decide(
                &ApprovalId::new(approval.as_str()),
                true,
                Actor::new(ActorKind::Mcp)
            )
            .is_err(),
        "an AI cannot approve its own request"
    );
    approvals
        .decide(&ApprovalId::new(approval.as_str()), true, person())
        .unwrap();
    let other = json!({ "type": "variable.set", "params": { "name": "x", "expression": "9" } });
    let (_, e) = h
        .call(
            "test_step",
            json!({ "step": other, "approvalId": approval }),
        )
        .await;
    assert_eq!(e["code"], "APPROVAL_MISMATCH");
    // Another flow's folder is another place for relative paths.
    let (_, e) = h
        .call(
            "test_step",
            json!({ "step": step, "flowId": id, "approvalId": approval }),
        )
        .await;
    assert_eq!(e["code"], "APPROVAL_MISMATCH");
    let out = h
        .ok("test_step", json!({ "step": step, "approvalId": approval }))
        .await;
    assert_eq!(out["output"], 3);
    let (_, e) = h
        .call("test_step", json!({ "step": step, "approvalId": approval }))
        .await;
    assert_eq!(e["code"], "APPROVAL_USED");

    // An approval covers the called flows as they were: editing the
    // callee afterwards makes it not match.
    let call = json!({ "type": "flow.call", "params": { "flow": id } });
    let (_, e) = h.call("test_step", json!({ "step": call })).await;
    assert_eq!(e["code"], "APPROVAL_REQUIRED", "{e}");
    let approval = e["details"]["approvalId"].as_str().unwrap().to_owned();
    approvals
        .decide(&ApprovalId::new(approval.as_str()), true, person())
        .unwrap();
    studio
        .edit(
            &FlowId::new(id.as_str()),
            None,
            vec![spellsheet_core::EditOp::AddStep {
                step: spellsheet_core::Step::new("log.message").with_param("message", "後から"),
                position: spellsheet_core::Position::default(),
            }],
            Actor::new(ActorKind::Mcp),
        )
        .unwrap();
    let (_, e) = h
        .call("test_step", json!({ "step": call, "approvalId": approval }))
        .await;
    assert_eq!(e["code"], "APPROVAL_MISMATCH");

    // Deleting asks by default; a refusal is final.
    std::fs::remove_file(&policy_path).unwrap();
    // A dangerous step inside a group counts, not just the group.
    let (_, e) = h
        .call(
            "test_step",
            json!({ "step": {
                "type": "control.group",
                "params": {},
                "blocks": { "body": [ { "type": "file.delete", "params": { "path": "C:\\x.txt" } } ] }
            } }),
        )
        .await;
    assert_eq!(e["code"], "APPROVAL_REQUIRED");
    assert_eq!(e["details"]["request"]["risk"], "dangerous");
    let (_, e) = h
        .call(
            "test_step",
            json!({ "step": { "type": "no.such", "params": {} } }),
        )
        .await;
    assert_eq!(e["code"], "UNKNOWN_STEP_TYPE");
    let rev = got["flow"]["revision"].as_u64().unwrap();
    let (_, e) = h
        .call(
            "delete_flow",
            json!({ "flowId": id, "expectedRevision": rev }),
        )
        .await;
    assert_eq!(e["code"], "APPROVAL_REQUIRED");
    let approval = e["details"]["approvalId"].as_str().unwrap().to_owned();
    approvals
        .decide(&ApprovalId::new(approval.as_str()), false, person())
        .unwrap();
    let (_, e) = h
        .call(
            "delete_flow",
            json!({ "flowId": id, "expectedRevision": rev, "approvalId": approval }),
        )
        .await;
    assert_eq!(e["code"], "APPROVAL_DENIED");
    assert!(studio.get(&FlowId::new(id.as_str())).is_ok());
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn ai_puts_files_in_the_flow_folder_and_runs_with_relative_paths() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_flow",
            json!({
                "name": "設定を読む",
                "variables": [{ "name": "day", "type": "number", "direction": "output", "default": 0 }]
            }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();

    // A settings file the AI writes, and a file copied in from the PC.
    let settings = json!({
        "format": "spellsheet.config",
        "items": [{ "name": "締め日", "type": "number", "value": 25, "description": "毎月の締め日" }]
    });
    h.ok(
        "write_project_file",
        json!({ "flowId": id, "path": "config/settings.json", "text": settings.to_string() }),
    )
    .await;
    let outside = h.root.join("受注.csv");
    std::fs::write(&outside, "番号\n1\n").unwrap();
    let copied = h
        .ok(
            "write_project_file",
            json!({ "flowId": id, "path": "input/受注.csv", "copyFrom": outside }),
        )
        .await;
    assert_eq!(copied["path"], "input/受注.csv");
    let (is_error, both) = h
        .call(
            "write_project_file",
            json!({ "flowId": id, "path": "input/x.csv", "text": "a", "copyFrom": outside }),
        )
        .await;
    assert!(is_error, "{both}");
    let (is_error, outside_folder) = h
        .call(
            "write_project_file",
            json!({ "flowId": id, "path": "../x.csv", "text": "a" }),
        )
        .await;
    assert!(is_error);
    assert_eq!(outside_folder["code"], "INVALID_PROJECT_PATH");

    let listed = h.ok("list_project_files", json!({ "flowId": id })).await;
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
            json!({ "flowId": id, "path": "input/受注.csv" }),
        )
        .await;
    assert_eq!(read["text"], "番号\n1\n");

    // The run resolves the relative path from the folder; test_step too
    // when told which flow.
    h.ok(
        "update_flow",
        json!({
            "flowId": id,
            "expectedRevision": 1,
            "ops": [{ "op": "addStep", "step": { "type": "variable.set", "params": { "name": "day", "value": 25 } } }]
        }),
    )
    .await;
    let run = h
        .ok("run_flow", json!({ "flowId": id, "waitMs": 5000 }))
        .await;
    assert_eq!(run["report"]["status"], "succeeded", "{run}");
    let logs: Vec<_> = std::fs::read_dir(h.root.join("flows").join(&id).join("logs"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(logs.len(), 1, "{logs:?}");
    assert!(logs[0].ends_with("_succeeded.log"));

    h.ok(
        "delete_project_file",
        json!({ "flowId": id, "path": "input/受注.csv" }),
    )
    .await;
    let listed = h.ok("list_project_files", json!({ "flowId": id })).await;
    assert_eq!(listed["files"].as_array().unwrap().len(), 2, "{listed}");
}

/// Clients set up before flows were renamed from scenarios keep working:
/// the old tool and argument names are still accepted (but not listed).
#[tokio::test]
async fn scenario_tool_names_from_0_1_still_work() {
    let h = start(ServerOptions::default()).await;
    let created = h.ok("create_scenario", json!({ "name": "古い名前" })).await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();
    let got = h.ok("get_scenario", json!({ "scenarioId": id })).await;
    assert_eq!(got["flow"]["name"], "古い名前");
    let listed = h.ok("list_scenarios", json!({})).await;
    assert_eq!(listed["flows"][0]["id"], id.as_str());

    let tools = h.client.list_all_tools().await.unwrap();
    assert!(tools.iter().any(|t| t.name == "create_flow"));
    assert!(!tools.iter().any(|t| t.name.contains("scenario")));
}

#[tokio::test]
async fn ai_writes_test_cases_and_runs_them() {
    let h = start(ServerOptions::default()).await;
    let created = h
        .ok(
            "create_flow",
            json!({
                "name": "倍にする",
                "variables": [
                    { "name": "n", "type": "number", "direction": "input", "default": 1 },
                    { "name": "doubled", "type": "number", "direction": "output", "default": 0 }
                ],
                "steps": [{ "type": "variable.set", "params": { "name": "doubled", "expression": "n * 2" } }]
            }),
        )
        .await;
    let id = created["flow"]["id"].as_str().unwrap().to_owned();

    let saved = h
        .ok(
            "save_test_case",
            json!({ "flowId": id, "name": "21", "case": { "inputs": { "n": 21 }, "expect": { "outputs": { "doubled": 42 } } } }),
        )
        .await;
    assert_eq!(saved["path"], "tests/21.json");
    h.ok(
        "save_test_case",
        json!({ "flowId": id, "name": "違う", "case": { "expect": { "outputs": { "doubled": 3 } } } }),
    )
    .await;
    let (is_error, again) = h
        .call(
            "save_test_case",
            json!({ "flowId": id, "name": "21", "case": { "inputs": { "n": 1 } } }),
        )
        .await;
    assert!(is_error);
    assert_eq!(again["code"], "TEST_CASE_EXISTS");
    let (is_error, unknown) = h
        .call(
            "save_test_case",
            json!({ "flowId": id, "name": "x", "case": { "inputs": { "m": 1 } } }),
        )
        .await;
    assert!(is_error);
    assert_eq!(unknown["code"], "TEST_CASE_UNKNOWN_INPUT");

    let ran = h.ok("run_tests", json!({ "flowId": id })).await;
    assert_eq!(ran["passed"], 1, "{ran}");
    assert_eq!(ran["failed"], 1);
    let wrong = &ran["cases"][1];
    assert_eq!(wrong["name"], "違う");
    assert_eq!(wrong["mismatches"][0]["at"], "outputs.doubled");
    assert_eq!(wrong["mismatches"][0]["actual"], 2);

    // The review shows the cases as the AI's promises, with how they went.
    let review = h.ok("get_review", json!({ "flowId": id })).await;
    let kinds: Vec<&str> = review["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["testCase", "testCase", "testCases"], "{review}");
    assert_eq!(review["evidence"][0]["name"], "21");
    let results = &review["evidence"][2]["results"];
    assert_eq!(results[1]["passed"], false);
    assert_eq!(results[1]["mismatches"][0]["at"], "outputs.doubled");

    let one = h
        .ok("run_tests", json!({ "flowId": id, "cases": ["21"] }))
        .await;
    assert_eq!(one["cases"].as_array().unwrap().len(), 1);
    // One approval covers each case once.
    let (is_error, twice) = h
        .call("run_tests", json!({ "flowId": id, "cases": ["21", "21"] }))
        .await;
    assert!(is_error);
    assert_eq!(twice["code"], "TEST_CASE_REPEATED");

    // A case file someone broke by hand is not replaced without overwrite.
    h.ok(
        "write_project_file",
        json!({ "flowId": id, "path": "tests/壊れた.json", "text": "{ not json" }),
    )
    .await;
    let (is_error, kept) = h
        .call(
            "save_test_case",
            json!({ "flowId": id, "name": "壊れた", "case": {} }),
        )
        .await;
    assert!(is_error);
    assert_eq!(kept["code"], "TEST_CASE_EXISTS");
}

#[tokio::test]
async fn only_the_writer_chat_gets_ask_user_to_choose() {
    let outside = start(ServerOptions::default()).await;
    let names: Vec<_> = outside
        .client
        .list_all_tools()
        .await
        .unwrap()
        .iter()
        .map(|t| t.name.to_string())
        .collect();
    assert!(!names.contains(&"ask_user_to_choose".to_owned()));
    outside.client.cancel().await.unwrap();

    let h = start(ServerOptions {
        writer_chat: true,
        ..ServerOptions::default()
    })
    .await;
    let shown = h
        .ok(
            "ask_user_to_choose",
            json!({
                "question": "在庫切れの注文はどうしますか？",
                "options": [
                    { "label": "飛ばして一覧に残す", "description": "出荷できた分だけ進めます。" },
                    { "label": "そこで止めて人に聞く" }
                ],
                "recommended": 0
            }),
        )
        .await;
    assert_eq!(shown["status"], "shown");
    // The card is in Writer's AI chat: the hint names that place, so the AI
    // does not send the person to look for it in a web browser.
    let hint = shown["hint"].as_str().unwrap();
    assert!(
        hint.contains("AI チャット") && hint.contains("not a web browser"),
        "{hint}"
    );

    for args in [
        json!({ "question": "どちら？", "options": [{ "label": "A" }] }),
        json!({ "question": "どちら？", "options": [{ "label": "A" }, { "label": "A" }] }),
        json!({ "question": "", "options": [{ "label": "A" }, { "label": "B" }] }),
        json!({ "question": "どちら？", "options": [{ "label": "A" }, { "label": "B" }], "recommended": 2 }),
    ] {
        let (is_error, value) = h.call("ask_user_to_choose", args).await;
        assert!(is_error);
        assert_eq!(value["code"], "INVALID_PARAMS");
    }
    h.client.cancel().await.unwrap();
}

/// A browser whose browser.waitForHuman waits until Writer's 「終わりました」
/// reaches it (inspect `endHuman`), or until the step is stopped.
mod by_hand {
    use std::sync::atomic::{AtomicBool, Ordering};

    use spellsheet_core::{RiskLevel, StepCategory, StepTypeDef};
    use spellsheet_runtime::{
        ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
    };
    use tokio::sync::Notify;

    use super::*;

    #[derive(Default)]
    pub struct Shared {
        pub finished: Notify,
        /// The step saw the stop itself (it is dropped instead, as a real one).
        pub stopped: AtomicBool,
        pub refused_once: AtomicBool,
    }

    pub struct FakeBrowser(pub Arc<Shared>);
    struct Wait(Arc<Shared>);

    impl ActionHandler for Wait {
        fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
            Box::pin(async move {
                input.request_human("GitHub にログインしてください");
                tokio::select! {
                    () = self.0.finished.notified() => Ok(Value::Null),
                    () = input.cancel.cancelled() => {
                        self.0.stopped.store(true, Ordering::SeqCst);
                        Err(StepError::permanent("CANCELLED", "cancelled"))
                    }
                }
            })
        }
    }

    impl Adapter for FakeBrowser {
        fn name(&self) -> &str {
            "browser"
        }

        fn install(&self, builder: RuntimeBuilder) -> RuntimeBuilder {
            let def = StepTypeDef {
                targets: Vec::new(),
                step_type: "browser.waitForHuman".into(),
                category: StepCategory::Browser,
                label: "手動操作の待機".into(),
                description: String::new(),
                params_schema: json!({ "type": "object" }),
                blocks: vec![],
                has_output: false,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Safe,
                examples: vec![],
                resources: vec![],
                secret_params: vec![],
                default_timeout_ms: Some(300_000),
                deprecated: None,
                plugin: None,
                path_params: Vec::new(),
            };
            builder.register(def, Wait(self.0.clone()))
        }

        fn inspect<'a>(
            &'a self,
            _session: &'a str,
            params: Value,
        ) -> BoxFuture<'a, Result<Value, StepError>> {
            Box::pin(async move {
                if params["action"] == "endHuman" && params["how"] == "person" {
                    // The first time the page is not waiting yet (still coming
                    // to the front): the server must ask again, not drop it.
                    if !self.0.refused_once.swap(true, Ordering::SeqCst) {
                        return Ok(json!({ "ended": false }));
                    }
                    self.0.finished.notify_one();
                    return Ok(json!({ "ended": true }));
                }
                Ok(json!({ "title": "ダッシュボード", "url": "https://github.com/" }))
            })
        }
    }

    pub async fn harness() -> (Harness, Arc<Shared>) {
        let shared = Arc::new(Shared::default());
        let browser: Arc<dyn Adapter> = Arc::new(FakeBrowser(shared.clone()));
        let runtime = Runtime::builder().adapter(browser.as_ref()).build();
        let h = start_with(
            runtime,
            ServerOptions {
                adapters: vec![browser],
                ..ServerOptions::default()
            },
        )
        .await;
        (h, shared)
    }

    /// What Writer does: waits for the request to show, then answers it.
    pub async fn answer(root: &std::path::Path, finish: bool) {
        let store = FileStore::open(root).unwrap();
        let picks = spellsheet_core::PickRequestStore::new(store.local_root());
        for _ in 0..200 {
            if let Some(r) = picks.pending().unwrap().first() {
                assert_eq!(r.kind, spellsheet_core::PickKind::Human);
                assert_eq!(r.message, "GitHub にログインしてください");
                if finish {
                    picks.finish(&r.id).unwrap();
                } else {
                    picks.cancel(&r.id).unwrap();
                }
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the wait by hand never showed in Writer");
    }

    pub fn gone(root: &std::path::Path) -> bool {
        let store = FileStore::open(root).unwrap();
        spellsheet_core::PickRequestStore::new(store.local_root())
            .pending()
            .unwrap()
            .is_empty()
    }
}

#[tokio::test]
async fn a_wait_by_hand_ends_when_the_person_says_so_in_writer() {
    let (h, shared) = by_hand::harness().await;
    let step = json!({ "type": "browser.waitForHuman", "params": { "until": { "role": "heading", "name": "Dashboard" } } });
    let (out, ()) = tokio::join!(
        h.ok("test_step", json!({ "step": step })),
        by_hand::answer(&h.root, true)
    );
    assert_eq!(out["status"], "succeeded", "{out}");
    assert!(
        out["hint"].as_str().unwrap().contains("終わりました"),
        "{out}"
    );
    // The AI sees the page the person left, to pick a better `until`.
    assert_eq!(out["state"]["title"], "ダッシュボード");
    assert!(!shared.stopped.load(std::sync::atomic::Ordering::SeqCst));
    assert!(
        shared
            .refused_once
            .load(std::sync::atomic::Ordering::SeqCst)
    );
    assert!(by_hand::gone(&h.root));
    h.client.cancel().await.unwrap();
}

#[tokio::test]
async fn a_wait_by_hand_stopped_in_writer_tells_the_ai() {
    let (h, shared) = by_hand::harness().await;
    let step = json!({ "type": "browser.waitForHuman", "params": { "until": { "role": "heading", "name": "Dashboard" } } });
    let (out, ()) = tokio::join!(
        h.call("test_step", json!({ "step": step })),
        by_hand::answer(&h.root, false)
    );
    let (_, out) = out;
    assert_eq!(out["status"], "cancelled", "{out}");
    assert!(
        out["hint"].as_str().unwrap().contains("待つのをやめる"),
        "{out}"
    );
    // The run drops the waiting step rather than letting it finish.
    assert!(!shared.stopped.load(std::sync::atomic::Ordering::SeqCst));
    assert!(by_hand::gone(&h.root));
    h.client.cancel().await.unwrap();
}
