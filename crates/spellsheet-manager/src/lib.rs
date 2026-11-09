//! A small reference management server for SpellSheet agents.
//!
//! It speaks protocol v1 (docs/remote.md) to the agents and has an
//! admin API for people and scripts: one-time enrollment codes, the list of
//! workers, jobs and their logs. Everything is kept in one JSON file. It is
//! meant for trying the protocol out, tests and small teams on a LAN; a real
//! management tool would add accounts, a database and a web UI on the same
//! protocol.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use spellsheet_agent::remote::protocol::{
    self, Ack, ClaimRequest, EnrollRequest, EnrollResponse, Events, Finished, Job, Rejected,
    Started,
};
use spellsheet_core::{ErrorPayload, FlowId, RunId};
use spellsheet_runtime::{RunEventEnvelope, RunReport};
use tokio::sync::Notify;

/// A worker must say it started (or send a heartbeat) within this time.
const LEASE_SECS: u64 = 60;
/// Enrollment codes are good for this long.
const CODE_SECS: i64 = 3600;
const MAX_WAIT_SECS: u64 = 60;

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // The system random source does not fail in practice; fall back to a
    // UUID's randomness if it ever does.
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut buf).is_err() {
        return uuid::Uuid::now_v7().simple().to_string();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub id: String,
    pub public_key: String,
    pub machine: String,
    pub user: String,
    pub workspace: String,
    pub enrolled_at: i64,
    #[serde(default)]
    pub last_seen: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    /// Waiting for a free worker.
    Queued,
    /// Handed to a worker that has not said it started.
    Leased,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    /// The worker would not run it (see `error`).
    Rejected,
    /// The worker stopped answering while it ran.
    Lost,
}

impl JobState {
    fn is_done(&self) -> bool {
        !matches!(self, Self::Queued | Self::Leased | Self::Running)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub flow_id: FlowId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub inputs: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    /// Only this worker may take it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
    pub state: JobState,
    /// The worker that has it (or had it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    /// Unix time the lease ends (leased and running jobs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<i64>,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<RunReport>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<RunEventEnvelope>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    /// One-time enrollment codes and when they expire.
    #[serde(default)]
    codes: BTreeMap<String, i64>,
    #[serde(default)]
    workers: BTreeMap<String, Worker>,
    #[serde(default)]
    jobs: BTreeMap<String, JobRecord>,
}

/// The server's state: in memory, saved to `state.json` after each change.
pub struct Manager {
    dir: PathBuf,
    admin_token: String,
    data: Mutex<Data>,
    /// Woken when a job may have become available.
    queue: Notify,
}

fn lock(m: &Mutex<Data>) -> std::sync::MutexGuard<'_, Data> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug)]
pub struct ApiError(StatusCode, Box<ErrorPayload>);

impl ApiError {
    fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self(
            status,
            Box::new(ErrorPayload {
                code: code.into(),
                message: message.into(),
                details: None,
            }),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(*self.1)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn not_found(what: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", format!("no {what}"))
}

fn bad_body(e: serde_json::Error) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "INVALID_REQUEST", e.to_string())
}

impl Manager {
    /// Opens (or makes) the server's folder: `state.json` and `admin-token`.
    pub fn open(dir: &Path) -> std::io::Result<Arc<Self>> {
        std::fs::create_dir_all(dir)?;
        let token_path = dir.join("admin-token");
        let admin_token = match std::fs::read_to_string(&token_path) {
            Ok(t) if !t.trim().is_empty() => t.trim().to_owned(),
            _ => {
                let t = random_hex(24);
                std::fs::write(&token_path, &t)?;
                t
            }
        };
        let data = match std::fs::read(dir.join("state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Data::default(),
            Err(e) => return Err(e),
        };
        Ok(Arc::new(Self {
            dir: dir.to_path_buf(),
            admin_token,
            data: Mutex::new(data),
            queue: Notify::new(),
        }))
    }

    /// The token the admin API wants (`Authorization: Bearer …`).
    pub fn admin_token(&self) -> &str {
        &self.admin_token
    }

    fn save(&self, data: &Data) {
        let result = serde_json::to_vec(data)
            .map_err(std::io::Error::other)
            .and_then(|bytes| {
                let tmp = self.dir.join("state.json.tmp");
                std::fs::write(&tmp, bytes)?;
                std::fs::rename(&tmp, self.dir.join("state.json"))
            });
        if let Err(e) = result {
            tracing::warn!(error = %e, "could not save the manager's state");
        }
    }

    /// Changes the data and saves it.
    fn change<T>(&self, f: impl FnOnce(&mut Data) -> T) -> T {
        let mut data = lock(&self.data);
        let out = f(&mut data);
        self.save(&data);
        out
    }

    /// Takes back expired leases: a job nobody started is queued again, a
    /// job whose worker went quiet while it ran is lost.
    fn sweep(&self, data: &mut Data) -> bool {
        let now = now();
        let mut requeued = false;
        for job in data.jobs.values_mut() {
            if job.lease_until.is_some_and(|t| t < now) {
                match job.state {
                    JobState::Leased => {
                        job.state = JobState::Queued;
                        job.taken_by = None;
                        job.lease_until = None;
                        requeued = true;
                    }
                    JobState::Running => {
                        job.state = JobState::Lost;
                        job.lease_until = None;
                        job.error = Some(ErrorPayload {
                            code: "WORKER_LOST".into(),
                            message: "the worker stopped answering while the job ran".into(),
                            details: None,
                        });
                    }
                    _ => {}
                }
            }
        }
        data.codes.retain(|_, until| *until >= now);
        requeued
    }

    // --- admin -----------------------------------------------------------

    fn admin(&self, headers: &HeaderMap) -> ApiResult<()> {
        let given = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or_default();
        if !given.is_empty() && same(given.as_bytes(), self.admin_token.as_bytes()) {
            Ok(())
        } else {
            Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "the admin token is missing or wrong",
            ))
        }
    }

    /// A one-time code to enroll one worker with.
    pub fn new_code(&self) -> EnrollmentCode {
        let code = random_hex(8);
        let expires_at = now() + CODE_SECS;
        self.change(|d| d.codes.insert(code.clone(), expires_at));
        EnrollmentCode { code, expires_at }
    }

    pub fn workers(&self) -> Vec<Worker> {
        lock(&self.data).workers.values().cloned().collect()
    }

    pub fn add_job(&self, new: NewJob) -> JobRecord {
        let job = JobRecord {
            id: format!("job_{}", uuid::Uuid::now_v7().simple()),
            flow_id: new.flow_id,
            version_uid: new.version_uid,
            inputs: new.inputs,
            requested_by: new.requested_by,
            worker: new.worker,
            state: JobState::Queued,
            taken_by: None,
            run_id: None,
            lease_until: None,
            cancel_requested: false,
            error: None,
            report: None,
            created_at: now(),
            events: Vec::new(),
        };
        self.change(|d| d.jobs.insert(job.id.clone(), job.clone()));
        self.queue.notify_waiters();
        job
    }

    pub fn job(&self, id: &str) -> Option<JobRecord> {
        let mut data = lock(&self.data);
        if self.sweep(&mut data) {
            self.queue.notify_waiters();
        }
        data.jobs.get(id).cloned()
    }

    /// Jobs, newest first, without their events.
    pub fn jobs(&self) -> Vec<JobRecord> {
        let mut data = lock(&self.data);
        if self.sweep(&mut data) {
            self.queue.notify_waiters();
        }
        data.jobs
            .values()
            .rev()
            .map(|j| JobRecord {
                events: Vec::new(),
                ..j.clone()
            })
            .collect()
    }

    /// Asks to stop a job: a queued one is cancelled at once, one a worker
    /// holds when that worker next checks in.
    pub fn cancel(&self, id: &str) -> Option<JobRecord> {
        self.change(|d| {
            let job = d.jobs.get_mut(id)?;
            match job.state {
                JobState::Queued => {
                    job.state = JobState::Cancelled;
                    job.lease_until = None;
                }
                // The worker may already be running it: it is told to stop
                // at its next check-in, and its report is still taken.
                JobState::Leased => {
                    job.state = JobState::Cancelled;
                    job.lease_until = None;
                    job.cancel_requested = true;
                }
                JobState::Running => job.cancel_requested = true,
                _ => {}
            }
            Some(job.clone())
        })
    }

    // --- workers ---------------------------------------------------------

    fn enroll(&self, request: EnrollRequest) -> ApiResult<EnrollResponse> {
        self.change(|d| {
            self.sweep(d);
            if d.codes.remove(request.code.trim()).is_none() {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "ENROLLMENT_CODE_INVALID",
                    "the enrollment code is wrong, used or expired; make a new one",
                ));
            }
            let id = format!("wkr_{}", uuid::Uuid::now_v7().simple());
            d.workers.insert(
                id.clone(),
                Worker {
                    id: id.clone(),
                    public_key: request.public_key,
                    machine: request.machine,
                    user: request.user,
                    workspace: request.workspace,
                    enrolled_at: now(),
                    last_seen: now(),
                },
            );
            Ok(EnrollResponse { worker_id: id })
        })
    }

    /// Checks a worker's signed request; returns the worker's ID.
    fn authenticate(&self, headers: &HeaderMap, path: &str, body: &[u8]) -> ApiResult<String> {
        let header = |name: &str| {
            [name.to_owned(), protocol::legacy_header(name)]
                .iter()
                .find_map(|name| headers.get(name.as_str()).and_then(|v| v.to_str().ok()))
        };
        let refuse =
            |message: &str| ApiError::new(StatusCode::UNAUTHORIZED, "WORKER_UNAUTHORIZED", message);
        let (Some(worker), Some(time), Some(signature)) = (
            header(protocol::HEADER_WORKER),
            header(protocol::HEADER_TIME).and_then(|t| t.parse::<i64>().ok()),
            header(protocol::HEADER_SIGNATURE),
        ) else {
            return Err(refuse("the request is not signed"));
        };
        if (now() - time).abs() > protocol::MAX_SKEW_SECS {
            return Err(refuse(
                "the request's time is too far from the server's clock",
            ));
        }
        let mut data = lock(&self.data);
        let Some(record) = data.workers.get_mut(worker) else {
            return Err(refuse("unknown worker (removed?); enroll the PC again"));
        };
        if !protocol::verify(&record.public_key, signature, "POST", path, time, body) {
            return Err(refuse("bad signature"));
        }
        record.last_seen = now();
        Ok(worker.to_owned())
    }

    /// Hands the first queued job this worker can run to it.
    fn try_claim(&self, worker: &str, offer: &ClaimRequest) -> Option<Job> {
        self.change(|d| {
            self.sweep(d);
            let job = d.jobs.values_mut().find(|j| {
                j.state == JobState::Queued
                    && j.worker.as_deref().is_none_or(|w| w == worker)
                    && offer.flows.iter().any(|o| {
                        o.flow_id == j.flow_id
                            && j.version_uid.as_ref().is_none_or(|u| *u == o.version_uid)
                    })
            })?;
            job.state = JobState::Leased;
            job.taken_by = Some(worker.to_owned());
            job.lease_until = Some(now() + i64::try_from(LEASE_SECS).unwrap_or(60));
            Some(Job {
                id: job.id.clone(),
                flow_id: job.flow_id.clone(),
                version_uid: job.version_uid.clone(),
                inputs: job.inputs.clone(),
                requested_by: job.requested_by.clone(),
                lease_secs: LEASE_SECS,
            })
        })
    }

    /// Runs `f` on a job the worker holds.
    fn with_job<T>(
        &self,
        worker: &str,
        id: &str,
        f: impl FnOnce(&mut JobRecord) -> T,
    ) -> ApiResult<T> {
        self.change(|d| {
            let job = d.jobs.get_mut(id).ok_or_else(|| not_found("job"))?;
            if job.taken_by.as_deref() != Some(worker) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "JOB_NOT_YOURS",
                    "this job is not held by this worker",
                ));
            }
            Ok(f(job))
        })
    }

    fn extend(job: &mut JobRecord) {
        if job.state == JobState::Running {
            job.lease_until = Some(now() + i64::try_from(LEASE_SECS).unwrap_or(60));
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentCode {
    pub code: String,
    pub expires_at: i64,
}

/// `POST /admin/jobs`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    pub flow_id: FlowId,
    #[serde(default)]
    pub version_uid: Option<String>,
    #[serde(default)]
    pub inputs: Map<String, Value>,
    #[serde(default)]
    pub requested_by: Option<String>,
    /// Only this worker; any free worker that can run it when not given.
    #[serde(default)]
    pub worker: Option<String>,
}

type Shared = State<Arc<Manager>>;

fn parse<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(bad_body)
}

async fn enroll(State(m): Shared, body: Bytes) -> ApiResult<Json<EnrollResponse>> {
    m.enroll(parse(&body)?).map(Json)
}

async fn claim(State(m): Shared, headers: HeaderMap, uri: Uri, body: Bytes) -> ApiResult<Response> {
    let worker = m.authenticate(&headers, uri.path(), &body)?;
    let offer: ClaimRequest = parse(&body)?;
    let until =
        tokio::time::Instant::now() + Duration::from_secs(offer.wait_secs.min(MAX_WAIT_SECS));
    loop {
        // Ask to be woken before looking, so a job added in between is not missed.
        let woken = m.queue.notified();
        tokio::pin!(woken);
        woken.as_mut().enable();
        if let Some(job) = m.try_claim(&worker, &offer) {
            return Ok(Json(job).into_response());
        }
        tokio::select! {
            () = woken => {}
            () = tokio::time::sleep_until(until) => return Ok(StatusCode::NO_CONTENT.into_response()),
            // Leases end without anyone saying so.
            () = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

async fn job_post(
    State(m): Shared,
    headers: HeaderMap,
    uri: Uri,
    UrlPath((id, action)): UrlPath<(String, String)>,
    body: Bytes,
) -> ApiResult<Response> {
    let worker = m.authenticate(&headers, uri.path(), &body)?;
    match action.as_str() {
        "started" => {
            let started: Started = parse(&body)?;
            m.with_job(&worker, &id, |j| {
                if j.state == JobState::Leased {
                    j.state = JobState::Running;
                    j.run_id = Some(started.run_id);
                    Manager::extend(j);
                }
            })?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        "rejected" => {
            let rejected: Rejected = parse(&body)?;
            m.with_job(&worker, &id, |j| {
                j.state = JobState::Rejected;
                j.lease_until = None;
                j.error = Some(rejected.error);
            })?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        "events" | "heartbeat" => {
            let events = if action == "events" {
                parse::<Events>(&body)?.events
            } else {
                Vec::new()
            };
            let ack = m.with_job(&worker, &id, |j| {
                let next = j.events.last().map_or(0, |e| e.seq + 1);
                j.events
                    .extend(events.into_iter().filter(|e| e.seq >= next));
                // Progress from the holder means it started, even when its
                // `started` was lost on the way.
                if j.state == JobState::Leased {
                    j.state = JobState::Running;
                }
                Manager::extend(j);
                Ack {
                    cancel: j.cancel_requested,
                }
            })?;
            Ok(Json(ack).into_response())
        }
        "finished" => {
            let finished: Finished = parse(&body)?;
            m.with_job(&worker, &id, |j| {
                let cancelled_while_held =
                    j.state == JobState::Cancelled && j.cancel_requested && j.report.is_none();
                if !j.state.is_done() || j.state == JobState::Lost || cancelled_while_held {
                    j.state = match finished.report.status {
                        spellsheet_runtime::RunStatus::Succeeded => JobState::Succeeded,
                        spellsheet_runtime::RunStatus::Cancelled => JobState::Cancelled,
                        _ => JobState::Failed,
                    };
                    j.error = finished.report.error.as_ref().map(|e| ErrorPayload {
                        code: e.code.clone(),
                        message: e.message.clone(),
                        details: None,
                    });
                    j.run_id = Some(finished.report.run_id.clone());
                    j.report = Some(finished.report);
                    j.lease_until = None;
                }
            })?;
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        _ => Err(not_found("such action")),
    }
}

async fn admin_code(State(m): Shared, headers: HeaderMap) -> ApiResult<Json<EnrollmentCode>> {
    m.admin(&headers)?;
    Ok(Json(m.new_code()))
}

async fn admin_workers(State(m): Shared, headers: HeaderMap) -> ApiResult<Json<Vec<Worker>>> {
    m.admin(&headers)?;
    Ok(Json(m.workers()))
}

async fn admin_remove_worker(
    State(m): Shared,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<StatusCode> {
    m.admin(&headers)?;
    m.change(|d| d.workers.remove(&id))
        .map(|_| StatusCode::NO_CONTENT)
        .ok_or_else(|| not_found("worker"))
}

async fn admin_add_job(
    State(m): Shared,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<JobRecord>> {
    m.admin(&headers)?;
    Ok(Json(m.add_job(parse(&body)?)))
}

async fn admin_jobs(State(m): Shared, headers: HeaderMap) -> ApiResult<Json<Vec<JobRecord>>> {
    m.admin(&headers)?;
    Ok(Json(m.jobs()))
}

async fn admin_job(
    State(m): Shared,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<JobRecord>> {
    m.admin(&headers)?;
    m.job(&id).map(Json).ok_or_else(|| not_found("job"))
}

async fn admin_cancel(
    State(m): Shared,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<JobRecord>> {
    m.admin(&headers)?;
    m.cancel(&id).map(Json).ok_or_else(|| not_found("job"))
}

/// The HTTP routes: `/v1/…` for agents, `/admin/…` for people and scripts.
pub fn router(manager: Arc<Manager>) -> Router {
    Router::new()
        .route("/v1/enroll", post(enroll))
        .route("/v1/jobs/claim", post(claim))
        .route("/v1/jobs/{id}/{action}", post(job_post))
        .route("/admin/enrollment-codes", post(admin_code))
        .route("/admin/workers", get(admin_workers))
        .route("/admin/workers/{id}", delete(admin_remove_worker))
        .route("/admin/jobs", post(admin_add_job).get(admin_jobs))
        .route("/admin/jobs/{id}", get(admin_job))
        .route("/admin/jobs/{id}/cancel", post(admin_cancel))
        .with_state(manager)
}

/// Serves until the process ends.
pub async fn serve(manager: Arc<Manager>, addr: SocketAddr) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(manager)).await
}

/// Serves on an already bound listener (tests: port 0).
pub async fn serve_on(
    manager: Arc<Manager>,
    listener: tokio::net::TcpListener,
) -> std::io::Result<()> {
    axum::serve(listener, router(manager)).await
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use spellsheet_agent::remote::protocol::Offer;

    #[test]
    fn a_job_cancelled_while_a_worker_holds_it_tells_that_worker() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manager::open(dir.path()).unwrap();
        let flow: FlowId = serde_json::from_value(serde_json::json!("scn_a")).unwrap();
        let job = m.add_job(NewJob {
            flow_id: flow.clone(),
            ..NewJob::default()
        });
        let offer = ClaimRequest {
            flows: vec![Offer {
                flow_id: flow,
                name: "a".into(),
                version_uid: "v1".into(),
            }],
            desktop: None,
            wait_secs: 0,
        };
        assert!(m.try_claim("w1", &offer).is_some());
        let cancelled = m.cancel(&job.id).unwrap();
        assert_eq!(cancelled.state, JobState::Cancelled);
        // The holder hears it at its next check-in, and the job does not
        // go back to the queue.
        assert!(cancelled.cancel_requested);
        assert!(m.with_job("w1", &job.id, |j| j.cancel_requested).unwrap());
        assert!(m.try_claim("w2", &offer).is_none());
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        h
    }

    #[test]
    fn the_admin_api_wants_the_exact_token() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manager::open(dir.path()).unwrap();
        assert!(m.admin(&bearer(m.admin_token())).is_ok());
        for wrong in [HeaderMap::new(), bearer(""), bearer("nope")] {
            let err = m.admin(&wrong).unwrap_err();
            assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        }
        // A token that only starts the same is still wrong.
        let prefix = &m.admin_token()[..10];
        assert!(m.admin(&bearer(prefix)).is_err());
    }

    #[test]
    fn the_token_and_the_jobs_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (token, job) = {
            let m = Manager::open(dir.path()).unwrap();
            let flow: FlowId = serde_json::from_value(serde_json::json!("scn_a")).unwrap();
            let job = m.add_job(NewJob {
                flow_id: flow,
                ..NewJob::default()
            });
            (m.admin_token().to_owned(), job.id)
        };
        let m = Manager::open(dir.path()).unwrap();
        assert_eq!(m.admin_token(), token);
        assert_eq!(m.job(&job).unwrap().state, JobState::Queued);
    }

    #[test]
    fn unsigned_or_unknown_workers_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manager::open(dir.path()).unwrap();
        let err = m
            .authenticate(&HeaderMap::new(), "/v1/jobs/claim", b"{}")
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        let mut h = HeaderMap::new();
        h.insert(protocol::HEADER_WORKER, "wkr_nobody".parse().unwrap());
        h.insert(protocol::HEADER_TIME, now().to_string().parse().unwrap());
        h.insert(protocol::HEADER_SIGNATURE, "AAAA".parse().unwrap());
        let err = m.authenticate(&h, "/v1/jobs/claim", b"{}").unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        // A request signed long ago is refused before the worker is looked up.
        h.insert(
            protocol::HEADER_TIME,
            (now() - 3600).to_string().parse().unwrap(),
        );
        assert!(m.authenticate(&h, "/v1/jobs/claim", b"{}").is_err());
    }

    #[test]
    fn an_enrollment_code_is_single_use_and_another_workers_job_is_not_yours() {
        let dir = tempfile::tempdir().unwrap();
        let m = Manager::open(dir.path()).unwrap();
        let code = m.new_code().code;
        let request = |code: &str| -> EnrollRequest {
            serde_json::from_value(serde_json::json!({
                "code": code, "publicKey": "k", "machine": "PC1", "user": "u", "workspace": "w"
            }))
            .unwrap()
        };
        assert!(m.enroll(request(&code)).is_ok());
        assert_eq!(
            m.enroll(request(&code)).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        let flow: FlowId = serde_json::from_value(serde_json::json!("scn_a")).unwrap();
        let job = m.add_job(NewJob {
            flow_id: flow.clone(),
            ..NewJob::default()
        });
        let offer = ClaimRequest {
            flows: vec![Offer {
                flow_id: flow,
                name: "a".into(),
                version_uid: "v1".into(),
            }],
            desktop: None,
            wait_secs: 0,
        };
        assert!(m.try_claim("w1", &offer).is_some());
        assert_eq!(
            m.with_job("w2", &job.id, |_| ()).unwrap_err().0,
            StatusCode::CONFLICT
        );
    }
}
