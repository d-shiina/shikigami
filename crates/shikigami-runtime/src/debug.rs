//! Interactive runs: pausing, stepping and resuming after a fix.
//!
//! A run started with [`DebugOptions`] stops where a person can look at it
//! instead of ending quietly: before a step with a breakpoint, after a step
//! command, and when a step fails with an error nothing in the scenario
//! handles (no `try` / `catch` around it, no `onError: continue`). While it
//! is paused nothing runs, no timeout counts and adapter state (the open
//! browser, ...) stays as it is.
//!
//! The scenario may change while a run is paused, e.g. an AI fixed the step
//! that failed. [`DebugControl::update_scenario`] swaps in the new revision
//! when it fits the paused position: every block the run is inside of still
//! exists under the same steps, and the step each block last finished is
//! still there. From then on the run reads step definitions from the new
//! revision: a retried step runs as it is now, steps inserted in front of
//! it run first, and later steps run as edited. Variables keep their
//! values; newly declared ones get their defaults. Control steps already
//! running (a loop's condition, a `forEach`'s items) keep what they read
//! when they started.
//!
//! Only the run's main line pauses. Parallel branches and concurrent
//! `forEach` iterations run to completion; an error in them pauses at the
//! `control.parallel` / `control.forEach` step, and a retry runs that step
//! again as a whole.
//!
//! Unattended runs (CLI, scheduler, MCP) do not pass [`DebugOptions`] and
//! fail as before.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use shikigami_core::{Scenario, Step, StepId, Validator};
use tokio::sync::Notify;

use crate::event::{RunError, RunStatus};

/// How an interactive run pauses. See the module docs.
#[derive(Debug, Clone, Default)]
pub struct DebugOptions {
    /// Pause when a step fails with an error the scenario does not handle.
    pub pause_on_error: bool,
    /// Pause before these steps.
    pub breakpoints: Vec<StepId>,
    /// Pause before the first step (start in single-step mode).
    pub pause_at_start: bool,
}

/// Why a run paused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    /// Before a step with a breakpoint.
    Breakpoint,
    /// Before the next step after a step command or at the start.
    Step,
    /// Before the next step after [`DebugCommand::Pause`].
    Requested,
    /// After the step failed (`error` says why); it has not been handled.
    Error,
}

/// What a person does with a run (see [`DebugControl::send`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DebugCommand {
    /// Run until the next breakpoint or unhandled error. Paused on an
    /// error: run the failed step again first.
    Continue,
    /// Run the step paused at, including everything inside it, and pause
    /// before the next one at the same level or above.
    StepOver,
    /// Pause before the very next step, inside blocks too.
    StepInto,
    /// Finish the block paused in and pause after it.
    StepOut,
    /// Paused on an error: run the failed step again, as it is now defined.
    Retry,
    /// Leave the step paused at (or failed) undone and go on with the next.
    Skip,
    /// End the run: as failed when paused on an error, otherwise as cancelled.
    Abort,
    /// While running: pause before the next step.
    Pause,
    /// Replace the breakpoints (any time).
    SetBreakpoints { step_ids: Vec<StepId> },
}

impl DebugCommand {
    /// Commands that end a pause.
    fn resumes(&self) -> bool {
        !matches!(self, Self::Pause | Self::SetBreakpoints { .. })
    }
}

/// What a resumed run does next (reported as `resumed`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ResumeAction {
    Continue,
    StepOver,
    StepInto,
    StepOut,
    Retry,
    Skip,
    Abort,
}

/// One block the run is executing: the steps of `key`, after `prev`.
#[derive(Debug, Clone)]
pub(crate) struct Frame {
    pub key: BlockKey,
    /// The last step in this block that finished (`None`: none yet).
    pub prev: Option<StepId>,
    /// The step in this block that is running or about to.
    pub current: Option<StepId>,
}

/// A step list: the scenario's top level or a control step's block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BlockKey {
    Top,
    Child { parent: StepId, name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Run,
    StepInto,
    StepOver(usize),
    StepOut(usize),
}

struct State {
    mode: Mode,
    breakpoints: HashSet<StepId>,
    pause_requested: bool,
    /// Set while paused: whether it is on an error.
    paused: Option<PauseReason>,
    resume: Option<DebugCommand>,
    frames: Vec<Frame>,
    scenario: Arc<Scenario>,
    /// A newer revision was swapped in and the executor has not caught up
    /// with its variables and settings yet.
    updated: bool,
    /// A step to run without pausing before it once more: the one a pause
    /// just resumed, read again from the current revision.
    skip_once: Option<StepId>,
    /// An error the person chose to let end the run; the steps it passes
    /// through on the way out must not pause on it again.
    given_up: Option<RunError>,
}

/// Shared between the run task (pausing) and [`DebugControl`] (commands).
pub(crate) struct Debugger {
    pause_on_error: bool,
    state: Mutex<State>,
    wake: Notify,
    validator: Arc<Validator>,
}

impl Debugger {
    pub(crate) fn new(
        options: DebugOptions,
        scenario: Scenario,
        validator: Arc<Validator>,
    ) -> Self {
        Self {
            pause_on_error: options.pause_on_error,
            state: Mutex::new(State {
                mode: if options.pause_at_start {
                    Mode::StepInto
                } else {
                    Mode::Run
                },
                breakpoints: options.breakpoints.into_iter().collect(),
                pause_requested: false,
                paused: None,
                resume: None,
                frames: Vec::new(),
                scenario: Arc::new(scenario),
                updated: false,
                skip_once: None,
                given_up: None,
            }),
            wake: Notify::new(),
            validator,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub(crate) fn pause_on_error(&self) -> bool {
        self.pause_on_error
    }

    pub(crate) fn scenario(&self) -> Arc<Scenario> {
        self.state().scenario.clone()
    }

    pub(crate) fn push_frame(&self, key: BlockKey) {
        self.state().frames.push(Frame {
            key,
            prev: None,
            current: None,
        });
    }

    pub(crate) fn pop_frame(&self) {
        self.state().frames.pop();
    }

    pub(crate) fn set_current(&self, id: Option<StepId>) {
        if let Some(frame) = self.state().frames.last_mut() {
            frame.current = id;
        }
    }

    pub(crate) fn finished(&self, id: StepId) {
        if let Some(frame) = self.state().frames.last_mut() {
            frame.prev = Some(id);
            frame.current = None;
        }
    }

    pub(crate) fn is_given_up(&self, error: &RunError) -> bool {
        self.state().given_up.as_ref() == Some(error)
    }

    pub(crate) fn give_up(&self, error: RunError) {
        self.state().given_up = Some(error);
    }

    /// The next step of `key` after `prev`, as the current revision defines
    /// it. `None` at the end of the block, or when the block is gone.
    pub(crate) fn next_step(&self, key: &BlockKey, prev: Option<&StepId>) -> Option<Step> {
        let scenario = self.scenario();
        let steps = block_of(&scenario, key)?;
        let index = match prev {
            None => 0,
            Some(prev) => steps.iter().position(|s| &s.id == prev)? + 1,
        };
        steps.get(index).cloned()
    }

    /// Whether to pause before `step` (and why), given the step mode.
    pub(crate) fn should_pause(&self, step: &StepId) -> Option<PauseReason> {
        let mut state = self.state();
        if state.skip_once.take().as_ref() == Some(step) {
            return None;
        }
        let depth = state.frames.len();
        if state.pause_requested {
            state.pause_requested = false;
            return Some(PauseReason::Requested);
        }
        match state.mode {
            Mode::StepInto => Some(PauseReason::Step),
            Mode::StepOver(d) if depth <= d => Some(PauseReason::Step),
            Mode::StepOut(d) if depth < d => Some(PauseReason::Step),
            _ if state.breakpoints.contains(step) => Some(PauseReason::Breakpoint),
            _ => None,
        }
    }

    /// Marks the run paused; the caller then waits with [`Self::wait`].
    pub(crate) fn enter_pause(&self, reason: PauseReason) {
        let mut state = self.state();
        state.paused = Some(reason);
        state.resume = None;
        state.mode = Mode::Run;
    }

    /// The run stopped waiting without a command (cancelled).
    pub(crate) fn leave_pause(&self) {
        let mut state = self.state();
        state.paused = None;
        state.resume = None;
    }

    /// Waits for a resuming command.
    pub(crate) async fn wait(&self) -> DebugCommand {
        loop {
            let notified = self.wake.notified();
            {
                let mut state = self.state();
                if let Some(command) = state.resume.take() {
                    state.paused = None;
                    let depth = state.frames.len();
                    state.mode = match command {
                        DebugCommand::StepInto => Mode::StepInto,
                        DebugCommand::StepOver => Mode::StepOver(depth),
                        DebugCommand::StepOut => Mode::StepOut(depth),
                        _ => Mode::Run,
                    };
                    return command;
                }
            }
            notified.await;
        }
    }

    /// Runs `step` without pausing before it when it comes next.
    pub(crate) fn skip_pause_once(&self, step: StepId) {
        self.state().skip_once = Some(step);
    }

    /// Takes the "a newer revision was swapped in" flag.
    pub(crate) fn take_updated(&self) -> bool {
        std::mem::take(&mut self.state().updated)
    }

    fn command(&self, command: DebugCommand) -> Result<(), RunError> {
        let mut state = self.state();
        match command {
            DebugCommand::Pause => {
                if state.paused.is_none() {
                    state.pause_requested = true;
                }
            }
            DebugCommand::SetBreakpoints { step_ids } => {
                state.breakpoints = step_ids.into_iter().collect();
            }
            command => {
                debug_assert!(command.resumes());
                let Some(reason) = state.paused else {
                    return Err(RunError::new("RUN_NOT_PAUSED", "the run is not paused"));
                };
                if command == DebugCommand::Retry && reason != PauseReason::Error {
                    return Err(RunError::new(
                        "NOTHING_TO_RETRY",
                        "only a step that failed can be retried",
                    ));
                }
                state.resume = Some(command);
                drop(state);
                self.wake.notify_one();
            }
        }
        Ok(())
    }

    fn update_scenario(&self, scenario: Scenario) -> Result<bool, RunError> {
        let mut state = self.state();
        if state.paused.is_none() {
            return Err(RunError::new(
                "RUN_NOT_PAUSED",
                "the scenario can only be swapped while the run is paused",
            ));
        }
        if scenario.id != state.scenario.id {
            return Err(RunError::new(
                "SCENARIO_MISMATCH",
                "the run belongs to another scenario",
            ));
        }
        if scenario.revision == state.scenario.revision && scenario == *state.scenario {
            return Ok(false);
        }
        let report = self.validator.validate(&scenario);
        if !report.valid {
            return Err(RunError {
                details: serde_json::to_value(&report).ok(),
                ..RunError::new("VALIDATION_FAILED", "the scenario has validation errors")
            });
        }
        check_position(&state.scenario, &scenario, &state.frames)?;
        state.scenario = Arc::new(scenario);
        state.updated = true;
        Ok(true)
    }
}

/// The steps of a block in `scenario`.
pub(crate) fn block_of<'a>(scenario: &'a Scenario, key: &BlockKey) -> Option<&'a [Step]> {
    match key {
        BlockKey::Top => Some(&scenario.steps),
        BlockKey::Child { parent, name } => {
            let parent = scenario.find_step(parent)?;
            Some(parent.block(name))
        }
    }
}

/// Checks that the paused position exists in `new`: each block the run is
/// inside of hangs off the same (type of) step in the enclosing block, and
/// each block's last finished step is still in it.
fn check_position(old: &Scenario, new: &Scenario, frames: &[Frame]) -> Result<(), RunError> {
    let mismatch = |message: String| RunError {
        details: Some(serde_json::json!({ "hint": "Run the scenario again from the start." })),
        ..RunError::new("RESUME_INCOMPATIBLE", message)
    };
    for (index, frame) in frames.iter().enumerate() {
        if let BlockKey::Child { parent, .. } = &frame.key {
            let old_parent = old.find_step(parent);
            let new_parent = new.find_step(parent);
            let (Some(old_parent), Some(new_parent)) = (old_parent, new_parent) else {
                return Err(mismatch(format!(
                    "step '{parent}', which the run is inside of, was removed"
                )));
            };
            if old_parent.step_type != new_parent.step_type {
                return Err(mismatch(format!(
                    "step '{parent}', which the run is inside of, changed its type"
                )));
            }
            // It must still sit in the block that runs it.
            let enclosing = &frames[index - 1].key;
            let in_place =
                block_of(new, enclosing).is_some_and(|steps| steps.iter().any(|s| &s.id == parent));
            if !in_place {
                return Err(mismatch(format!(
                    "step '{parent}', which the run is inside of, was moved"
                )));
            }
        }
        if let Some(prev) = &frame.prev {
            let present =
                block_of(new, &frame.key).is_some_and(|steps| steps.iter().any(|s| &s.id == prev));
            if !present {
                return Err(mismatch(format!(
                    "step '{prev}', which the run already finished, was removed or moved"
                )));
            }
        }
    }
    Ok(())
}

/// Sends commands to an interactive run. Cheap to clone.
#[derive(Clone)]
pub struct DebugControl {
    pub(crate) inner: Arc<Debugger>,
    pub(crate) snapshot: Arc<Mutex<crate::RunSnapshot>>,
}

impl DebugControl {
    /// Applies a command. Resuming commands fail with `RUN_NOT_PAUSED`
    /// unless the run is paused.
    pub fn send(&self, command: DebugCommand) -> Result<(), RunError> {
        self.inner.command(command)
    }

    /// Swaps in a newer revision of the scenario while the run is paused
    /// (see the module docs). Returns whether it differed from the one in
    /// use. Fails with `RESUME_INCOMPATIBLE` when the paused position is no
    /// longer in it, or `VALIDATION_FAILED`.
    pub fn update_scenario(&self, scenario: Scenario) -> Result<bool, RunError> {
        self.inner.update_scenario(scenario)
    }

    /// The revision the run is executing.
    pub fn revision(&self) -> u64 {
        self.inner.scenario().revision
    }

    pub fn is_paused(&self) -> bool {
        self.snapshot
            .lock()
            .map(|s| s.status == RunStatus::Paused)
            .unwrap_or(false)
    }
}
