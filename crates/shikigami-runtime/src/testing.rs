//! Running a flow's test cases (`shikigami_core::testcase`): one run per
//! case, recorded like any other, then compared with what the case expects.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use shikigami_core::Flow;
use shikigami_core::testcase::{self, TestCase};

use crate::record::RunRecorder;
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

/// Run one case and compare. `workspace` is where runs are recorded.
pub async fn run_case(
    runtime: &Runtime,
    workspace: &Path,
    name: &str,
    case: &TestCase,
    flow: Flow,
    options: RunOptions,
) -> Result<CaseResult, RunError> {
    let handle = runtime.start(flow, options)?;
    let run_id = handle.run_id.to_string();
    let mut recorder = RunRecorder::create(workspace, &handle.run_id).map_err(record_err)?;
    let report = handle
        .wait_with(|e| {
            if let Err(err) = recorder.write_event(e) {
                tracing::warn!(error = %err, "failed to record event");
            }
        })
        .await?;
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
