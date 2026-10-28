//! Shikigami RPA Runtime.
//!
//! Executes scenarios without any AI and without the GUI. Studio, the MCP
//! server and the CLI embed the same [`Runtime`]; automation adapters plug in
//! by registering a step type definition together with an [`ActionHandler`].

// RunError carries rich diagnostics by design; it only travels on the cold
// failure path, so boxing it would add noise without a measurable benefit.
#![allow(clippy::result_large_err)]

pub mod builtin;
pub mod event;
mod exec;
pub mod handler;
pub mod record;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{Map, Value};
use shikigami_core::registry::builtin as builtin_types;
use shikigami_core::{OnError, RunId, Scenario, StepRegistry, StepTypeDef, Validator};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use event::{
    LogLevel, RunError, RunEvent, RunEventEnvelope, RunReport, RunSnapshot, RunStatus, StepOutcome,
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
}

/// The execution engine. Cheap to clone; share one per process.
#[derive(Clone)]
pub struct Runtime {
    registry: StepRegistry,
    handlers: Arc<HashMap<String, Arc<dyn ActionHandler>>>,
    resource_defs: Arc<HashMap<String, Vec<ResourceDef>>>,
    validator: Arc<Validator>,
    resources: Arc<ResourceLocks>,
}

impl Runtime {
    /// Runtime with the built-in step types (control flow, variables, log, delay).
    pub fn new() -> Self {
        RuntimeBuilder::new().build()
    }

    pub fn builder() -> RuntimeBuilder {
        RuntimeBuilder::new()
    }

    /// Step types this runtime can execute. Use the same registry for the
    /// `ScenarioService` so validation and execution agree.
    pub fn registry(&self) -> &StepRegistry {
        &self.registry
    }

    /// Validates and starts a run on the current Tokio runtime.
    pub fn start(&self, scenario: Scenario, options: RunOptions) -> Result<RunHandle, RunError> {
        let report = self.validator.validate(&scenario);
        if !report.valid {
            return Err(RunError {
                details: serde_json::to_value(&report).ok(),
                ..RunError::new("VALIDATION_FAILED", "the scenario has validation errors")
            });
        }

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

        let mut executor = Executor::new_from(
            &scenario,
            Executor {
                run_id: run_id.clone(),
                handlers: self.handlers.clone(),
                resource_defs: self.resource_defs.clone(),
                vars: Map::new(),
                secret_vars: scenario
                    .variables
                    .iter()
                    .filter(|v| v.secret)
                    .map(|v| v.name.clone())
                    .collect(),
                emitter: emitter.clone(),
                cancel: cancel.clone(),
                default_timeout_ms: exec::DEFAULT_TIMEOUT_MS,
                default_retry: None,
                default_on_error: OnError::Fail,
                resources: self.resources.clone(),
            },
        );
        let init = init_variables(&scenario, &options.inputs, &mut executor);

        let task_run_id = run_id.clone();
        let join = tokio::spawn(async move {
            let started_at = OffsetDateTime::now_utc();
            let clock = Instant::now();
            emitter.update_snapshot(|s| s.status = RunStatus::Running);
            emitter.emit(RunEvent::RunStarted {
                scenario_id: scenario.id.clone(),
                scenario_name: scenario.name.clone(),
                revision: scenario.revision,
            });

            let result = match init {
                Ok(()) => executor.block(&scenario.steps).await,
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
                        value
                    };
                    (v.name.clone(), value)
                })
                .collect();

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
                status,
                started_at,
                finished_at: OffsetDateTime::now_utc(),
                error,
                outputs,
            }
        });

        Ok(RunHandle {
            run_id,
            cancel,
            events: rx,
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

pub struct RuntimeBuilder {
    registry: StepRegistry,
    handlers: HashMap<String, Arc<dyn ActionHandler>>,
}

impl RuntimeBuilder {
    pub fn new() -> Self {
        let mut builder = Self {
            registry: StepRegistry::with_builtins(),
            handlers: HashMap::new(),
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
            registry: self.registry,
        }
    }
}

impl Default for RuntimeBuilder {
    fn default() -> Self {
        Self::new()
    }
}

fn init_variables(
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
        executor.set_var(&var.name, value);
    }
    Ok(())
}

/// Handle to a running scenario.
pub struct RunHandle {
    pub run_id: RunId,
    cancel: CancellationToken,
    events: mpsc::UnboundedReceiver<RunEventEnvelope>,
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
