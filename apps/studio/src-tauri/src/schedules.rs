//! The 「自動実行」 place: this PC's schedules (`schedules.json` in the per-PC
//! area) and the agent that fires them. Studio edits the file the agent
//! reads (it picks changes up within a second) and talks to the agent over
//! its local pipe, as `spellsheet schedule` and `spellsheet agent` do.
//! See docs/schedules.md.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use shikigami_agent::ipc::{self, Request};
use shikigami_agent::{AgentStatus, Schedule, Schedules, When};
use shikigami_core::call::called_ids;
use shikigami_core::{ErrorPayload, Flow, FlowId, FlowService, VariableDef};
use tauri::State;

use crate::AppState;

type CmdResult<T> = Result<T, ErrorPayload>;

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

/// A schedule with what Studio shows beside it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    #[serde(flatten)]
    pub schedule: Schedule,
    /// The flow's name; none when it was deleted.
    pub flow_name: Option<String>,
    /// The flow has a published version (schedules run only that).
    pub published: bool,
    /// It (or a flow it calls) has nodes that use the mouse and keyboard,
    /// which stop while the screen is locked.
    pub uses_screen: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleList {
    pub schedules: Vec<ScheduleView>,
    /// Where they are kept, for the person who wants to look.
    pub path: String,
    /// When this PC locks its screen by itself (a password-protected
    /// screen saver, the inactivity limit of a policy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_lock: Option<shikigami_desktop::screen_lock::ScreenLock>,
    /// Studio runs in a Remote Desktop session: closing its window locks
    /// the screen.
    pub remote: bool,
}

fn path(svc: &FlowService) -> PathBuf {
    Schedules::path(svc.store().local_root())
}

/// The flow a schedule runs (its published version) and the flows it
/// calls, as they would run.
fn flows_run_by(svc: &FlowService, id: &FlowId) -> Vec<Flow> {
    let mut seen = BTreeSet::new();
    let mut todo = vec![id.clone()];
    let mut flows = Vec::new();
    while let Some(id) = todo.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let flow = match svc.published_version(&id).ok().flatten() {
            Some(v) => v.flow,
            None => match svc.get(&id) {
                Ok(f) => f,
                Err(_) => continue,
            },
        };
        todo.extend(called_ids(&flow));
        flows.push(flow);
    }
    flows
}

fn list(state: &AppState) -> CmdResult<ScheduleList> {
    let svc = &state.service;
    let path = path(svc);
    let schedules = Schedules::load(&path)?
        .schedules
        .into_iter()
        .map(|schedule| ScheduleView {
            flow_name: svc.get(&schedule.flow_id).ok().map(|s| s.name),
            published: svc
                .published_version(&schedule.flow_id)
                .ok()
                .flatten()
                .is_some(),
            uses_screen: state
                .runtime
                .uses_desktop_input(&flows_run_by(svc, &schedule.flow_id)),
            schedule,
        })
        .collect();
    Ok(ScheduleList {
        schedules,
        path: path.display().to_string(),
        screen_lock: shikigami_desktop::screen_lock::current(),
        remote: is_remote(),
    })
}

#[tauri::command]
pub fn list_schedules(state: State<'_, AppState>) -> CmdResult<ScheduleList> {
    list(&state)
}

/// Adds a schedule (empty `id`) or replaces the one with its id.
#[tauri::command]
pub fn save_schedule(state: State<'_, AppState>, schedule: Schedule) -> CmdResult<ScheduleList> {
    let svc = &state.service;
    let mut schedule = schedule;
    if let Some(problem) = schedule.when.problem() {
        return Err(err("SCHEDULE_INVALID", problem));
    }
    let path = path(svc);
    let mut all = Schedules::load(&path)?;
    schedule.name = schedule.name.trim().to_owned();
    match svc.get(&schedule.flow_id) {
        Ok(flow) => {
            // Schedules run the published version, so its inputs are the
            // ones that must have a value.
            let published = svc.published_version(&schedule.flow_id).ok().flatten();
            let vars = published
                .as_ref()
                .map_or(&flow.variables, |v| &v.flow.variables);
            if let Some(problem) = missing_inputs(vars, &schedule) {
                return Err(err("SCHEDULE_INVALID", problem));
            }
            if schedule.name.is_empty() {
                schedule.name = flow.name;
            }
        }
        // A schedule whose flow was deleted can still be switched off or
        // renamed, but not pointed at it anew.
        Err(_)
            if all.schedules.iter().any(|s| {
                s.id == schedule.id && !schedule.id.is_empty() && s.flow_id == schedule.flow_id
            }) => {}
        Err(e) => return Err(e.into()),
    }
    if schedule.id.is_empty() {
        schedule.id = shikigami_agent::schedule::new_id();
        all.schedules.push(schedule);
    } else if let Some(slot) = all.schedules.iter_mut().find(|s| s.id == schedule.id) {
        *slot = schedule;
    } else {
        return Err(err(
            "SCHEDULE_NOT_FOUND",
            format!("no schedule {}", schedule.id),
        ));
    }
    all.save(&path)?;
    list(&state)
}

#[tauri::command]
pub fn delete_schedule(state: State<'_, AppState>, id: String) -> CmdResult<ScheduleList> {
    let svc = &state.service;
    let path = path(svc);
    let mut all = Schedules::load(&path)?;
    all.schedules.retain(|s| s.id != id);
    all.save(&path)?;
    list(&state)
}

/// The input variables without a default that the schedule gives no value
/// (a file trigger fills its `input` with the file's path); every run would
/// fail with `MISSING_INPUT` otherwise.
fn missing_inputs(vars: &[VariableDef], schedule: &Schedule) -> Option<String> {
    let from_file = match &schedule.when {
        When::FileAdded { input, .. } | When::MailReceived { input, .. } => input.as_deref(),
        _ => None,
    };
    let missing: Vec<&str> = vars
        .iter()
        .filter(|v| v.direction.is_input() && v.default.is_none())
        .filter(|v| Some(v.name.as_str()) != from_file)
        .filter(|v| {
            schedule
                .inputs
                .get(&v.name)
                .is_none_or(|x| x.is_null() || x == "")
        })
        .map(|v| v.name.as_str())
        .collect();
    (!missing.is_empty()).then(|| format!("give a value to the input {}", missing.join(", ")))
}

async fn status(svc: &FlowService) -> CmdResult<Option<AgentStatus>> {
    match ipc::call(svc.store().local_root(), &Request::Status).await {
        Ok(response) => Ok(response.status),
        Err(e) if ipc::not_running(&e) => Ok(None),
        Err(e) => Err(err("AGENT_UNREACHABLE", e.to_string())),
    }
}

/// The agent of this PC and workspace; none when it is not running.
#[tauri::command]
pub async fn agent_status(state: State<'_, AppState>) -> CmdResult<Option<AgentStatus>> {
    status(&state.service).await
}

/// Starts the agent. On Windows it is registered to start at every sign-in
/// too (`spellsheet agent install`), since schedules are meant to fire
/// without Studio; elsewhere it is started for this session.
#[tauri::command]
pub async fn start_agent(state: State<'_, AppState>) -> CmdResult<Option<AgentStatus>> {
    let svc = &state.service;
    if let Some(running) = status(svc).await? {
        return Ok(Some(running));
    }
    let cli = crate::agent::cli_path().ok_or_else(|| {
        err(
            "CLI_NOT_FOUND",
            "the spellsheet command is not next to Writer or on PATH",
        )
    })?;
    let workspace = svc.store().root().to_path_buf();
    let mut command = tokio::process::Command::new(&cli);
    command
        .arg("--workspace")
        .arg(&workspace)
        .arg("agent")
        .arg(if cfg!(windows) { "install" } else { "run" })
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    if cfg!(windows) {
        let out = command
            .output()
            .await
            .map_err(|e| err("AGENT_START_FAILED", e.to_string()))?;
        if !out.status.success() {
            let text = String::from_utf8_lossy(&out.stderr).trim().to_owned();
            return Err(err("AGENT_START_FAILED", text));
        }
    } else {
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .map_err(|e| err("AGENT_START_FAILED", e.to_string()))?;
    }
    // It answers on its pipe once it has read the schedules.
    for _ in 0..50 {
        if let Some(running) = status(svc).await? {
            return Ok(Some(running));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(err(
        "AGENT_START_FAILED",
        "the agent did not answer within 5 seconds (see `spellsheet agent run` in a terminal)",
    ))
}

/// Stops the agent; runs in progress are cancelled. Registered with
/// `agent install`, it starts again at the next sign-in.
#[tauri::command]
pub async fn stop_agent(state: State<'_, AppState>) -> CmdResult<()> {
    match ipc::call(state.service.store().local_root(), &Request::Stop).await {
        Ok(_) => Ok(()),
        Err(e) if ipc::not_running(&e) => Ok(()),
        Err(e) => Err(err("AGENT_UNREACHABLE", e.to_string())),
    }
}

#[cfg(windows)]
fn is_remote() -> bool {
    shikigami_desktop::session::is_remote()
}

#[cfg(not(windows))]
fn is_remote() -> bool {
    false
}

/// 「画面を残して切断」: ends this Remote Desktop connection without locking
/// the session, so desktop flows keep running (docs/schedules.md).
#[tauri::command]
pub fn release_remote_session() -> CmdResult<()> {
    #[cfg(windows)]
    {
        shikigami_desktop::session::release_to_console()
            .map_err(|e| err("SESSION_RELEASE_FAILED", e))
    }
    #[cfg(not(windows))]
    {
        Err(err("SESSION_RELEASE_FAILED", "only on Windows"))
    }
}
