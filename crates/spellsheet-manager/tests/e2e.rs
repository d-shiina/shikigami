//! An agent and the reference manager, end to end over HTTP on localhost.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, json};
use spellsheet_agent::Agent;
use spellsheet_core::{
    Actor, ActorKind, FileStore, FlowId, FlowService, NewFlow, Policy, PublishInput, Step,
    VarDirection, VarType, VariableDef,
};
use spellsheet_manager::{JobRecord, JobState, Manager, NewJob};
use spellsheet_runtime::{RunTrigger, Runtime};
use spellsheet_secrets::MemoryKeyStore;

struct Setup {
    _dirs: (tempfile::TempDir, tempfile::TempDir),
    manager: Arc<Manager>,
    agent: Arc<Agent>,
    url: String,
}

async fn setup(flows: &[&str]) -> Setup {
    let server_dir = tempfile::tempdir().unwrap();
    let manager = Manager::open(server_dir.path()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(spellsheet_manager::serve_on(manager.clone(), listener));

    let ws = tempfile::tempdir().unwrap();
    let runtime = Runtime::new();
    let svc = Arc::new(FlowService::new(
        FileStore::open(ws.path()).unwrap(),
        runtime.registry().clone(),
    ));
    let agent = Agent::new(svc, runtime);
    agent.set_key_store(Arc::new(MemoryKeyStore::default()));
    let mut policy = Policy::default();
    policy.remote.enabled = true;
    policy.remote.manager = Some(url.clone());
    policy.remote.flows = flows.iter().map(|s| (*s).to_owned()).collect();
    policy.save(&Policy::path(ws.path())).unwrap();
    Setup {
        _dirs: (server_dir, ws),
        manager,
        agent,
        url,
    }
}

fn person() -> Actor {
    Actor::new(ActorKind::Studio)
}

/// Copies the input `file` to the output `got`, after waiting `ms`.
fn flow(agent: &Agent, ms: u64) -> FlowId {
    let mut file = VariableDef::new("file", VarType::String);
    file.direction = VarDirection::Input;
    file.default = Some(json!(""));
    let mut got = VariableDef::new("got", VarType::String);
    got.direction = VarDirection::Output;
    let svc = agent.service();
    let id = svc
        .create(
            NewFlow {
                name: "受注取り込み".into(),
                variables: vec![file, got],
                steps: vec![
                    Step::new("flow.delay").with_param("ms", ms).with_id("s0"),
                    Step::new("variable.set")
                        .with_param("name", "got")
                        .with_param("expression", "file")
                        .with_id("s1"),
                ],
                ..NewFlow::default()
            },
            person(),
        )
        .unwrap()
        .flow
        .id;
    svc.publish(&id, PublishInput::default(), person()).unwrap();
    id
}

async fn enroll(s: &Setup) {
    let code = s.manager.new_code().code;
    let root = s.agent.service().store().root().to_path_buf();
    spellsheet_agent::remote::enroll(
        s.agent.local_root(),
        &root,
        s.agent.key_store().as_ref(),
        &s.url,
        &code,
    )
    .await
    .unwrap();
}

async fn wait_until(s: &Setup, id: &str, done: impl Fn(&JobRecord) -> bool) -> JobRecord {
    for _ in 0..300 {
        if let Some(job) = s.manager.job(id)
            && done(&job)
        {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("job {id} never got there: {:?}", s.manager.job(id));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_free_agent_takes_a_job_and_reports_back() {
    let s = setup(&["*"]).await;
    let id = flow(&s.agent, 0);
    enroll(&s).await;
    assert_eq!(s.manager.workers().len(), 1);
    tokio::spawn(s.agent.clone().serve());

    let mut inputs = Map::new();
    inputs.insert("file".into(), json!("orders.xlsx"));
    let job = s.manager.add_job(NewJob {
        flow_id: id,
        inputs,
        requested_by: Some("dana@example.com".into()),
        ..NewJob::default()
    });
    let done = wait_until(&s, &job.id, |j| j.state == JobState::Succeeded).await;
    let report = done.report.unwrap();
    assert_eq!(report.outputs["got"], json!("orders.xlsx"));
    assert_eq!(report.origin.trigger, Some(RunTrigger::Remote));
    assert_eq!(report.origin.job_id.as_deref(), Some(job.id.as_str()));
    assert_eq!(
        report.origin.requested_by.as_deref(),
        Some("dana@example.com")
    );
    // The log arrived too, in order.
    assert!(!done.events.is_empty());
    assert!(done.events.windows(2).all(|w| w[0].seq + 1 == w[1].seq));
    s.agent.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_job_is_cancelled_from_the_server() {
    let s = setup(&["*"]).await;
    let id = flow(&s.agent, 60_000);
    enroll(&s).await;
    tokio::spawn(s.agent.clone().serve());
    let job = s.manager.add_job(NewJob {
        flow_id: id,
        ..NewJob::default()
    });
    wait_until(&s, &job.id, |j| j.state == JobState::Running).await;
    s.manager.cancel(&job.id);
    let done = wait_until(&s, &job.id, |j| j.state.clone() == JobState::Cancelled).await;
    assert!(done.report.is_some());
    s.agent.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn only_what_policy_allows_is_offered() {
    // policy.json lets the server start nothing but a flow that does not exist.
    let s = setup(&["scn_other"]).await;
    let id = flow(&s.agent, 0);
    enroll(&s).await;
    tokio::spawn(s.agent.clone().serve());
    let job = s.manager.add_job(NewJob {
        flow_id: id,
        ..NewJob::default()
    });
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(s.manager.job(&job.id).unwrap().state, JobState::Queued);
    s.agent.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_enrollment_code_works_once() {
    let s = setup(&["*"]).await;
    let code = s.manager.new_code().code;
    let root = s.agent.service().store().root().to_path_buf();
    let keys = s.agent.key_store();
    spellsheet_agent::remote::enroll(s.agent.local_root(), &root, keys.as_ref(), &s.url, &code)
        .await
        .unwrap();
    let again =
        spellsheet_agent::remote::enroll(s.agent.local_root(), &root, keys.as_ref(), &s.url, &code)
            .await;
    assert!(again.unwrap_err().0.contains("ENROLLMENT_CODE_INVALID"));
}
