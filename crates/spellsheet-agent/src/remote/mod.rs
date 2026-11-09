//! The agent's link to a management server (docs/remote.md).
//!
//! Off unless `policy.json` turns it on (`remote.enabled`, `remote.manager`)
//! and this PC was enrolled with a one-time code (`spellsheet worker enroll`).
//! The agent only ever connects out: when it has nothing running it asks the
//! server for a job it may run, runs it like any unattended run (published
//! version, `policy.json` checks), and sends its events and report back.

pub mod protocol;

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use spellsheet_core::{ErrorPayload, Policy, RunId};
use spellsheet_runtime::{RunOrigin, RunTrigger, record};
use spellsheet_secrets::KeyStore;

use crate::agent::{Agent, RunRequest};
use protocol::{
    Ack, ClaimRequest, EnrollRequest, EnrollResponse, Events, Finished, HEADER_SIGNATURE,
    HEADER_TIME, HEADER_WORKER, Job, Offer, PREFIX, Rejected, Started, WorkerKey,
};

/// How long the server may hold a claim open.
const CLAIM_WAIT_SECS: u64 = 25;
/// How often a running job's events and heartbeat go out.
const PROGRESS_EVERY: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct RemoteError(pub String);

fn remote_err(e: impl std::fmt::Display) -> RemoteError {
    RemoteError(e.to_string())
}

/// `agent/remote.json`: which server this PC is enrolled with, as which
/// worker. The private key is in the key store, not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    pub manager: String,
    pub worker_id: String,
}

impl Enrollment {
    pub fn path(local_root: &Path) -> PathBuf {
        local_root.join("agent").join("remote.json")
    }

    pub fn load(local_root: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(Self::path(local_root)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn save(&self, local_root: &Path) -> Result<(), RemoteError> {
        let text = serde_json::to_vec_pretty(self).map_err(remote_err)?;
        std::fs::create_dir_all(local_root.join("agent")).map_err(remote_err)?;
        spellsheet_core::store::write_atomic(&Self::path(local_root), &text).map_err(remote_err)
    }
}

/// Where the worker's private key is kept (Windows Credential Manager).
pub fn key_id(local_root: &Path) -> String {
    format!("worker-{}", crate::ipc::workspace_hash(local_root))
}

/// The key store the agent uses when none is given.
pub fn default_key_store(local_root: &Path) -> Arc<dyn KeyStore> {
    Arc::from(spellsheet_secrets::platform_key_store(
        local_root.join("agent"),
    ))
}

fn base(manager: &str) -> String {
    manager.trim_end_matches('/').to_owned()
}

fn check_manager(manager: &str) -> Result<(), RemoteError> {
    if manager.starts_with("https://") || spellsheet_core::policy::is_local_http(manager) {
        Ok(())
    } else {
        Err(RemoteError(format!(
            "{manager}: the management server must be https:// (http:// only for localhost)"
        )))
    }
}

fn client() -> Result<&'static reqwest::Client, RemoteError> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .user_agent(concat!("SpellSheet-Agent/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(CLAIM_WAIT_SECS + 20))
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| RemoteError("no HTTP client".into()))
}

/// Enrolls this PC with `manager` using a one-time `code`: makes a key pair,
/// sends the public key, and keeps the private key in `keys`.
pub async fn enroll(
    local_root: &Path,
    workspace_root: &Path,
    keys: &dyn KeyStore,
    manager: &str,
    code: &str,
) -> Result<Enrollment, RemoteError> {
    check_manager(manager)?;
    let mut seed = [0u8; 32];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut seed)
        .map_err(|_| RemoteError("no random numbers for the key".into()))?;
    let key = WorkerKey::from_seed(&seed);
    let request = EnrollRequest {
        code: code.trim().to_owned(),
        public_key: key.public_key(),
        machine: spellsheet_runtime::event::machine_name().unwrap_or_default(),
        user: std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_default(),
        workspace: workspace_root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let response = client()?
        .post(format!("{}{PREFIX}/enroll", base(manager)))
        .json(&request)
        .send()
        .await
        .map_err(remote_err)?;
    if !response.status().is_success() {
        return Err(answer_error(response).await);
    }
    let answer: EnrollResponse = response.json().await.map_err(remote_err)?;
    keys.store(&key_id(local_root), &seed).map_err(remote_err)?;
    let enrollment = Enrollment {
        manager: base(manager),
        worker_id: answer.worker_id,
    };
    enrollment.save(local_root)?;
    Ok(enrollment)
}

/// Forgets the enrollment and the key.
pub fn unenroll(local_root: &Path, keys: &dyn KeyStore) -> Result<(), RemoteError> {
    keys.remove(&key_id(local_root)).map_err(remote_err)?;
    match std::fs::remove_file(Enrollment::path(local_root)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(remote_err(e)),
        _ => Ok(()),
    }
}

async fn answer_error(response: reqwest::Response) -> RemoteError {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<ErrorPayload>(&text)
        .map(|e| format!("{}: {}", e.code, e.message))
        .unwrap_or(text);
    RemoteError(format!(
        "the management server answered {status}: {message}"
    ))
}

/// A signed connection to the server, as the enrolled worker.
struct Link {
    base: String,
    worker_id: String,
    key: WorkerKey,
}

impl Link {
    /// `Ok(None)` for 204 No Content.
    async fn post<B: Serialize, R: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<Option<R>, RemoteError> {
        let body = serde_json::to_vec(body).map_err(remote_err)?;
        let path = format!("{PREFIX}{path}");
        let time = time::OffsetDateTime::now_utc().unix_timestamp();
        let response = client()?
            .post(format!("{}{path}", self.base))
            .header(HEADER_WORKER, &self.worker_id)
            .header(HEADER_TIME, time.to_string())
            .header(HEADER_SIGNATURE, self.key.sign("POST", &path, time, &body))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(remote_err)?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(answer_error(response).await);
        }
        let bytes = response.bytes().await.map_err(remote_err)?;
        if bytes.is_empty() {
            // An answer with no body where one was not needed (`()`).
            return serde_json::from_slice(b"null")
                .map(Some)
                .map_err(remote_err);
        }
        serde_json::from_slice(&bytes).map(Some).map_err(remote_err)
    }
}

/// The server and worker this agent talks to now, or why none.
fn connect(agent: &Agent) -> Result<Option<Link>, RemoteError> {
    let policy = Policy::load(&Policy::path(agent.service().store().root())).map_err(remote_err)?;
    if !policy.remote.enabled {
        return Ok(None);
    }
    let Some(manager) = policy.remote.manager.as_deref() else {
        return Err(RemoteError(
            "remote.enabled is on but remote.manager is not set in policy.json".into(),
        ));
    };
    check_manager(manager)?;
    let Some(enrollment) = Enrollment::load(agent.local_root()) else {
        return Err(RemoteError(format!(
            "this PC is not enrolled with {manager} (spellsheet worker enroll)"
        )));
    };
    if enrollment.manager != base(manager) {
        return Err(RemoteError(format!(
            "this PC is enrolled with {}, not {manager}; enroll again",
            enrollment.manager
        )));
    }
    let seed = agent
        .key_store()
        .load(&key_id(agent.local_root()))
        .map_err(remote_err)?
        .ok_or_else(|| RemoteError("the worker key is missing; enroll again".into()))?;
    Ok(Some(Link {
        base: enrollment.manager,
        worker_id: enrollment.worker_id,
        key: WorkerKey::from_seed(&seed),
    }))
}

/// What `policy.json` lets the server start here, with the published
/// version of each.
fn offers(agent: &Agent) -> Result<Vec<Offer>, RemoteError> {
    let svc = agent.service();
    let policy = Policy::load(&Policy::path(svc.store().root())).map_err(remote_err)?;
    let mut out = Vec::new();
    for summary in svc.list().map_err(remote_err)? {
        if !policy.remote.allows(summary.id.as_str()) {
            continue;
        }
        if let Ok(Some(version)) = svc.published_version(&summary.id) {
            out.push(Offer {
                flow_id: summary.id,
                name: summary.name,
                version_uid: version.uid,
            });
        }
    }
    Ok(out)
}

fn refusal(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

/// Checks a job against this PC's rules and starts it.
fn start_job(agent: &Arc<Agent>, job: &Job) -> Result<RunId, ErrorPayload> {
    let svc = agent.service();
    let policy = Policy::load(&Policy::path(svc.store().root()))?;
    if !policy.remote.allows(job.flow_id.as_str()) {
        return Err(refusal(
            "REMOTE_NOT_ALLOWED",
            format!(
                "policy.json on this PC does not let the management server start {}",
                job.flow_id
            ),
        ));
    }
    if let Some(uid) = &job.version_uid {
        match svc.published_version(&job.flow_id)? {
            Some(v) if &v.uid == uid => {}
            Some(v) => {
                return Err(refusal(
                    "VERSION_MISMATCH",
                    format!(
                        "the job is for version {uid}, but version {} ({}) is published on this PC",
                        v.number, v.uid
                    ),
                ));
            }
            None => {
                return Err(refusal(
                    "NOT_PUBLISHED",
                    format!("{} has no published version on this PC", job.flow_id),
                ));
            }
        }
    }
    let mut origin = RunOrigin::new(RunTrigger::Remote);
    origin.requested_by = job.requested_by.clone();
    origin.job_id = Some(job.id.clone());
    agent.start(
        RunRequest {
            flow_id: job.flow_id.clone(),
            inputs: job.inputs.clone(),
            origin,
        },
        None,
    )
}

/// Sleeps `d`, or less when the agent stops. `false` when it stopped.
async fn pause(agent: &Agent, d: Duration) -> bool {
    let stop = agent.stopping();
    tokio::select! {
        () = stop.cancelled() => false,
        () = tokio::time::sleep(d) => true,
    }
}

/// Events of `run_id` from `from` on.
fn events_from(
    local_root: &Path,
    run_id: &RunId,
    from: u64,
) -> Vec<spellsheet_runtime::RunEventEnvelope> {
    record::read_events(local_root, run_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.seq >= from)
        .collect()
}

/// Runs one job: checks, start, progress until the run ends, the report.
async fn run_job(agent: &Arc<Agent>, link: &Link, job: Job) {
    let jobs = format!("/jobs/{}", job.id);
    let run_id = match start_job(agent, &job) {
        Ok(id) => id,
        Err(error) => {
            tracing::info!(job = %job.id, code = %error.code, "job refused");
            if let Err(e) = link
                .post::<_, ()>(&format!("{jobs}/rejected"), &Rejected { error })
                .await
            {
                tracing::warn!(error = %e, "could not tell the server the job was refused");
            }
            return;
        }
    };
    tracing::info!(job = %job.id, run = %run_id, "job started");
    // Until the server has recorded the start, it may hand the job to
    // another PC when the lease runs out. The run is cancelled before that
    // happens, so a job never runs twice at once.
    let leased_at = std::time::Instant::now();
    let lease = Duration::from_secs(job.lease_secs.max(10));
    let mut confirmed = false;
    let root = agent.local_root().to_path_buf();
    let mut next_seq = 0;
    let mut cancelled = false;
    loop {
        let running = agent.running().iter().any(|r| r.run_id == run_id);
        if !confirmed {
            match link
                .post::<_, ()>(
                    &format!("{jobs}/started"),
                    &Started {
                        run_id: run_id.clone(),
                    },
                )
                .await
            {
                Ok(_) => confirmed = true,
                Err(e) => tracing::warn!(error = %e, "could not tell the server the job started"),
            }
        }
        let events = events_from(&root, &run_id, next_seq);
        let last = events.last().map(|e| e.seq + 1);
        let ack: Result<Option<Ack>, RemoteError> = if events.is_empty() {
            link.post(&format!("{jobs}/heartbeat"), &serde_json::json!({}))
                .await
        } else {
            link.post(&format!("{jobs}/events"), &Events { events })
                .await
        };
        match ack {
            Ok(ack) => {
                // The server takes progress from the holder as its start.
                confirmed = true;
                if let Some(seq) = last {
                    next_seq = seq;
                }
                if ack.is_some_and(|a| a.cancel) && !cancelled {
                    cancelled = agent.cancel(&run_id);
                }
            }
            // Kept in the run folder; sent again on the next round.
            Err(e) => tracing::warn!(error = %e, "could not send the run's progress"),
        }
        if !confirmed && !cancelled && running && leased_at.elapsed() > lease * 3 / 4 {
            tracing::warn!(job = %job.id, "the server never heard the job start; cancelling it before the lease runs out");
            cancelled = agent.cancel(&run_id);
        }
        if !running {
            break;
        }
        if !pause(agent, PROGRESS_EVERY).await {
            // The agent is stopping: its runs are cancelled; report below.
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    let Ok(Some(report)) = record::read_report(&root, &run_id) else {
        tracing::warn!(run = %run_id, "the run has no report to send");
        return;
    };
    let mut wait = Duration::from_secs(2);
    loop {
        let rest = events_from(&root, &run_id, next_seq);
        let sent = if rest.is_empty() {
            Ok(())
        } else {
            let last = rest.last().map_or(next_seq, |e| e.seq + 1);
            link.post::<_, Ack>(&format!("{jobs}/events"), &Events { events: rest })
                .await
                .map(|_| next_seq = last)
        };
        let done = match sent {
            Ok(()) => {
                link.post::<_, ()>(
                    &format!("{jobs}/finished"),
                    &Finished {
                        report: report.clone(),
                    },
                )
                .await
            }
            Err(e) => Err(e),
        };
        match done {
            Ok(_) => {
                tracing::info!(job = %job.id, "job finished");
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not send the report; trying again");
                if !pause(agent, wait).await {
                    return;
                }
                wait = (wait * 2).min(Duration::from_secs(60));
            }
        }
    }
}

/// The agent's loop for the management server: runs until the agent stops.
pub async fn run(agent: Arc<Agent>) {
    let mut wait = Duration::from_secs(2);
    loop {
        if agent.stopping().is_cancelled() {
            return;
        }
        let link = match connect(&agent) {
            Ok(Some(link)) => {
                agent.set_remote_problem(None);
                link
            }
            Ok(None) => {
                agent.set_remote_problem(None);
                if !pause(&agent, Duration::from_secs(10)).await {
                    return;
                }
                continue;
            }
            Err(e) => {
                agent.set_remote_problem(Some(e.0));
                if !pause(&agent, Duration::from_secs(30)).await {
                    return;
                }
                continue;
            }
        };
        // Only a free PC asks for work.
        if !agent.running().is_empty() {
            if !pause(&agent, Duration::from_secs(2)).await {
                return;
            }
            continue;
        }
        let request = ClaimRequest {
            flows: offers(&agent).unwrap_or_default(),
            desktop: agent.desktop_available(),
            wait_secs: CLAIM_WAIT_SECS,
        };
        let stop = agent.stopping();
        let claim = tokio::select! {
            () = stop.cancelled() => return,
            claim = link.post::<_, Job>("/jobs/claim", &request) => claim,
        };
        match claim {
            Ok(Some(job)) => {
                wait = Duration::from_secs(2);
                agent.set_remote_problem(None);
                run_job(&agent, &link, job).await;
            }
            Ok(None) => wait = Duration::from_secs(2),
            Err(e) => {
                tracing::warn!(error = %e, "management server");
                agent.set_remote_problem(Some(e.0));
                if !pause(&agent, wait).await {
                    return;
                }
                wait = (wait * 2).min(Duration::from_secs(60));
            }
        }
    }
}
