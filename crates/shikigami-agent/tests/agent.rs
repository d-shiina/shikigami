#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::{ToSpan, Zoned};
use serde_json::{Map, json};
use shikigami_agent::ipc::{self, Request};
use shikigami_agent::{Agent, RunRequest, Schedule, Schedules, When};
use shikigami_core::{
    Actor, ActorKind, FileStore, NewScenario, PublishInput, ScenarioId, ScenarioService, Step,
    VarDirection, VarType, VariableDef,
};
use shikigami_runtime::{RunReport, RunStatus, RunTrigger, Runtime, record};

struct Harness {
    _dir: tempfile::TempDir,
    agent: Arc<Agent>,
    reports: Arc<Mutex<Vec<RunReport>>>,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new();
    let svc = Arc::new(ScenarioService::new(
        FileStore::open(dir.path()).unwrap(),
        runtime.registry().clone(),
    ));
    let agent = Agent::new(svc, runtime);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let sink = reports.clone();
    agent.on_finished(Arc::new(move |r: &RunReport| {
        sink.lock().unwrap().push(r.clone())
    }));
    Harness {
        _dir: dir,
        agent,
        reports,
    }
}

fn person() -> Actor {
    Actor::new(ActorKind::Studio)
}

/// A scenario with an input `file` that it copies to the output `got`.
fn scenario(h: &Harness, publish: bool) -> ScenarioId {
    let mut file = VariableDef::new("file", VarType::String);
    file.direction = VarDirection::Input;
    file.default = Some(json!(""));
    let mut got = VariableDef::new("got", VarType::String);
    got.direction = VarDirection::Output;
    let out = h
        .agent
        .service()
        .create(
            NewScenario {
                name: "受注取り込み".into(),
                variables: vec![file, got],
                steps: vec![
                    Step::new("variable.set")
                        .with_param("name", "got")
                        .with_param("expression", "file")
                        .with_id("s1"),
                ],
                ..NewScenario::default()
            },
            person(),
        )
        .unwrap();
    let id = out.scenario.id;
    if publish {
        h.agent
            .service()
            .publish(&id, PublishInput::default(), person())
            .unwrap();
    }
    id
}

async fn wait_for_reports(h: &Harness, n: usize) -> Vec<RunReport> {
    for _ in 0..200 {
        let got = h.reports.lock().unwrap().clone();
        if got.len() >= n {
            return got;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("expected {n} reports, got {:?}", h.reports.lock().unwrap());
}

fn save(h: &Harness, schedules: Vec<Schedule>) {
    Schedules {
        format_version: 1,
        schedules,
    }
    .save(&Schedules::path(h.agent.local_root()))
    .unwrap();
}

#[tokio::test]
async fn a_schedule_runs_the_published_version_when_due() {
    let h = harness();
    let id = scenario(&h, true);
    let now = Zoned::now();
    let at = now.checked_add(1.minute()).unwrap();
    save(
        &h,
        vec![Schedule {
            id: "sch_morning".into(),
            name: "毎朝".into(),
            scenario_id: id.clone(),
            enabled: true,
            when: When::Daily {
                at: at.strftime("%H:%M").to_string(),
                days: vec![],
            },
            inputs: Map::new(),
        }],
    );
    // Not yet due.
    h.agent.tick(&now, false);
    let status = h.agent.status();
    assert_eq!(status.schedules.len(), 1);
    assert!(status.schedules[0].next.is_some());
    assert!(h.agent.running().is_empty());
    // Due.
    h.agent.tick(&at.checked_add(1.second()).unwrap(), false);
    let reports = wait_for_reports(&h, 1).await;
    let report = &reports[0];
    assert_eq!(report.status, RunStatus::Succeeded);
    assert_eq!(report.version, Some(1));
    assert_eq!(report.origin.trigger, Some(RunTrigger::Schedule));
    assert_eq!(report.origin.requested_by.as_deref(), Some("毎朝"));
    assert_eq!(report.origin.job_id.as_deref(), Some("sch_morning"));
    // Recorded like any run.
    let recorded = record::read_report(h.agent.local_root(), &report.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(recorded.status, RunStatus::Succeeded);
    // Fired once: the next time is tomorrow.
    h.agent.tick(&at.checked_add(2.seconds()).unwrap(), false);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.reports.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_unpublished_scenario_is_reported_as_failed() {
    let h = harness();
    let id = scenario(&h, false);
    let err = h
        .agent
        .start(
            RunRequest {
                scenario_id: id.clone(),
                inputs: Map::new(),
                origin: Default::default(),
            },
            None,
        )
        .unwrap_err();
    assert_eq!(err.code, "NOT_PUBLISHED");

    let now = Zoned::now();
    save(
        &h,
        vec![Schedule {
            id: "sch_x".into(),
            name: "x".into(),
            scenario_id: id,
            enabled: true,
            when: When::Every {
                minutes: 1,
                from: None,
                to: None,
                days: vec![],
            },
            inputs: Map::new(),
        }],
    );
    h.agent.tick(&now, false);
    h.agent.tick(&now.checked_add(61.seconds()).unwrap(), false);
    let reports = wait_for_reports(&h, 1).await;
    assert_eq!(reports[0].status, RunStatus::Failed);
    assert_eq!(reports[0].error.as_ref().unwrap().code, "NOT_PUBLISHED");
}

#[tokio::test]
async fn a_new_file_starts_one_run_with_its_path() {
    let h = harness();
    let id = scenario(&h, true);
    let input = h.agent.service().project_dir(&id).unwrap().join("input");
    std::fs::create_dir_all(&input).unwrap();
    std::fs::write(input.join("old.csv"), "a").unwrap();
    save(
        &h,
        vec![Schedule {
            id: "sch_file".into(),
            name: "受注ファイル".into(),
            scenario_id: id,
            enabled: true,
            when: When::FileAdded {
                folder: "input".into(),
                pattern: "*.csv".into(),
                input: Some("file".into()),
            },
            inputs: Map::new(),
        }],
    );
    let now = Zoned::now();
    h.agent.tick(&now, true);
    std::fs::write(input.join("new.csv"), "b").unwrap();
    std::fs::write(input.join("note.txt"), "c").unwrap();
    std::fs::write(input.join("~$new.csv"), "lock").unwrap();
    // First seen: waits until its size stops changing.
    h.agent.tick(&now, true);
    assert!(h.reports.lock().unwrap().is_empty());
    h.agent.tick(&now, true);
    let reports = wait_for_reports(&h, 1).await;
    let got = reports[0].outputs["got"].as_str().unwrap().to_owned();
    assert!(got.ends_with("new.csv"), "{got}");
    // Not again.
    h.agent.tick(&now, true);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(h.reports.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn other_processes_talk_to_it_over_the_pipe() {
    let h = harness();
    let id = scenario(&h, true);
    let root = h.agent.local_root().to_path_buf();
    // No agent yet.
    let e = ipc::call(&root, &Request::Status).await.unwrap_err();
    assert!(ipc::not_running(&e), "{e}");

    let serving = tokio::spawn(Arc::clone(&h.agent).serve());
    let mut status = None;
    for _ in 0..100 {
        if let Ok(r) = ipc::call(&root, &Request::Status).await {
            status = r.status;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let status = status.expect("agent answers");
    assert_eq!(status.pid, std::process::id());
    // A second agent for the same workspace refuses to start.
    assert_eq!(
        ipc::Listener::bind(&root).err().map(|e| e.kind()),
        Some(std::io::ErrorKind::AddrInUse)
    );

    let r = ipc::call(
        &root,
        &Request::Run {
            request: RunRequest {
                scenario_id: id,
                inputs: [("file".to_owned(), json!("x.csv"))].into_iter().collect(),
                origin: shikigami_runtime::RunOrigin::new(RunTrigger::Cli),
            },
        },
    )
    .await
    .unwrap();
    assert!(r.ok, "{r:?}");
    let reports = wait_for_reports(&h, 1).await;
    assert_eq!(Some(&reports[0].run_id), r.run_id.as_ref());
    assert_eq!(reports[0].outputs["got"], json!("x.csv"));

    let r = ipc::call(&root, &Request::Stop).await.unwrap();
    assert!(r.ok);
    tokio::time::timeout(Duration::from_secs(5), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
