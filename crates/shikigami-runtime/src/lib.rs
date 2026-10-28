//! Shikigami RPA Runtime.
//!
//! Executes scenarios without any AI and without the GUI. Studio, the MCP
//! server and the CLI embed the same [`Runtime`]; automation adapters plug in
//! by registering a step type definition together with an [`ActionHandler`].

// RunError carries rich diagnostics by design; it only travels on the cold
// failure path, so boxing it would add noise without a measurable benefit.
#![allow(clippy::result_large_err)]

pub mod adapter;
pub mod builtin;
pub mod debug;
pub mod event;
mod exec;
pub mod handler;
pub mod node;
pub mod record;
pub mod sidecar;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{Map, Value};
use shikigami_core::policy::{Policy, TargetDef};
use shikigami_core::registry::builtin as builtin_types;
use shikigami_core::secret::SecretProvider;
use shikigami_core::{
    OnError, RunId, Scenario, ScenarioId, StepRegistry, StepTypeDef, Subscenario, Validator,
};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use adapter::Adapter;
pub use debug::{DebugCommand, DebugControl, DebugOptions, PauseReason, ResumeAction};
pub use event::{
    LogLevel, RunError, RunEvent, RunEventEnvelope, RunReport, RunSnapshot, RunStatus, StepOutcome,
    SubscenarioRef,
};
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
    /// (see `ScenarioService::matching_version`).
    pub version: Option<u32>,
    /// Make this an interactive run that can pause (Studio). Unattended
    /// runs leave it unset and fail as usual. See [`debug`].
    pub debug: Option<DebugOptions>,
    /// The scenarios its `scenario.call` steps may run (see
    /// `ScenarioService::subscenarios`). The run uses them as given, so
    /// edits made while it runs do not affect it.
    pub subscenarios: Vec<Subscenario>,
}

/// The execution engine. Cheap to clone; share one per process.
#[derive(Clone)]
pub struct Runtime {
    registry: StepRegistry,
    handlers: Arc<HashMap<String, Arc<dyn ActionHandler>>>,
    resource_defs: Arc<HashMap<String, Vec<ResourceDef>>>,
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

    /// Step types this runtime can execute. Use the same registry for the
    /// `ScenarioService` so validation and execution agree.
    pub fn registry(&self) -> &StepRegistry {
        &self.registry
    }

    /// Validates and starts a run on the current Tokio runtime.
    pub fn start(&self, scenario: Scenario, options: RunOptions) -> Result<RunHandle, RunError> {
        let library: HashMap<ScenarioId, Arc<Scenario>> = options
            .subscenarios
            .iter()
            .map(|s| (s.scenario.id.clone(), Arc::new(s.scenario.clone())))
            .collect();
        let report = self
            .validator
            .validate_with_calls(&scenario, &|id| library.get(id).map(|s| (**s).clone()));
        if !report.valid {
            return Err(RunError {
                details: serde_json::to_value(&report).ok(),
                ..RunError::new("VALIDATION_FAILED", "the scenario has validation errors")
            });
        }

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
            scenario_id: scenario.id.clone(),
            status: RunStatus::Pending,
            current_step: None,
            steps_executed: 0,
        }));
        let emitter = Emitter::new(run_id.clone(), tx, snapshot.clone());
        let cancel = CancellationToken::new();
        let debugger = options.debug.map(|debug| {
            Arc::new(debug::Debugger::new(
                debug,
                scenario.clone(),
                self.validator.clone(),
            ))
        });

        let mut executor = Executor::new_from(
            &scenario,
            Executor {
                run_id: run_id.clone(),
                handlers: self.handlers.clone(),
                resource_defs: self.resource_defs.clone(),
                default_timeouts: self.default_timeouts.clone(),
                secrets: self.secrets.clone(),
                vars: Map::new(),
                secret_vars: scenario
                    .variables
                    .iter()
                    .filter(|v| v.secret)
                    .map(|v| v.name.clone())
                    .collect(),
                iteration: None,
                emitter: emitter.clone(),
                cancel: cancel.clone(),
                default_timeout_ms: exec::DEFAULT_TIMEOUT_MS,
                default_retry: None,
                default_on_error: OnError::Fail,
                resources: self.resources.clone(),
                debug: debugger.clone(),
                handled_depth: 0,
                library: Arc::new(library),
                target_defs: self.target_defs.clone(),
                policy: Arc::new(policy),
            },
        );
        let inputs = options.inputs;
        let subscenarios: Vec<SubscenarioRef> = options
            .subscenarios
            .iter()
            .map(|s| SubscenarioRef {
                scenario_id: s.scenario.id.clone(),
                scenario_name: s.scenario.name.clone(),
                revision: s.scenario.revision,
                version: s.version,
            })
            .collect();

        let task_run_id = run_id.clone();
        let version = options.version;
        let secrets = self.secrets.clone();
        let hooks = if options.keep_adapter_state {
            Arc::new(Vec::new())
        } else {
            self.run_finished_hooks.clone()
        };
        let join = tokio::spawn(async move {
            let started_at = OffsetDateTime::now_utc();
            let clock = Instant::now();
            emitter.update_snapshot(|s| s.status = RunStatus::Running);
            emitter.emit(RunEvent::RunStarted {
                scenario_id: scenario.id.clone(),
                scenario_name: scenario.name.clone(),
                revision: scenario.revision,
            });

            // After `runStarted`, so the inputs' `variableChanged` events
            // come first in the run.
            let init = init_variables(&scenario, &inputs, &mut executor);
            let result = match init {
                Ok(()) => executor.top_block(&scenario.steps).await,
                Err(e) => Err(exec::Interrupt::Failed(e)),
            };
            let (status, error) = exec::final_status(&result);
            let error = error.map(|e| emitter.mask_error(e));

            let outputs: Map<String, Value> = scenario
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

            // Release per-run adapter state (browser contexts, ...).
            for hook in hooks.iter() {
                hook(RunEnd {
                    run_id: task_run_id.clone(),
                    secrets: secrets.clone(),
                })
                .await;
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

            RunReport {
                run_id: task_run_id,
                scenario_id: scenario.id,
                scenario_name: scenario.name,
                revision: scenario.revision,
                version,
                status,
                started_at,
                finished_at: OffsetDateTime::now_utc(),
                error,
                outputs,
                subscenarios,
            }
        });

        Ok(RunHandle {
            run_id,
            cancel,
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

/// Called once when a run ends (after its last step, before `RunFinished`).
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
}

impl RuntimeBuilder {
    pub fn new() -> Self {
        let mut builder = Self {
            registry: StepRegistry::with_builtins(),
            handlers: HashMap::new(),
            run_finished_hooks: Vec::new(),
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
            resources: Arc::default(),
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
    scenario: &Scenario,
    inputs: &Map<String, Value>,
    executor: &mut Executor,
) -> Result<(), RunError> {
    for name in inputs.keys() {
        if !scenario
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
    let mut values = Vec::with_capacity(scenario.variables.len());
    for var in &scenario.variables {
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
                    return Err(RunError::new(
                        "MISSING_INPUT",
                        format!("input '{}' is required", var.name),
                    ));
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

/// Handle to a running scenario.
pub struct RunHandle {
    pub run_id: RunId,
    cancel: CancellationToken,
    events: mpsc::UnboundedReceiver<RunEventEnvelope>,
    debug: Option<DebugControl>,
    snapshot: Arc<Mutex<RunSnapshot>>,
    join: JoinHandle<RunReport>,
}

impl RunHandle {
    /// Requests cancellation. The current step is interrupted and the run
    /// finishes with status `cancelled`.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    /// A token that cancels this run when triggered (for stop buttons, MCP `stop_scenario`).
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
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
