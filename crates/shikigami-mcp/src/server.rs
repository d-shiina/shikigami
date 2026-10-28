use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData, Peer, RoleServer, ServerHandler, tool, tool_handler, tool_router};
use serde::Serialize;
use serde_json::{Value, json};
use shikigami_core::{
    Actor, ActorKind, EditOp, ErrorPayload, NewScenario, RunId, ScenarioId, ScenarioService, StepId,
};
use shikigami_runtime::record::{self, RunRecorder};
use shikigami_runtime::{RunHandle, RunOptions, RunSnapshot, Runtime};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use shikigami_browser::BrowserClient;

use crate::audit::{AuditLog, AuditRecord, now};
use crate::params::*;

/// Permission class of a tool. A server only exposes the classes it was
/// started with, so a client can be limited to e.g. read-only access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolClass {
    /// Reads scenarios, step types, history and run records.
    Read,
    /// Creates, edits, undoes and deletes (to trash) scenarios.
    Write,
    /// Starts and stops runs.
    Run,
}

impl ToolClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Run => "run",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            "run" => Some(Self::Run),
            _ => None,
        }
    }
}

/// Every tool and its permission class.
pub const TOOLS: &[(&str, ToolClass)] = &[
    ("list_scenarios", ToolClass::Read),
    ("get_scenario", ToolClass::Read),
    ("validate_scenario", ToolClass::Read),
    ("list_step_types", ToolClass::Read),
    ("get_step_schema", ToolClass::Read),
    ("get_history", ToolClass::Read),
    ("get_run_status", ToolClass::Read),
    ("get_run_logs", ToolClass::Read),
    ("list_runs", ToolClass::Read),
    ("create_scenario", ToolClass::Write),
    ("update_scenario", ToolClass::Write),
    ("add_step", ToolClass::Write),
    ("update_step", ToolClass::Write),
    ("remove_step", ToolClass::Write),
    ("move_step", ToolClass::Write),
    ("undo", ToolClass::Write),
    ("redo", ToolClass::Write),
    ("delete_scenario", ToolClass::Write),
    ("run_scenario", ToolClass::Run),
    ("stop_scenario", ToolClass::Run),
    ("inspect_page", ToolClass::Run),
    ("test_browser_step", ToolClass::Run),
];

fn class_of(tool: &str) -> ToolClass {
    TOOLS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, c)| *c)
        .unwrap_or(ToolClass::Write)
}

#[derive(Debug, Clone)]
pub struct ServerOptions {
    /// Tool classes this server exposes.
    pub allow: Vec<ToolClass>,
    /// Browser adapter for inspect_page / test_browser_step (the same one
    /// the Runtime's browser steps use).
    pub browser: Option<Arc<BrowserClient>>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            allow: vec![ToolClass::Read, ToolClass::Write, ToolClass::Run],
            browser: None,
        }
    }
}

const MAX_WAIT_MS: u64 = 300_000;
const DEFAULT_LOG_LIMIT: usize = 200;

const INSTRUCTIONS: &str = "\
Shikigami is a desktop RPA tool. You edit the same scenarios a human edits in \
Shikigami Studio, and scenarios run later without you.\n\
- Call list_step_types / get_step_schema before writing steps; params are validated against the schema.\n\
- Prefer small edits (add_step, update_step) or one update_scenario with several ops; each call is one undo step for the human.\n\
- Pass expectedRevision from your last read. REVISION_CONFLICT means the human changed the scenario: re-read it and redo your change, never overwrite blindly.\n\
- After editing, call validate_scenario and fix every error, then run_scenario (waitMs) and inspect get_run_logs.\n\
- Params listed in a step type's expressionParams take a bare expression (no {{ }}), e.g. condition: \"count > 3\". Every other string param is a template: \"合計 {{ total }} 円\"; a string that is exactly one {{ expr }} keeps the value's type.\n\
- Fix validation issues by following each issue's hint; get_step_schema returns copyable examples.\n\
- For web pages: inspect_page shows the page as an accessibility tree; target elements by role + name (or label for inputs) exactly as listed there, not by CSS. test_browser_step tries one browser step (e.g. log in) and returns the resulting page, so you can walk the site before writing the scenario.";

struct ActiveRun {
    cancel: CancellationToken,
    snapshot: Arc<Mutex<RunSnapshot>>,
}

struct Inner {
    service: Arc<ScenarioService>,
    runtime: Runtime,
    runs: Mutex<HashMap<RunId, ActiveRun>>,
    audit: AuditLog,
    browser: Option<Arc<BrowserClient>>,
}

/// Outcome of one tool call before it is turned into an MCP result.
type Outcome = Result<Value, ErrorPayload>;

#[derive(Clone)]
pub struct ShikigamiMcp {
    inner: Arc<Inner>,
    tool_router: ToolRouter<Self>,
}

impl ShikigamiMcp {
    pub fn new(service: Arc<ScenarioService>, runtime: Runtime, options: ServerOptions) -> Self {
        let mut tool_router = Self::tool_router();
        for (name, class) in TOOLS {
            if !options.allow.contains(class) {
                tool_router.remove_route(name);
            }
        }
        let audit = AuditLog::new(service.store().root());
        Self {
            inner: Arc::new(Inner {
                service,
                runtime,
                runs: Mutex::new(HashMap::new()),
                audit,
                browser: options.browser,
            }),
            tool_router,
        }
    }

    /// Names of the tools this server exposes.
    pub fn tool_names(&self) -> Vec<String> {
        self.tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.into_owned())
            .collect()
    }

    pub fn audit_path(&self) -> &std::path::Path {
        self.inner.audit.path()
    }

    fn svc(&self) -> &ScenarioService {
        &self.inner.service
    }

    /// Converts an outcome to a tool result (errors are tool-level so the AI
    /// sees the code and message) and writes the audit record.
    fn finish(
        &self,
        tool: &str,
        peer: &Peer<RoleServer>,
        scenario_id: Option<&str>,
        outcome: Outcome,
    ) -> Result<CallToolResult, ErrorData> {
        let info = peer.peer_info();
        let client = info.as_ref().map(|i| i.client_info.name.as_str());
        let (ok, code) = match &outcome {
            Ok(_) => (true, None),
            Err(e) => (false, Some(e.code.as_str())),
        };
        let revision = outcome
            .as_ref()
            .ok()
            .and_then(|v| v.pointer("/scenario/revision"))
            .and_then(Value::as_u64);
        let run_id = outcome
            .as_ref()
            .ok()
            .and_then(|v| v.get("runId"))
            .and_then(Value::as_str);
        self.inner.audit.write(&AuditRecord {
            at: now(),
            tool,
            class: class_of(tool).as_str(),
            client,
            ok,
            error_code: code,
            scenario_id,
            revision,
            run_id,
        });
        Ok(match outcome {
            Ok(value) => CallToolResult::structured(value),
            Err(e) => CallToolResult::structured_error(to_value(&e)),
        })
    }

    fn edit(
        &self,
        peer: &Peer<RoleServer>,
        id: &str,
        rev: Option<u64>,
        ops: Vec<EditOp>,
    ) -> Outcome {
        let out = self
            .svc()
            .edit(&ScenarioId::new(id), rev, ops, actor(peer))?;
        Ok(to_value(&out))
    }
}

fn actor(peer: &Peer<RoleServer>) -> Actor {
    match peer.peer_info() {
        Some(info) => Actor::named(ActorKind::Mcp, info.client_info.name.clone()),
        None => Actor::new(ActorKind::Mcp),
    }
}

fn to_value(v: &impl Serialize) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn err(code: &str, message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        code: code.to_owned(),
        message: message.into(),
        details: None,
    }
}

fn io_err(e: std::io::Error) -> ErrorPayload {
    err("IO_ERROR", e.to_string())
}

fn run_id(raw: &str) -> Result<RunId, ErrorPayload> {
    let id = RunId::new(raw);
    if id.is_well_formed() {
        Ok(id)
    } else {
        Err(err("INVALID_RUN_ID", format!("invalid run id: {raw}")))
    }
}

#[tool_router]
impl ShikigamiMcp {
    // -- read ---------------------------------------------------------------

    /// List all scenarios in the workspace (ID, name, revision, step count).
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_scenarios(&self, peer: Peer<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .list()
            .map(|s| json!({ "scenarios": s }))
            .map_err(Into::into);
        self.finish("list_scenarios", &peer, None, outcome)
    }

    /// Get a scenario document: variables, settings and the step tree with step IDs.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_scenario(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ScenarioRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| -> Outcome {
            let id = ScenarioId::new(p.scenario_id.as_str());
            let scenario = self.svc().get(&id)?;
            let (can_undo, can_redo) = self.svc().undo_state(&id)?;
            Ok(json!({ "scenario": scenario, "canUndo": can_undo, "canRedo": can_redo }))
        })();
        self.finish("get_scenario", &peer, Some(&p.scenario_id), outcome)
    }

    /// Validate a stored scenario (scenarioId) or an unsaved document (scenario).
    /// Returns every issue with a JSON Pointer path. A scenario runs only when `valid` is true.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn validate_scenario(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ValidateParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = match (&p.scenario_id, &p.scenario) {
            (Some(id), None) => self
                .svc()
                .validate_stored(&ScenarioId::new(id.as_str()))
                .map(|r| to_value(&r))
                .map_err(Into::into),
            (None, Some(scenario)) => Ok(to_value(&self.svc().validate(scenario))),
            _ => Err(err(
                "INVALID_ARGUMENT",
                "give exactly one of scenarioId or scenario",
            )),
        };
        self.finish(
            "validate_scenario",
            &peer,
            p.scenario_id.as_deref(),
            outcome,
        )
    }

    /// List available step types with their descriptions and child blocks.
    /// Use get_step_schema for the params schema of a type.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_step_types(&self, peer: Peer<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let types: Vec<Value> = self
            .svc()
            .registry()
            .iter()
            .map(|d| {
                json!({
                    "type": d.step_type,
                    "category": d.category,
                    "label": d.label,
                    "description": d.description,
                    "blocks": d.blocks,
                    "hasOutput": d.has_output,
                    "expressionParams": d.expression_params,
                    "bindsVariables": d.binds_variables,
                    "risk": d.risk,
                })
            })
            .collect();
        self.finish(
            "list_step_types",
            &peer,
            None,
            Ok(json!({ "stepTypes": types })),
        )
    }

    /// Get the full definition of a step type, including the JSON Schema of its params.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_step_schema(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<StepTypeRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = match self.svc().registry().get(&p.step_type) {
            Some(def) => Ok(to_value(def)),
            None => Err(err(
                "UNKNOWN_STEP_TYPE",
                format!("unknown step type: {}", p.step_type),
            )),
        };
        self.finish("get_step_schema", &peer, None, outcome)
    }

    /// Recent change history of a scenario: who (Studio, MCP client, CLI) changed what, newest first.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_history(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<HistoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .history(
                &ScenarioId::new(p.scenario_id.as_str()),
                p.limit.unwrap_or(20),
            )
            .map(|entries| {
                // The ops/inverse payloads are large and rarely useful to an AI.
                let entries: Vec<Value> = entries
                    .iter()
                    .map(|e| {
                        json!({
                            "revision": e.revision,
                            "kind": e.kind,
                            "actor": e.actor,
                            "at": e.at,
                            "label": e.label,
                        })
                    })
                    .collect();
                json!({ "entries": entries })
            })
            .map_err(Into::into);
        self.finish("get_history", &peer, Some(&p.scenario_id), outcome)
    }

    /// Status of a run: live progress while running, the final report (status, outputs, error) once finished.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_run_status(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = run_id(&p.run_id).and_then(|id| self.run_status(&id));
        self.finish("get_run_status", &peer, None, outcome)
    }

    /// Events of a run (step started/finished, logs, errors) in order. Use afterSeq to poll for new events.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_run_logs(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunLogsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| -> Outcome {
            let id = run_id(&p.run_id)?;
            let root = self.svc().store().root();
            let events = match record::read_events(root, &id) {
                Ok(events) => events,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(err("RUN_NOT_FOUND", format!("no run {id}")));
                }
                Err(e) => return Err(io_err(e)),
            };
            let limit = p.limit.unwrap_or(DEFAULT_LOG_LIMIT);
            let selected: Vec<_> = events
                .into_iter()
                .filter(|e| p.after_seq.is_none_or(|after| e.seq > after))
                .take(limit)
                .collect();
            let last_seq = selected.last().map(|e| e.seq).or(p.after_seq);
            let finished = record::read_report(root, &id).map_err(io_err)?.is_some();
            Ok(json!({ "events": selected, "lastSeq": last_seq, "finished": finished }))
        })();
        self.finish("get_run_logs", &peer, None, outcome)
    }

    /// Recent runs (newest first), optionally only those of one scenario.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_runs(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ListRunsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.list_runs_inner(&p);
        self.finish("list_runs", &peer, p.scenario_id.as_deref(), outcome)
    }

    // -- write --------------------------------------------------------------

    /// Create a scenario. Steps may omit IDs. Drafts may be invalid; check the returned validation.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn create_scenario(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<CreateScenarioParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let input = NewScenario {
            name: p.name,
            description: p.description,
            variables: p.variables,
            steps: p.steps,
            tags: p.tags,
        };
        let outcome = self
            .svc()
            .create(input, actor(&peer))
            .map(|o| to_value(&o))
            .map_err(Into::into);
        let id = outcome
            .as_ref()
            .ok()
            .and_then(|v| v.pointer("/scenario/id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.finish("create_scenario", &peer, id.as_deref(), outcome)
    }

    /// Apply several edit operations atomically as one revision (addStep, updateStep, removeStep,
    /// moveStep, updateScenario, setVariable, removeVariable, replaceSteps).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn update_scenario(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<UpdateScenarioParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.edit(&peer, &p.scenario_id, p.expected_revision, p.ops);
        self.finish("update_scenario", &peer, Some(&p.scenario_id), outcome)
    }

    /// Insert a step (with children) at a position; appends to the top level by default.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn add_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<AddStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::AddStep {
            step: p.step,
            position: p.position,
        }];
        let outcome = self.edit(&peer, &p.scenario_id, p.expected_revision, ops);
        self.finish("add_step", &peer, Some(&p.scenario_id), outcome)
    }

    /// Change a step's params or settings with a partial patch.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn update_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<UpdateStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::UpdateStep {
            step_id: StepId::new(p.step_id),
            patch: p.patch,
        }];
        let outcome = self.edit(&peer, &p.scenario_id, p.expected_revision, ops);
        self.finish("update_step", &peer, Some(&p.scenario_id), outcome)
    }

    /// Remove a step and its children (undoable).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn remove_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RemoveStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::RemoveStep {
            step_id: StepId::new(p.step_id),
        }];
        let outcome = self.edit(&peer, &p.scenario_id, p.expected_revision, ops);
        self.finish("remove_step", &peer, Some(&p.scenario_id), outcome)
    }

    /// Move a step to another position or into a control-flow block.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn move_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<MoveStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::MoveStep {
            step_id: StepId::new(p.step_id),
            position: p.position,
        }];
        let outcome = self.edit(&peer, &p.scenario_id, p.expected_revision, ops);
        self.finish("move_step", &peer, Some(&p.scenario_id), outcome)
    }

    /// Undo the latest change to a scenario, whoever made it (shared with Studio and the CLI).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn undo(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RevisionedRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .undo(
                &ScenarioId::new(p.scenario_id.as_str()),
                p.expected_revision,
                actor(&peer),
            )
            .map(|o| to_value(&o))
            .map_err(Into::into);
        self.finish("undo", &peer, Some(&p.scenario_id), outcome)
    }

    /// Redo the latest undone change to a scenario.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn redo(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RevisionedRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .redo(
                &ScenarioId::new(p.scenario_id.as_str()),
                p.expected_revision,
                actor(&peer),
            )
            .map(|o| to_value(&o))
            .map_err(Into::into);
        self.finish("redo", &peer, Some(&p.scenario_id), outcome)
    }

    /// Move a scenario to the workspace trash. Requires the revision you last read.
    /// Only do this when the user explicitly asked to delete the scenario.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = true,
        open_world_hint = false
    ))]
    async fn delete_scenario(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<DeleteScenarioParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .delete(
                &ScenarioId::new(p.scenario_id.as_str()),
                Some(p.expected_revision),
                actor(&peer),
            )
            .map(|()| json!({ "deleted": p.scenario_id, "movedToTrash": true }))
            .map_err(Into::into);
        self.finish("delete_scenario", &peer, Some(&p.scenario_id), outcome)
    }

    // -- run ----------------------------------------------------------------

    /// Run a stored scenario with the Runtime (no AI involved during the run). The scenario must
    /// validate. With waitMs, waits for completion and returns the report; otherwise returns the run ID
    /// at once — poll get_run_status / get_run_logs.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = true
    ))]
    async fn run_scenario(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunScenarioParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.start_run(&p).await;
        self.finish("run_scenario", &peer, Some(&p.scenario_id), outcome)
    }

    // -- browser --------------------------------------------------------------

    /// Open a web page (or look at the one already open) and return its accessibility tree: roles,
    /// names and labels to use as step targets, e.g. `- button "ログイン"` becomes
    /// { "role": "button", "name": "ログイン" }. The browser state belongs to this MCP session.
    #[tool(annotations(read_only_hint = true, open_world_hint = true))]
    async fn inspect_page(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<InspectPageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut params = serde_json::Map::new();
        if let Some(url) = p.url {
            params.insert("url".into(), Value::String(url));
        }
        if let Some(context) = p.context {
            params.insert("context".into(), Value::String(context));
        }
        if let Some(target) = p.target {
            params.insert("target".into(), target);
        }
        let outcome = self
            .browser_call("snapshot", params)
            .await
            .map(truncate_snapshot);
        self.finish("inspect_page", &peer, None, outcome)
    }

    /// Run one browser step now (outside any scenario) in this MCP session's browser and return its
    /// output and the page afterwards. Use it to try targets and walk through a site (log in, open a
    /// menu) before adding the steps to a scenario. The scenario is not changed.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = true
    ))]
    async fn test_browser_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<TestBrowserStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = async {
            let (def, method) = shikigami_browser::step_defs()
                .into_iter()
                .find(|(def, _)| def.step_type == p.step_type)
                .ok_or_else(|| {
                    err(
                        "UNKNOWN_STEP_TYPE",
                        format!("'{}' is not a browser step type", p.step_type),
                    )
                })?;
            let schema = jsonschema::validator_for(&def.params_schema)
                .map_err(|e| err("INTERNAL", e.to_string()))?;
            let params = Value::Object(p.params.clone());
            if let Some(e) = schema.iter_errors(&params).next() {
                return Err(err("INVALID_PARAMS", format!("{e} (see get_step_schema)")));
            }
            let output = self.browser_call(method, p.params.clone()).await?;
            let mut page_params = serde_json::Map::new();
            if let Some(context) = p.params.get("context") {
                page_params.insert("context".into(), context.clone());
            }
            let page = if method == "close" {
                Value::Null
            } else {
                self.browser_call("snapshot", page_params)
                    .await
                    .map(truncate_snapshot)
                    .unwrap_or(Value::Null)
            };
            Ok(json!({ "output": output, "page": page }))
        }
        .await;
        self.finish("test_browser_step", &peer, None, outcome)
    }

    /// Request cancellation of a running scenario.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn stop_scenario(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| -> Outcome {
            let id = run_id(&p.run_id)?;
            let runs = self
                .inner
                .runs
                .lock()
                .map_err(|_| err("INTERNAL", "run registry poisoned"))?;
            let run = runs.get(&id).ok_or_else(|| {
                err(
                    "RUN_NOT_ACTIVE",
                    format!("run {id} is not running in this server"),
                )
            })?;
            run.cancel.cancel();
            Ok(json!({ "runId": id, "cancelRequested": true }))
        })();
        self.finish("stop_scenario", &peer, None, outcome)
    }
}

/// Browser state opened from MCP tools lives under this pseudo run.
const MCP_BROWSER_RUN: &str = "mcp";
const SNAPSHOT_LIMIT: usize = 20_000;

fn truncate_snapshot(mut page: Value) -> Value {
    if let Some(Value::String(text)) = page.get_mut("snapshot")
        && text.len() > SNAPSHOT_LIMIT
    {
        let mut end = SNAPSHOT_LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n… (truncated: pass `target` to inspect one part of the page)");
    }
    page
}

impl ShikigamiMcp {
    async fn browser_call(
        &self,
        method: &str,
        mut params: serde_json::Map<String, Value>,
    ) -> Outcome {
        let Some(browser) = &self.inner.browser else {
            return Err(err(
                "ADAPTER_UNAVAILABLE",
                "browser steps are not available in this server",
            ));
        };
        params.insert("runId".into(), Value::String(MCP_BROWSER_RUN.into()));
        browser
            .call(method, Value::Object(params), &CancellationToken::new())
            .await
            .map_err(|e| ErrorPayload {
                code: e.code,
                message: e.message,
                details: e.details,
            })
    }

    fn run_status(&self, id: &RunId) -> Outcome {
        if let Ok(runs) = self.inner.runs.lock()
            && let Some(run) = runs.get(id)
        {
            let snapshot = run.snapshot.lock().map(|s| s.clone()).ok();
            return Ok(json!({ "runId": id, "active": true, "snapshot": snapshot }));
        }
        match record::read_report(self.svc().store().root(), id).map_err(io_err)? {
            Some(report) => Ok(json!({ "runId": id, "active": false, "report": report })),
            None => Err(err("RUN_NOT_FOUND", format!("no run {id}"))),
        }
    }

    fn list_runs_inner(&self, p: &ListRunsParams) -> Outcome {
        let root = self.svc().store().root();
        let limit = p.limit.unwrap_or(20);
        let mut out = Vec::new();
        for id in record::list_runs(root).map_err(io_err)? {
            if out.len() >= limit {
                break;
            }
            let entry = match record::read_report(root, &id) {
                Ok(Some(r)) => json!({
                    "runId": r.run_id,
                    "scenarioId": r.scenario_id,
                    "scenarioName": r.scenario_name,
                    "revision": r.revision,
                    "status": r.status,
                    "startedAt": to_value(&r).get("startedAt"),
                    "finishedAt": to_value(&r).get("finishedAt"),
                    "errorCode": r.error.as_ref().map(|e| e.code.clone()),
                }),
                // No report yet: still running here or in another process, or crashed.
                _ => match self.run_status(&id) {
                    Ok(v) if v["active"] == json!(true) => json!({
                        "runId": id,
                        "scenarioId": v.pointer("/snapshot/scenarioId"),
                        "status": "running",
                    }),
                    _ => json!({ "runId": id, "status": "unknown" }),
                },
            };
            if let Some(filter) = &p.scenario_id
                && entry.get("scenarioId").and_then(Value::as_str) != Some(filter.as_str())
            {
                continue;
            }
            out.push(entry);
        }
        Ok(json!({ "runs": out }))
    }

    /// Everything that can fail happens before the run starts, so a failed
    /// call never leaves an unrecorded, unstoppable run behind.
    fn launch(
        &self,
        scenario: shikigami_core::Scenario,
        p: &RunScenarioParams,
    ) -> Result<(RunId, RunHandle, RunRecorder), ErrorPayload> {
        let id = RunId::generate();
        let root = self.svc().store().root();
        let recorder = RunRecorder::create(root, &id).map_err(io_err)?;
        let mut runs = self
            .inner
            .runs
            .lock()
            .map_err(|_| err("INTERNAL", "run registry poisoned"))?;
        let handle = match self.inner.runtime.start(
            scenario,
            RunOptions {
                inputs: p.inputs.clone(),
                run_id: Some(id.clone()),
            },
        ) {
            Ok(handle) => handle,
            Err(e) => {
                drop(recorder);
                let _ = std::fs::remove_dir_all(root.join("runs").join(id.as_str()));
                return Err(ErrorPayload {
                    code: e.code,
                    message: e.message,
                    details: e.details,
                });
            }
        };
        runs.insert(
            id.clone(),
            ActiveRun {
                cancel: handle.cancel_token(),
                snapshot: handle.snapshot_cell(),
            },
        );
        Ok((id, handle, recorder))
    }

    async fn start_run(&self, p: &RunScenarioParams) -> Outcome {
        let scenario = self
            .svc()
            .get_runnable(&ScenarioId::new(p.scenario_id.as_str()))?;
        let (id, handle, mut recorder) = self.launch(scenario, p)?;
        let (tx, mut rx) = watch::channel(None);

        let inner = self.inner.clone();
        let task_id = id.clone();
        tokio::spawn(async move {
            let result = handle
                .wait_with(|event| {
                    if let Err(e) = recorder.write_event(event) {
                        tracing::warn!(error = %e, "failed to record run event");
                    }
                })
                .await;
            match result {
                Ok(report) => {
                    if let Err(e) = recorder.finish(&report) {
                        tracing::warn!(error = %e, "failed to write run report");
                    }
                    let _ = tx.send(Some(report));
                }
                Err(e) => tracing::error!(error = %e, "run task failed"),
            }
            if let Ok(mut runs) = inner.runs.lock() {
                runs.remove(&task_id);
            }
        });

        let wait = p.wait_ms.unwrap_or(0).min(MAX_WAIT_MS);
        if wait > 0 {
            let finished =
                tokio::time::timeout(Duration::from_millis(wait), rx.wait_for(Option::is_some))
                    .await;
            if let Ok(Ok(report)) = finished
                && let Some(report) = report.as_ref()
            {
                return Ok(json!({ "runId": id, "finished": true, "report": report }));
            }
        }
        Ok(json!({ "runId": id, "finished": false }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ShikigamiMcp {
    fn get_info(&self) -> ServerConfig {
        let mut server_info = Implementation::new("shikigami", env!("CARGO_PKG_VERSION"));
        server_info.title = Some("Shikigami（式神）".into());
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(server_info)
            .with_instructions(INSTRUCTIONS)
    }
}
