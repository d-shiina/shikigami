//! Shikigami RPA Runtime.
//!
//! Executes flows without any AI and without the GUI. Studio, the MCP
//! server and the CLI embed the same [`Runtime`]; automation adapters plug in
//! by registering a step type definition together with an [`ActionHandler`].

// RunError carries rich diagnostics by design; it only travels on the cold
// failure path, so boxing it would add noise without a measurable benefit.
#![allow(clippy::result_large_err)]

pub mod adapter;
pub mod audit;
pub mod builtin;
pub mod debug;
pub mod event;
mod exec;
pub mod handler;
pub mod node;
pub mod record;
mod runlog;
pub mod sidecar;
pub mod single;
pub mod start;
pub mod testing;
mod used_secrets;

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use shikigami_core::policy::{Policy, TargetDef};
use shikigami_core::registry::builtin as builtin_types;
use shikigami_core::secret::SecretProvider;
use shikigami_core::{
    Flow, FlowId, OnError, RunId, StepId, StepRegistry, StepTypeDef, Subflow, Validator,
};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use adapter::Adapter;
pub use debug::{DebugCommand, DebugControl, DebugOptions, PauseReason, ResumeAction};
pub use event::{
    LogLevel, RunError, RunEvent, RunEventEnvelope, RunOrigin, RunReport, RunSnapshot, RunStatus,
    RunTrigger, StepOutcome, SubflowRef,
};
pub use exec::{DesktopProbe, KeepAwake};
pub use handler::{ActionHandler, ActionInput, BoxFuture, StepError};
pub use shikigami_core::resource::{DESKTOP_INPUT, ResourceDef, ResourceKind};

use exec::{Emitter, Executor, ResourceLocks};

/// Options for a single run.
#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    /// Values for input variables.
    pub inputs: Map<String, Value>,
    /// Use a specific run ID (otherwise one is generated).
    pub run_id: Option<RunId>,
    /// Skip the run-finished hooks so adapter state (open browser contexts,
    /// ...) survives the run. Used to try single steps from MCP in one
    /// session: pass the same `run_id` each time.
    pub keep_adapter_state: bool,
    /// Named version whose content is being run, recorded in the report
    /// (see `FlowService::matching_version`).
    pub version: Option<u32>,
    /// Make this an interactive run that can pause (Studio). Unattended
    /// runs leave it unset and fail as usual. See [`debug`].
    pub debug: Option<DebugOptions>,
    /// The flows its `flow.call` steps may run (see
    /// `FlowService::subflows`). The run uses them as given, so
    /// edits made while it runs do not affect it.
    pub subflows: Vec<Subflow>,
    /// The flow's folder (`FlowService::project_dir`): relative paths
    /// in path params (`StepTypeDef::path_params`) are resolved from it.
    /// Without it they are left as written.
    pub project_dir: Option<PathBuf>,
    /// A run of the whole flow, as opposed to a single step an AI tries:
    /// it starts with each flow's `work/` folder emptied (unless its
    /// settings say `keepWork`) and writes a readable log to `logs/`.
    pub full_run: bool,
    /// Who asked for the run, from where (recorded; `machine` is filled in).
    pub origin: RunOrigin,
    /// 「ここから実行」: start at this step; the steps before it do not run
    /// (see [`start`]). `work/` is then kept as it is, since the steps
    /// before may have left files there.
    pub start_at: Option<StepId>,
    /// With `start_at`: values the flow's variables start with instead of
    /// their defaults (what an earlier run left), for the steps before the
    /// start that did not run. Unknown names and secret variables are
    /// ignored.
    pub start_values: Map<String, Value>,
}

/// The execution engine. Cheap to clone; share one per process.
#[derive(Clone)]
pub struct Runtime {
    registry: StepRegistry,
    handlers: Arc<HashMap<String, Arc<dyn ActionHandler>>>,
    resource_defs: Arc<HashMap<String, Vec<ResourceDef>>>,
    path_params: Arc<HashMap<String, Vec<String>>>,
    run_finished_hooks: Arc<Vec<RunFinishedHook>>,
    validator: Arc<Validator>,
    resources: Arc<ResourceLocks>,
    default_timeouts: Arc<HashMap<String, u64>>,
    secrets: Option<Arc<dyn SecretProvider>>,
    /// Params naming sites and programs, per step type.
    target_defs: Arc<HashMap<String, Vec<TargetDef>>>,
    /// `policy.json` of the workspace, read when each run starts.
    policy_path: Option<Arc<PathBuf>>,
}

impl Runtime {
    /// Runtime with the built-in step types (control flow, variables, log, delay).
    pub fn new() -> Self {
        RuntimeBuilder::new().build()
    }

    pub fn builder() -> RuntimeBuilder {
        RuntimeBuilder::new()
    }

    /// Makes [`DESKTOP_INPUT`] exclusive across every process on this PC that
    /// uses the same `dir` for its lock files (Studio, the MCP server, the
    /// CLI and the agent use [`default_pc_lock_dir`]). Call before starting
    /// runs.
    pub fn with_pc_locks(mut self, dir: PathBuf) -> Self {
        self.resources = Arc::new(exec::ResourceLocks {
            pc_lock_dir: Some(dir),
            desktop_probe: self.resources.desktop_probe.clone(),
            keep_awake: self.resources.keep_awake.clone(),
            ..exec::ResourceLocks::default()
        });
        self
    }

    /// Whether a node of `flow` or of a flow it can call takes
    /// [`DESKTOP_INPUT`].
    fn uses_input(&self, flow: &Flow, library: &HashMap<FlowId, Arc<Flow>>) -> bool {
        std::iter::once(flow)
            .chain(library.values().map(|f| &**f))
            .flat_map(Flow::walk)
            .any(|step| {
                self.resource_defs.get(&step.step_type).is_some_and(|defs| {
                    defs.iter()
                        .any(|d| matches!(d, ResourceDef::Static(name) if name == DESKTOP_INPUT))
                })
            })
    }

    /// Whether the screen can be used now (signed in, not locked): `None`
    /// when this runtime has no way to tell (no desktop adapter).
    pub fn desktop_available(&self) -> Option<bool> {
        self.resources
            .desktop_probe
            .as_ref()
            .map(|probe| probe().is_none())
    }

    /// Where steps look up registered secrets (`{ "secret": .., "field": .. }`
    /// params) and saved browser logins: the workspace vault.
    pub fn with_secrets(mut self, secrets: Arc<dyn SecretProvider>) -> Self {
        self.secrets = Some(secrets);
        self
    }

    /// The workspace policy file (`policy.json`) whose `sites` and `apps`
    /// every run is held to. It is read when each run starts, so changes
    /// apply to the next run; a broken file stops runs (`POLICY_INVALID`).
    pub fn with_policy(mut self, path: PathBuf) -> Self {
        self.policy_path = Some(Arc::new(path));
        self
    }

    /// Binds the runtime to a workspace: its secrets (the vault opened at
    /// `root`) and its `policy.json`. Every process that runs flows of a
    /// workspace (Studio, the MCP server, `shikigami run`, `shikigami
    /// agent`) builds its runtime with this one call, so something a
    /// workspace run needs is added here once, not in each of them.
    pub fn for_workspace(self, root: &std::path::Path, secrets: Arc<dyn SecretProvider>) -> Self {
        self.with_secrets(secrets).with_policy(Policy::path(root))
    }

    /// Step types this runtime can execute. Use the same registry for the
    /// `FlowService` so validation and execution agree.
    pub fn registry(&self) -> &StepRegistry {
        &self.registry
    }

    /// Validates and starts a run on the current Tokio runtime.
    pub fn start(&self, flow: Flow, options: RunOptions) -> Result<RunHandle, RunError> {
        let library: HashMap<FlowId, Arc<Flow>> = options
            .subflows
            .iter()
            .map(|s| {
                let mut called = s.flow.clone();
                called.inline_parts();
                (s.flow.id.clone(), Arc::new(called))
            })
            .collect();
        let project_dirs: HashMap<FlowId, PathBuf> = options
            .subflows
            .iter()
            .filter_map(|s| Some((s.flow.id.clone(), s.project_dir.clone()?)))
            .collect();
        let report = self
            .validator
            .validate_with_calls(&flow, &|id| library.get(id).map(|s| (**s).clone()));
        if !report.valid {
            return Err(RunError {
                details: serde_json::to_value(&report).ok(),
                ..RunError::new("VALIDATION_FAILED", "the flow has validation errors")
            });
        }
        // Nodes that name a part run with its target.
        let mut flow = flow;
        flow.inline_parts();
        // Variables an earlier run can hand to 「ここから実行」: every name
        // the whole flow can bind (inputs, saveAs, call outputs…), not secrets.
        let restorable: BTreeSet<String> = match &options.start_at {
            Some(_) => {
                let secret: BTreeSet<&str> = flow
                    .variables
                    .iter()
                    .filter(|v| v.secret)
                    .map(|v| v.name.as_str())
                    .collect();
                shikigami_core::validate::known_variables(&flow, &self.registry)
                    .into_iter()
                    .filter(|n| !secret.contains(n.as_str()))
                    .collect()
            }
            None => BTreeSet::new(),
        };
        let start_step = match &options.start_at {
            Some(id) => {
                flow.steps = start::steps_from(&flow.steps, id)?;
                Some(id.clone())
            }
            None => None,
        };
        let start_values = options.start_values.clone();
        // A run with nodes that use the mouse and keyboard keeps the screen
        // on and the PC awake until it ends.
        let awake = self
            .resources
            .keep_awake
            .as_ref()
            .filter(|_| self.uses_input(&flow, &library))
            .map(|keep| keep());

        let policy = match &self.policy_path {
            Some(path) => Policy::load(path).map_err(|e| RunError {
                details: e.details(),
                ..RunError::new(e.code(), e.to_string())
            })?,
            None => Policy::default(),
        };

        let run_id = options.run_id.unwrap_or_else(RunId::generate);
        let (tx, rx) = mpsc::unbounded_channel();
        let snapshot = Arc::new(Mutex::new(RunSnapshot {
            run_id: run_id.clone(),
            flow_id: flow.id.clone(),
            status: RunStatus::Pending,
            current_step: None,
            steps_executed: 0,
        }));
        let log = match (&options.project_dir, options.full_run) {
            (Some(dir), true) => runlog::RunLog::create(
                dir,
                std::iter::once(&flow).chain(library.values().map(|s| &**s)),
                &self.registry,
            ),
            _ => None,
        };
        let emitter = Emitter::new(run_id.clone(), tx, snapshot.clone(), log);
        // Folders whose `work/` the run starts empty.
        let fresh_work: Vec<PathBuf> =
            if options.full_run && options.start_at.is_none() {
                options
                    .project_dir
                    .iter()
                    .filter(|_| !flow.settings.keep_work)
                    .cloned()
                    .chain(options.subflows.iter().filter_map(|s| {
                        s.project_dir.clone().filter(|_| !s.flow.settings.keep_work)
                    }))
                    .collect()
            } else {
                Vec::new()
            };
        let cancel = CancellationToken::new();
        let force = CancellationToken::new();
        let debugger = options.debug.map(|debug| {
            Arc::new(debug::Debugger::new(
                debug,
                flow.clone(),
                self.validator.clone(),
                start_step.clone(),
            ))
        });

        // Names of the secrets the run uses, for its report.
        let (run_secrets, secrets_used) = match self.secrets.clone() {
            Some(inner) => {
                let (wrapped, used) = used_secrets::Recording::wrap(inner);
                (Some(wrapped), Some(used))
            }
            None => (None, None),
        };
        let mut executor = Executor::new_from(
            &flow,
            Executor {
                run_id: run_id.clone(),
                handlers: self.handlers.clone(),
                resource_defs: self.resource_defs.clone(),
                path_params: self.path_params.clone(),
                project_dir: options.project_dir.clone().map(Arc::from),
                project_dirs: Arc::new(project_dirs),
                default_timeouts: self.default_timeouts.clone(),
                secrets: run_secrets.clone(),
                vars: Map::new(),
                secret_vars: flow
                    .variables
                    .iter()
                    .filter(|v| v.secret)
                    .map(|v| v.name.clone())
                    .collect(),
                iteration: None,
                emitter: emitter.clone(),
                cancel: cancel.clone(),
                force: force.clone(),
                default_timeout_ms: exec::DEFAULT_TIMEOUT_MS,
                default_retry: None,
                default_on_error: OnError::Fail,
                resources: self.resources.clone(),
                debug: debugger.clone(),
                in_call: None,
                handled_depth: 0,
                library: Arc::new(library),
                target_defs: self.target_defs.clone(),
                policy: Arc::new(policy),
            },
        );
        let mut inputs = options.inputs;
        if start_step.is_some() {
            // Inputs the earlier run had count as given (and are checked).
            for var in flow.variables.iter().filter(|v| v.direction.is_input()) {
                if restorable.contains(&var.name)
                    && !inputs.contains_key(&var.name)
                    && let Some(value) = start_values.get(&var.name)
                {
                    inputs.insert(var.name.clone(), value.clone());
                }
            }
        }
        let subflows: Vec<SubflowRef> = options
            .subflows
            .iter()
            .map(|s| SubflowRef {
                flow_id: s.flow.id.clone(),
                flow_name: s.flow.name.clone(),
                revision: s.flow.revision,
                version: s.version,
            })
            .collect();

        let task_run_id = run_id.clone();
        let version = options.version;
        let mut origin = options.origin;
        if origin.machine.is_none() {
            origin.machine = event::machine_name();
        }
        let secrets = run_secrets;
        let hooks = if options.keep_adapter_state {
            Arc::new(Vec::new())
        } else {
            self.run_finished_hooks.clone()
        };
        let join = tokio::spawn(async move {
            let _awake = awake;
            let started_at = OffsetDateTime::now_utc();
            let clock = Instant::now();
            emitter.update_snapshot(|s| s.status = RunStatus::Running);
            emitter.emit(RunEvent::RunStarted {
                flow_id: flow.id.clone(),
                flow_name: flow.name.clone(),
                revision: flow.revision,
                origin: origin.clone(),
            });

            let (_lease, busy) = WorkLease::take(&fresh_work);
            for dir in &fresh_work {
                if busy.contains(dir) {
                    emitter.emit(RunEvent::Log {
                        level: LogLevel::Info,
                        message: format!(
                            "work/ in {} is not emptied: another run is using it",
                            dir.display()
                        ),
                        step_id: None,
                    });
                    continue;
                }
                for problem in shikigami_core::project::clear_work(dir) {
                    emitter.emit(RunEvent::Log {
                        level: LogLevel::Warn,
                        message: problem,
                        step_id: None,
                    });
                }
            }

            // After `runStarted`, so the inputs' `variableChanged` events
            // come first in the run.
            let init = init_variables(&flow, &inputs, &mut executor);
            if init.is_ok()
                && let Some(start) = &start_step
            {
                for (name, value) in &start_values {
                    if restorable.contains(name) && !inputs.contains_key(name) {
                        executor.set_var(name, value.clone(), None);
                    }
                }
                let name = flow
                    .steps
                    .first()
                    .map(|s| {
                        if s.id == *start {
                            s.name.clone()
                        } else {
                            String::new()
                        }
                    })
                    .filter(|n| !n.is_empty())
                    .map_or_else(|| start.to_string(), |n| format!("「{n}」"));
                emitter.emit(RunEvent::Log {
                    level: LogLevel::Info,
                    message: format!("{name}から実行します（前のノードは実行しません）"),
                    step_id: Some(start.clone()),
                });
            }
            let result = match init {
                Ok(()) => executor.top_block(&flow.steps).await,
                Err(e) => Err(exec::Interrupt::Failed(e)),
            };
            let (status, mut error) = exec::final_status(&result);
            // While the browser or window is still open (the hooks below close them).
            if let Some(error) = error.as_mut() {
                executor.capture_failure(&flow, error).await;
            }
            let error = error.map(|e| emitter.mask_error(e));

            let outputs: Map<String, Value> = flow
                .variables
                .iter()
                .filter(|v| v.direction.is_output())
                .map(|v| {
                    let value = executor.vars.get(&v.name).cloned().unwrap_or(Value::Null);
                    let value = if v.secret {
                        Value::String("***".into())
                    } else {
                        // Also hides secrets a step happened to read back.
                        emitter.mask_value(&value)
                    };
                    (v.name.clone(), value)
                })
                .collect();

            // Release per-run adapter state (browser contexts, ...). An
            // adapter that does not answer must not keep a stopped run open.
            for hook in hooks.iter() {
                let end = hook(RunEnd {
                    run_id: task_run_id.clone(),
                    secrets: secrets.clone(),
                });
                if tokio::time::timeout(RUN_END_HOOK_LIMIT, end).await.is_err() {
                    tracing::warn!("an adapter did not finish closing the run in time");
                }
            }

            let duration_ms = u64::try_from(clock.elapsed().as_millis()).unwrap_or(u64::MAX);
            emitter.update_snapshot(|s| {
                s.status = status;
                s.current_step = None;
            });
            emitter.emit(RunEvent::RunFinished {
                status,
                error: error.clone(),
                duration_ms,
            });
            emitter.finish_log(status);

            RunReport {
                run_id: task_run_id,
                flow_id: flow.id,
                flow_name: flow.name,
                revision: flow.revision,
                version,
                status,
                started_at,
                finished_at: OffsetDateTime::now_utc(),
                error,
                outputs,
                subflows,
                origin,
                secrets_used: secrets_used
                    .and_then(|used| used.lock().ok().map(|u| u.iter().cloned().collect()))
                    .unwrap_or_default(),
            }
        });

        Ok(RunHandle {
            run_id,
            stopper: Stopper { cancel, force },
            events: rx,
            debug: debugger.map(|inner| DebugControl {
                inner,
                snapshot: snapshot.clone(),
            }),
            snapshot,
            join,
        })
    }
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

/// The lock folder shared by every Shikigami process of this Windows user.
pub fn default_pc_lock_dir() -> PathBuf {
    std::env::temp_dir().join("shikigami-locks")
}

/// Called once when a run ends (after its last step, before `RunFinished`).
/// How long one adapter may take to close what a finished run left open.
const RUN_END_HOOK_LIMIT: Duration = Duration::from_secs(15);

pub type RunFinishedHook = Arc<dyn Fn(RunEnd) -> BoxFuture<'static, ()> + Send + Sync>;

/// What a [`RunFinishedHook`] gets.
pub struct RunEnd {
    pub run_id: RunId,
    /// The Runtime's secret store, e.g. to save browser logins for reuse.
    pub secrets: Option<Arc<dyn SecretProvider>>,
}

pub struct RuntimeBuilder {
    registry: StepRegistry,
    handlers: HashMap<String, Arc<dyn ActionHandler>>,
    run_finished_hooks: Vec<RunFinishedHook>,
    desktop_probe: Option<exec::DesktopProbe>,
    keep_awake: Option<exec::KeepAwake>,
}

impl RuntimeBuilder {
    /// How a run that has nodes using the mouse and keyboard keeps the
    /// screen from turning off and the PC from sleeping while it runs (installed by the
    /// desktop adapter).
    pub fn keep_awake(mut self, keep: KeepAwake) -> Self {
        self.keep_awake = Some(keep);
        self
    }

    /// How steps that take [`DESKTOP_INPUT`] find out whether the desktop
    /// can take input now (installed by the desktop adapter). Without it they
    /// just try.
    pub fn desktop_probe(mut self, probe: DesktopProbe) -> Self {
        self.desktop_probe = Some(probe);
        self
    }

    pub fn new() -> Self {
        let mut builder = Self {
            registry: StepRegistry::with_builtins(),
            handlers: HashMap::new(),
            run_finished_hooks: Vec::new(),
            desktop_probe: None,
            keep_awake: None,
        };
        builder.handlers.insert(
            builtin_types::LOG_MESSAGE.into(),
            Arc::new(builtin::LogMessage),
        );
        builder
            .handlers
            .insert(builtin_types::FLOW_DELAY.into(), Arc::new(builtin::Delay));
        builder
    }

    /// Registers an adapter step type and its handler.
    pub fn register(mut self, def: StepTypeDef, handler: impl ActionHandler) -> Self {
        self.handlers
            .insert(def.step_type.clone(), Arc::new(handler));
        self.registry.register(def);
        self
    }

    /// Installs an adapter's step types (see [`adapter::Adapter`]).
    pub fn adapter(self, adapter: &dyn adapter::Adapter) -> Self {
        adapter.install(self)
    }

    /// Registers cleanup to run when each run ends, e.g. closing the
    /// browser contexts an adapter opened for it.
    pub fn on_run_finished(mut self, hook: RunFinishedHook) -> Self {
        self.run_finished_hooks.push(hook);
        self
    }

    pub fn build(self) -> Runtime {
        Runtime {
            validator: Arc::new(Validator::new(self.registry.clone())),
            handlers: Arc::new(self.handlers),
            resource_defs: Arc::new(
                self.registry
                    .iter()
                    .filter(|def| !def.resources.is_empty())
                    .map(|def| (def.step_type.clone(), def.resources.clone()))
                    .collect(),
            ),
            path_params: Arc::new(
                self.registry
                    .iter()
                    .filter(|def| !def.path_params.is_empty())
                    .map(|def| (def.step_type.clone(), def.path_params.clone()))
                    .collect(),
            ),
            resources: Arc::new(exec::ResourceLocks {
                desktop_probe: self.desktop_probe,
                keep_awake: self.keep_awake,
                ..exec::ResourceLocks::default()
            }),
            default_timeouts: Arc::new(
                self.registry
                    .iter()
                    .filter_map(|def| Some((def.step_type.clone(), def.default_timeout_ms?)))
                    .collect(),
            ),
            secrets: None,
            target_defs: Arc::new(
                self.registry
                    .iter()
                    .filter(|def| !def.targets.is_empty())
                    .map(|def| (def.step_type.clone(), def.targets.clone()))
                    .collect(),
            ),
            policy_path: None,
            run_finished_hooks: Arc::new(self.run_finished_hooks),
            registry: self.registry,
        }
    }
}

impl Default for RuntimeBuilder {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn init_variables(
    flow: &Flow,
    inputs: &Map<String, Value>,
    executor: &mut Executor,
) -> Result<(), RunError> {
    for name in inputs.keys() {
        if !flow
            .variables
            .iter()
            .any(|v| &v.name == name && v.direction.is_input())
        {
            return Err(RunError::new(
                "UNKNOWN_INPUT",
                format!("'{name}' is not an input variable"),
            ));
        }
    }
    let mut values = Vec::with_capacity(flow.variables.len());
    for var in &flow.variables {
        let value = match inputs.get(&var.name) {
            Some(value) if var.direction.is_input() => {
                if !var.var_type.accepts(value) {
                    return Err(RunError::new(
                        "INVALID_INPUT",
                        format!("input '{}' must be of type {:?}", var.name, var.var_type),
                    ));
                }
                value.clone()
            }
            _ => match &var.default {
                Some(default) => default.clone(),
                None if var.direction.is_input() => {
                    return Err(RunError {
                        details: Some(serde_json::json!({ "input": var.name })),
                        ..RunError::new(
                            "MISSING_INPUT",
                            format!("input '{}' is required", var.name),
                        )
                    });
                }
                None => Value::Null,
            },
        };
        values.push((var, value));
    }
    // Know every secret before the first value is reported, so a secret
    // copied into an earlier-declared input is masked too.
    for (var, value) in &values {
        if var.secret {
            executor.emitter.add_secret(value);
        }
    }
    for (var, value) in values {
        executor.set_var(&var.name, value, None);
    }
    Ok(())
}

/// Stops a run: the first `stop` cancels it (a `finally` block still
/// gets up to a minute to clean up), a second one also ends that clean-up.
#[derive(Clone)]
pub struct Stopper {
    cancel: CancellationToken,
    force: CancellationToken,
}

impl Stopper {
    pub fn stop(&self) {
        if self.cancel.is_cancelled() {
            self.force.cancel();
        } else {
            self.cancel.cancel();
        }
    }

    /// Whether a stop was asked for.
    pub fn is_stopped(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

/// Handle to a running flow.
pub struct RunHandle {
    pub run_id: RunId,
    stopper: Stopper,
    events: mpsc::UnboundedReceiver<RunEventEnvelope>,
    debug: Option<DebugControl>,
    snapshot: Arc<Mutex<RunSnapshot>>,
    join: JoinHandle<RunReport>,
}

impl RunHandle {
    /// Requests cancellation. The current step is interrupted and the run
    /// finishes with status `cancelled`. Calling it again also cuts short
    /// the `finally` blocks that run after a stop.
    pub fn cancel(&self) {
        self.stopper.stop();
    }

    /// A token that cancels this run when triggered.
    pub fn cancel_token(&self) -> CancellationToken {
        self.stopper.cancel.clone()
    }

    /// What stop buttons and MCP `stop_flow` hold (see [`Stopper`]).
    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }

    /// Pause / step / resume controls; `None` unless started with
    /// [`RunOptions::debug`].
    pub fn debug_control(&self) -> Option<DebugControl> {
        self.debug.clone()
    }

    pub fn snapshot(&self) -> Option<RunSnapshot> {
        self.snapshot.lock().ok().map(|s| s.clone())
    }

    /// Shared live-status cell (for registries of active runs).
    pub fn snapshot_cell(&self) -> Arc<Mutex<RunSnapshot>> {
        self.snapshot.clone()
    }

    /// Next event, or `None` once the run has finished and all events were read.
    pub async fn next_event(&mut self) -> Option<RunEventEnvelope> {
        self.events.recv().await
    }

    /// Waits for completion, invoking `on_event` for every event in order.
    pub async fn wait_with(
        mut self,
        mut on_event: impl FnMut(&RunEventEnvelope),
    ) -> Result<RunReport, RunError> {
        while let Some(event) = self.events.recv().await {
            on_event(&event);
        }
        self.join
            .await
            .map_err(|e| RunError::new("RUNTIME_PANIC", format!("run task failed: {e}")))
    }

    pub async fn wait(self) -> Result<RunReport, RunError> {
        self.wait_with(|_| {}).await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod call_tests;

/// JSON Schema of the run API types (events, reports, snapshots), exported
/// next to the core schemas for TypeScript generation.
pub fn run_api_schema() -> Value {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    #[schemars(rename = "ShikigamiRunApi")]
    struct RunApi {
        run_event_envelope: RunEventEnvelope,
        run_report: RunReport,
        run_snapshot: RunSnapshot,
        debug_command: DebugCommand,
        case_result: testing::CaseResult,
    }
    let mut value = serde_json::to_value(schemars::schema_for!(RunApi)).unwrap_or(Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "$id".into(),
            Value::String("https://shikigami.dev/schemas/run-api.schema.json".into()),
        );
    }
    value
}

/// The project folders whose `work/` a run in this process is using: a run
/// that starts while another uses the same folder (the same flow twice,
/// or a sub-flow two callers share) leaves `work/` alone.
static WORK_IN_USE: std::sync::Mutex<Vec<(std::path::PathBuf, usize)>> =
    std::sync::Mutex::new(Vec::new());

struct WorkLease(Vec<std::path::PathBuf>);

impl WorkLease {
    /// Marks `dirs` in use until the lease drops; returns those another run
    /// was already using.
    fn take(dirs: &[std::path::PathBuf]) -> (Self, Vec<std::path::PathBuf>) {
        let mut busy = Vec::new();
        let mut used = WORK_IN_USE.lock().unwrap_or_else(|e| e.into_inner());
        for dir in dirs {
            match used.iter_mut().find(|(d, _)| d == dir) {
                Some((_, n)) => {
                    if *n > 0 {
                        busy.push(dir.clone());
                    }
                    *n += 1;
                }
                None => used.push((dir.clone(), 1)),
            }
        }
        (Self(dirs.to_vec()), busy)
    }
}

impl Drop for WorkLease {
    fn drop(&mut self) {
        let mut used = WORK_IN_USE.lock().unwrap_or_else(|e| e.into_inner());
        for dir in &self.0 {
            if let Some((_, n)) = used.iter_mut().find(|(d, _)| d == dir) {
                *n = n.saturating_sub(1);
            }
        }
        used.retain(|(_, n)| *n > 0);
    }
}
