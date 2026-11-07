//! Running a flow's test cases (`shikigami_core::testcase`): one run per
//! case, recorded like any other, then compared with what the case expects.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use shikigami_core::Flow;
use shikigami_core::testcase::{self, TestCase};

use crate::record::RunRecorder;
use tokio_util::sync::CancellationToken;

use crate::{RunError, RunOptions, RunStatus, Runtime};

/// One test case's run, compared with what it expects.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub passed: bool,
    pub run_id: String,
    pub status: RunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RunError>,
    pub mismatches: Vec<testcase::Mismatch>,
    pub duration_ms: i64,
}

/// Stops a suite: cancels the case running now (so its `finally` blocks
/// and adapter clean-up run) and keeps the rest from starting. Ctrl+C in
/// the CLI.
#[derive(Clone, Default)]
pub struct Interrupt {
    current: Arc<Mutex<Option<CancellationToken>>>,
    stopped: Arc<AtomicBool>,
}

impl Interrupt {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(token) = self.slot().as_ref() {
            token.cancel();
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<CancellationToken>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn running(&self, token: Option<CancellationToken>) {
        let stopped = self.is_stopped();
        if let (true, Some(token)) = (stopped, &token) {
            token.cancel();
        }
        *self.slot() = token;
    }
}

/// Where a case's run is recorded: the workspace's local root, and its
/// `policy.json` (whose `records` limits apply as for any run).
pub struct Records<'a> {
    pub workspace: &'a Path,
    pub policy: &'a Path,
}

/// Run one case and compare.
pub async fn run_case(
    runtime: &Runtime,
    records: Records<'_>,
    interrupt: &Interrupt,
    name: &str,
    case: &TestCase,
    flow: Flow,
    options: RunOptions,
) -> Result<CaseResult, RunError> {
    let handle = runtime.start(flow, options)?;
    interrupt.running(Some(handle.cancel_token()));
    let run_id = handle.run_id.to_string();
    let mut recorder = RunRecorder::create(records.workspace, &handle.run_id)
        .map_err(record_err)?
        .prune_on_finish(records.policy);
    let report = handle
        .wait_with(|e| {
            if let Err(err) = recorder.write_event(e) {
                tracing::warn!(error = %err, "failed to record event");
            }
        })
        .await;
    interrupt.running(None);
    let report = report?;
    recorder.finish(&report).map_err(record_err)?;
    let status = serde_json::to_value(report.status).unwrap_or_default();
    let error_step = report
        .error
        .as_ref()
        .and_then(|e| e.step_id.as_ref())
        .map(|s| s.as_str());
    let mismatches = case.expect.check(&testcase::Outcome {
        status: status.as_str().unwrap_or_default(),
        outputs: &report.outputs,
        error_code: report.error.as_ref().map(|e| e.code.as_str()),
        error_step,
    });
    Ok(CaseResult {
        name: name.to_owned(),
        description: case.description.clone(),
        passed: mismatches.is_empty(),
        run_id,
        status: report.status,
        duration_ms: (report.finished_at - report.started_at).whole_milliseconds() as i64,
        error: report.error,
        mismatches,
    })
}

fn record_err(e: std::io::Error) -> RunError {
    RunError::new(
        "RUN_RECORD_FAILED",
        format!("could not record the run: {e}"),
    )
}
