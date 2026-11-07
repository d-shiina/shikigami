#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use jiff::{ToSpan, Zoned};
use serde_json::{Map, json};
use shikigami_agent::ipc::{self, Request};
use shikigami_agent::{Agent, RunRequest, Schedule, Schedules, When};
use shikigami_core::{
    Actor, ActorKind, FileStore, FlowId, FlowService, NewFlow, PublishInput, Step, VarDirection,
    VarType, VariableDef,
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
    let svc = Arc::new(FlowService::new(
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

/// A flow with an input `file` that it copies to the output `got`.
fn flow(h: &Harness, publish: bool) -> FlowId {
    let mut file = VariableDef::new("file", VarType::String);
    file.direction = VarDirection::Input;
    file.default = Some(json!(""));
    let mut got = VariableDef::new("got", VarType::String);
    got.direction = VarDirection::Output;
    let out = h
        .agent
        .service()
        .create(
            NewFlow {
                name: "受注取り込み".into(),
                variables: vec![file, got],
                steps: vec![
                    Step::new("variable.set")
                        .with_param("name", "got")
                        .with_param("expression", "file")
                        .with_id("s1"),
                ],
                ..NewFlow::default()
            },
            person(),
        )
        .unwrap();
    let id = out.flow.id;
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
    let id = flow(&h, true);
    let now = Zoned::now();
    let at = now.checked_add(1.minute()).unwrap();
    save(
        &h,
        vec![Schedule {
            id: "sch_morning".into(),
            name: "毎朝".into(),
            flow_id: id.clone(),
            enabled: true,
            when: When::Daily {
                at: at.strftime("%H:%M").to_string(),
                days: vec![],
                skip_holidays: false,
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
async fn an_unpublished_flow_is_reported_as_failed() {
    let h = harness();
    let id = flow(&h, false);
    let err = h
        .agent
        .start(
            RunRequest {
                flow_id: id.clone(),
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
            flow_id: id,
            enabled: true,
            when: When::Every {
                minutes: 1,
                from: None,
                to: None,
                days: vec![],
                skip_holidays: false,
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
    let id = flow(&h, true);
    let input = h.agent.service().project_dir(&id).unwrap().join("input");
    std::fs::create_dir_all(&input).unwrap();
    std::fs::write(input.join("old.csv"), "a").unwrap();
    save(
        &h,
        vec![Schedule {
            id: "sch_file".into(),
            name: "受注ファイル".into(),
            flow_id: id,
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
    // Processed and removed, then the same name arrives again: a new run.
    std::fs::remove_file(input.join("new.csv")).unwrap();
    h.agent.tick(&now, true);
    std::fs::write(input.join("new.csv"), "again").unwrap();
    h.agent.tick(&now, true);
    h.agent.tick(&now, true);
    wait_for_reports(&h, 2).await;
}

#[tokio::test]
async fn a_broken_schedules_file_stops_every_schedule() {
    let h = harness();
    let id = flow(&h, true);
    save(
        &h,
        vec![Schedule {
            id: "sch_x".into(),
            name: "x".into(),
            flow_id: id,
            enabled: true,
            when: When::Every {
                minutes: 1,
                from: None,
                to: None,
                days: vec![],
                skip_holidays: false,
            },
            inputs: Map::new(),
        }],
    );
    let now = Zoned::now();
    h.agent.tick(&now, false);
    // Someone is editing it and leaves it broken.
    let path = Schedules::path(h.agent.local_root());
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(&path, "{ not json").unwrap();
    h.agent.tick(&now.checked_add(61.seconds()).unwrap(), false);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(h.reports.lock().unwrap().is_empty());
    let status = h.agent.status();
    assert!(status.problem.is_some());
    assert!(status.schedules.is_empty());
}

#[tokio::test]
async fn other_processes_talk_to_it_over_the_pipe() {
    let h = harness();
    let id = flow(&h, true);
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
                flow_id: id,
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

// -- mail triggers --------------------------------------------------------------

use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_runtime::{ActionHandler, ActionInput, BoxFuture, StepError};

/// A stand-in for `mail.list`: answers with `mails`, remembering the params.
struct FakeMailbox {
    mails: Arc<Mutex<Result<Vec<serde_json::Value>, &'static str>>>,
    asked: Arc<Mutex<Vec<serde_json::Value>>>,
    /// When set, each look waits for a permit before it answers.
    gate: Option<Arc<tokio::sync::Semaphore>>,
}

impl ActionHandler for FakeMailbox {
    fn execute<'a>(
        &'a self,
        input: ActionInput,
    ) -> BoxFuture<'a, Result<serde_json::Value, StepError>> {
        Box::pin(async move {
            self.asked.lock().unwrap().push(input.params.clone());
            if let Some(gate) = &self.gate {
                gate.acquire().await.unwrap().forget();
            }
            match &*self.mails.lock().unwrap() {
                // Newest first, as many as `limit`, before `before`.
                Ok(mails) => Ok(serde_json::Value::Array(
                    mails
                        .iter()
                        .filter(|m| {
                            input.params["before"].as_str().is_none_or(|before| {
                                m["receivedAt"].as_str().unwrap_or_default() < before
                            })
                        })
                        .take(input.params["limit"].as_u64().unwrap_or(50) as usize)
                        .cloned()
                        .collect(),
                )),
                Err(code) => Err(StepError::permanent(*code, "Outlook is not ready")),
            }
        })
    }
}

fn mail_list_def() -> StepTypeDef {
    StepTypeDef {
        targets: Vec::new(),
        step_type: "mail.list".into(),
        category: StepCategory::Other,
        label: "mail".into(),
        description: String::new(),
        params_schema: json!({ "type": "object" }),
        blocks: vec![],
        has_output: true,
        expression_params: vec![],
        binds_variables: vec![],
        risk: RiskLevel::Safe,
        examples: vec![],
        resources: vec![],
        secret_params: vec![],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        path_params: Vec::new(),
    }
}

fn mail(id: &str, subject: &str) -> serde_json::Value {
    json!({ "id": id, "subject": subject, "from": "株式会社サンプル", "fromAddress": "billing@sample.co.jp", "receivedAt": "2026-11-07T09:00:00", "unread": true, "attachments": ["請求書.pdf"] })
}

type Reports = Arc<Mutex<Vec<RunReport>>>;

/// An agent with a published flow that keeps the mail's subject in `got`,
/// and a mail trigger "請求書メール" on it, looking every 5 minutes.
fn mail_agent(
    dir: &std::path::Path,
    mails: &Arc<Mutex<Result<Vec<serde_json::Value>, &'static str>>>,
    asked: &Arc<Mutex<Vec<serde_json::Value>>>,
    gate: Option<Arc<tokio::sync::Semaphore>>,
) -> (Arc<Agent>, Reports) {
    let runtime = Runtime::builder()
        .register(
            mail_list_def(),
            FakeMailbox {
                mails: Arc::clone(mails),
                asked: Arc::clone(asked),
                gate,
            },
        )
        .build();
    let svc = Arc::new(FlowService::new(
        FileStore::open(dir).unwrap(),
        runtime.registry().clone(),
    ));
    let agent = Agent::new(svc, runtime);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let sink = reports.clone();
    agent.on_finished(Arc::new(move |r: &RunReport| {
        sink.lock().unwrap().push(r.clone())
    }));
    let mut input = VariableDef::new("mail", VarType::Any);
    input.direction = VarDirection::Input;
    input.default = Some(json!(null));
    let mut got = VariableDef::new("got", VarType::String);
    got.direction = VarDirection::Output;
    let id = agent
        .service()
        .create(
            NewFlow {
                name: "請求書の受付".into(),
                variables: vec![input, got],
                steps: vec![
                    Step::new("variable.set")
                        .with_param("name", "got")
                        .with_param("expression", "mail.subject")
                        .with_id("s1"),
                ],
                ..NewFlow::default()
            },
            person(),
        )
        .unwrap()
        .flow
        .id;
    agent
        .service()
        .publish(&id, PublishInput::default(), person())
        .unwrap();
    Schedules {
        format_version: 1,
        schedules: vec![Schedule {
            id: "sch_mail".into(),
            name: "請求書メール".into(),
            flow_id: id,
            enabled: true,
            when: When::MailReceived {
                folder: Some("受信トレイ".into()),
                subject_contains: Some("請求書".into()),
                from_contains: None,
                via: None,
                account: None,
                minutes: Some(5),
                input: Some("mail".into()),
            },
            inputs: Map::new(),
        }],
    }
    .save(&Schedules::path(agent.local_root()))
    .unwrap();

    (agent, reports)
}

#[tokio::test]
async fn a_new_mail_starts_one_run_with_the_mail() {
    let dir = tempfile::tempdir().unwrap();
    let mails = Arc::new(Mutex::new(Ok(vec![mail("old", "【請求書】9月分")])));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let (agent, reports) = mail_agent(dir.path(), &mails, &asked, None);
    let settle = || async {
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    let now = Zoned::now();
    // The first look only learns what is there.
    agent.tick(&now, false);
    settle().await;
    assert!(reports.lock().unwrap().is_empty());
    let first = asked.lock().unwrap()[0].clone();
    assert_eq!(first["folder"], "受信トレイ");
    assert_eq!(first["subjectContains"], "請求書");
    assert!(first["since"].as_str().is_some());
    // Not before its minutes are up.
    mails
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .insert(0, mail("new", "【請求書】10月分"));
    agent.tick(&now.checked_add(1.minute()).unwrap(), false);
    settle().await;
    assert_eq!(asked.lock().unwrap().len(), 1);
    // Then the new mail starts one run, with the mail in `mail`.
    let later = now.checked_add(6.minutes()).unwrap();
    agent.tick(&later, false);
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    while reports.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let got = reports.lock().unwrap().clone();
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].outputs["got"], "【請求書】10月分");
    // Not again; a failed look is shown in the status.
    *mails.lock().unwrap() = Err("OUTLOOK_NOT_READY");
    agent.tick(&later.checked_add(6.minutes()).unwrap(), false);
    settle().await;
    let status = agent.status();
    assert!(
        status.schedules[0]
            .problem
            .as_deref()
            .is_some_and(|p| p.contains("OUTLOOK_NOT_READY")),
        "{status:?}"
    );
    assert_eq!(reports.lock().unwrap().len(), 1);
}

/// Waits until `reports` has `n` runs (or a while).
async fn wait_for(reports: &Reports, n: usize, secs: u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    while reports.lock().unwrap().len() < n && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn more_new_mails_than_one_page_all_start_runs() {
    let dir = tempfile::tempdir().unwrap();
    let mails = Arc::new(Mutex::new(Ok(Vec::new())));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let (agent, reports) = mail_agent(dir.path(), &mails, &asked, None);
    // Pages of 10 (not 500), so a few runs cover more than one page; 600
    // whole runs took over a minute on Windows CI.
    agent.set_mail_page(10);
    let now = Zoned::now();
    agent.tick(&now, false);
    tokio::time::sleep(Duration::from_millis(300)).await;
    // 25 arrive before the next look, newest first, a second apart.
    let start: jiff::civil::DateTime = "2026-11-07T09:00:00".parse().unwrap();
    *mails.lock().unwrap() = Ok((0..25)
        .rev()
        .map(|i| {
            let mut m = mail(&format!("m{i}"), &format!("【請求書】{i}"));
            let at = start.checked_add(i64::from(i).seconds()).unwrap();
            m["receivedAt"] = json!(at.strftime("%Y-%m-%dT%H:%M:%S").to_string());
            m
        })
        .collect());
    agent.tick(&now.checked_add(6.minutes()).unwrap(), false);
    wait_for(&reports, 25, 60).await;
    let got = reports.lock().unwrap().clone();
    assert_eq!(got.len(), 25);
    // The oldest one too, which the first page did not hold.
    assert!(got.iter().any(|r| r.outputs["got"] == "【請求書】0"));
    let asked = asked.lock().unwrap().clone();
    // The first look, then three pages: 24–15, 15–6 and 6–0.
    assert_eq!(asked.len(), 4, "{asked:?}");
    assert_eq!(asked[2]["before"], "2026-11-07T09:00:16");
    assert_eq!(asked[3]["before"], "2026-11-07T09:00:07");
}

#[tokio::test]
async fn a_trigger_turned_off_while_looking_starts_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mails = Arc::new(Mutex::new(Ok(vec![mail("old", "【請求書】9月分")])));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let gate = Arc::new(tokio::sync::Semaphore::new(1));
    let (agent, reports) = mail_agent(dir.path(), &mails, &asked, Some(gate.clone()));
    let now = Zoned::now();
    agent.tick(&now, false);
    tokio::time::sleep(Duration::from_millis(300)).await;
    mails
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .insert(0, mail("new", "【請求書】10月分"));
    // The look starts and waits; meanwhile the trigger is turned off.
    agent.tick(&now.checked_add(6.minutes()).unwrap(), false);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(asked.lock().unwrap().len(), 2);
    let path = Schedules::path(agent.local_root());
    let mut schedules = Schedules::load(&path).unwrap();
    schedules.schedules[0].enabled = false;
    schedules.save(&path).unwrap();
    agent.tick(&now.checked_add(7.minutes()).unwrap(), false);
    gate.add_permits(1);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(reports.lock().unwrap().is_empty());
}
