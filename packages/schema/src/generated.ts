/* eslint-disable */
/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: schemas/*.schema.json (generated from the Rust crates).
 * Regenerate with `pnpm schema:generate`.
 */

/**
 * Identifier of a scenario. Also used as its file name in the store.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioId".
 */
export type ScenarioId = string;
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "OnError".
 */
export type OnError = "fail" | "continue";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "EditOp".
 */
export type EditOp =
  | {
      op: "addStep";
      step: Step;
      position?: Position;
    }
  | {
      op: "updateStep";
      stepId: StepId;
      patch: StepPatch;
    }
  | {
      op: "removeStep";
      stepId: StepId;
    }
  | {
      op: "moveStep";
      stepId: StepId;
      position: Position1;
    }
  | {
      op: "updateScenario";
      patch: ScenarioPatch;
    }
  | {
      op: "setVariable";
      variable: VariableDef;
      /**
       * Position in the variable list when adding; ignored when replacing.
       */
      index?: number | null;
    }
  | {
      op: "removeVariable";
      name: string;
    }
  | {
      op: "replaceSteps";
      steps: Step[];
    };
/**
 * Identifier of a step. Unique within a scenario and stable across edits.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "StepId".
 */
export type StepId = string;
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Severity".
 */
export type Severity = "error" | "warning";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "StepCategory".
 */
export type StepCategory =
  "control" | "variable" | "log" | "flow" | "browser" | "windows" | "file" | "other";
/**
 * Risk level used by the permission layer (MCP approval, allow-lists).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RiskLevel".
 */
export type RiskLevel = "safe" | "interactive" | "dangerous";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ChangeKind".
 */
export type ChangeKind = "create" | "edit" | "undo" | "redo" | "delete";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ActorKind".
 */
export type ActorKind = "studio" | "mcp" | "cli" | "system";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "DiffKind".
 */
export type DiffKind = "added" | "removed" | "changed" | "moved";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ImportMode".
 */
export type ImportMode = "created" | "updated" | "copied";
/**
 * What to do when an imported scenario's ID already exists.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ImportConflict".
 */
export type ImportConflict = "update" | "copy";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "VarType".
 */
export type VarType = "string" | "number" | "boolean" | "object" | "array" | "any";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "VarDirection".
 */
export type VarDirection = "local" | "input" | "output" | "inOut";

/**
 * Bundle of the IPC/API payload types used by Studio and MCP tools.
 */
export interface ShikigamiApi {
  scenario: Scenario;
  scenario_summary: ScenarioSummary;
  new_scenario: NewScenario;
  edit_op: EditOp;
  edit_outcome: EditOutcome;
  validation_report: ValidationReport1;
  step_type_def: StepTypeDef;
  history_entry: HistoryEntry;
  change_event: ChangeEvent;
  error_payload: ErrorPayload;
  new_version: NewVersion;
  scenario_version: ScenarioVersion;
  version_summary: VersionSummary;
  scenario_diff: ScenarioDiff;
  scenario_bundle: ScenarioBundle;
  import_outcome: ImportOutcome;
  import_conflict: ImportConflict;
  workspace_info: WorkspaceInfo;
}
/**
 * A scenario: the unit that AI clients, Studio and the Runtime share.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Scenario".
 */
export interface Scenario {
  /**
   * Optional JSON Schema reference for editors. Ignored by Shikigami.
   */
  $schema?: string | null;
  /**
   * Version of the scenario file format.
   */
  schemaVersion: number;
  id: ScenarioId;
  name: string;
  description?: string;
  /**
   * Monotonic revision, incremented by every committed edit. Used for
   * optimistic concurrency between Studio, MCP clients and the CLI.
   */
  revision?: number;
  /**
   * Declared variables (inputs, outputs and locals).
   */
  variables?: VariableDef[];
  /**
   * Top-level steps, executed in order.
   */
  steps?: Step[];
  settings?: ScenarioSettings;
  metadata?: Metadata;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "VariableDef".
 */
export interface VariableDef {
  /**
   * Identifier used in expressions: `[A-Za-z_][A-Za-z0-9_]*`.
   */
  name: string;
  type?: "string" | "number" | "boolean" | "object" | "array" | "any";
  direction?: "local" | "input" | "output" | "inOut";
  default?: unknown;
  description?: string;
  /**
   * Secret values are masked in logs, events and run records.
   */
  secret?: boolean;
}
/**
 * A single step. Control-flow and action steps share this shape.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Step".
 */
export interface Step {
  /**
   * Stable unique ID. Omit when adding a step; Core assigns one.
   */
  id?: string;
  /**
   * Step type, e.g. `control.if`, `variable.set`, `browser.click`.
   */
  type: string;
  /**
   * Display label (Japanese is fine). Purely informational.
   */
  name?: string;
  description?: string;
  /**
   * Type-specific parameters, validated against the step type's schema.
   * String values may contain `{{ expression }}` templates.
   */
  params?: {
    [k: string]: unknown;
  };
  /**
   * Child step lists of control-flow steps, keyed by block name.
   */
  blocks?: {
    [k: string]: Step[];
  };
  /**
   * Disabled steps are skipped by the Runtime but kept in the scenario.
   */
  disabled?: boolean;
  /**
   * Per-attempt timeout. Falls back to `settings.defaultTimeoutMs`.
   */
  timeoutMs?: number | null;
  retry?: RetryPolicy | null;
  /**
   * What to do when the step still fails after retries.
   */
  onError?: OnError | null;
  /**
   * Variable that receives the step's output value.
   */
  saveAs?: string | null;
  /**
   * Free-form metadata (Studio layout hints, AI provenance such as the UI
   * element a selector was derived from). Never interpreted by the Runtime.
   */
  meta?: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RetryPolicy".
 */
export interface RetryPolicy {
  /**
   * Total attempts including the first one (1 = no retry).
   */
  maxAttempts: number;
  /**
   * Delay before the second attempt.
   */
  backoffMs?: number;
  /**
   * Multiplier applied to the delay after each failed attempt.
   */
  backoffMultiplier?: number;
}
/**
 * Scenario-wide defaults for error handling, timeouts and retries.
 */
export interface ScenarioSettings {
  /**
   * Default per-step timeout in milliseconds (30 s when omitted).
   */
  defaultTimeoutMs?: number | null;
  defaultRetry?: RetryPolicy | null;
  onError?: OnError | null;
}
export interface Metadata {
  createdAt?: string | null;
  updatedAt?: string | null;
  tags?: string[];
  [k: string]: unknown;
}
/**
 * Listing entry returned by `list_scenarios`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioSummary".
 */
export interface ScenarioSummary {
  id: ScenarioId;
  name: string;
  description: string;
  revision: number;
  stepCount: number;
  tags: string[];
  updatedAt?: string | null;
}
/**
 * Input for creating a scenario.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "NewScenario".
 */
export interface NewScenario {
  name: string;
  description?: string;
  variables?: VariableDef[];
  steps?: Step[];
  tags?: string[];
}
/**
 * Where a step lives (or should be inserted).
 */
export interface Position {
  /**
   * Parent control-flow step; omit for the top level.
   */
  parentId?: StepId | null;
  /**
   * Block of the parent (`then`, `else`, `body`, `try`, `catch`, `finally`).
   */
  block?: string | null;
  /**
   * Index in the target list (after removing the moved step). Omit to append.
   */
  index?: number | null;
}
/**
 * Partial update of a step. Absent fields are left unchanged; for optional
 * fields, an explicit `null` clears the value.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "StepPatch".
 */
export interface StepPatch {
  name?: string | null;
  description?: string | null;
  /**
   * JSON Merge Patch (RFC 7386) applied to `params`: keys set to `null` are removed.
   */
  params?: {
    [k: string]: unknown;
  } | null;
  /**
   * Replaces `params` entirely. Mutually exclusive with `params`.
   */
  replaceParams?: {
    [k: string]: unknown;
  } | null;
  disabled?: boolean | null;
  timeoutMs?: number | null;
  retry?: RetryPolicy | null;
  onError?: OnError | null;
  saveAs?: string | null;
  /**
   * Replaces `meta` entirely.
   */
  meta?: {
    [k: string]: unknown;
  } | null;
}
/**
 * Where a step lives (or should be inserted).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Position".
 */
export interface Position1 {
  /**
   * Parent control-flow step; omit for the top level.
   */
  parentId?: StepId | null;
  /**
   * Block of the parent (`then`, `else`, `body`, `try`, `catch`, `finally`).
   */
  block?: string | null;
  /**
   * Index in the target list (after removing the moved step). Omit to append.
   */
  index?: number | null;
}
/**
 * Partial update of scenario-level fields.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioPatch".
 */
export interface ScenarioPatch {
  name?: string | null;
  description?: string | null;
  settings?: ScenarioSettings1 | null;
  tags?: string[] | null;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioSettings".
 */
export interface ScenarioSettings1 {
  /**
   * Default per-step timeout in milliseconds (30 s when omitted).
   */
  defaultTimeoutMs?: number | null;
  defaultRetry?: RetryPolicy | null;
  onError?: OnError | null;
}
/**
 * Result of a committed change.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "EditOutcome".
 */
export interface EditOutcome {
  scenario: Scenario;
  validation: ValidationReport;
  canUndo: boolean;
  canRedo: boolean;
}
/**
 * Full validation of the new revision. Drafts may contain errors;
 * they must be fixed before the scenario can run.
 */
export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ValidationIssue".
 */
export interface ValidationIssue {
  severity: Severity;
  /**
   * Stable machine-readable code, e.g. `UNKNOWN_STEP_TYPE`.
   */
  code: string;
  message: string;
  /**
   * JSON Pointer into the scenario document.
   */
  path: string;
  stepId?: StepId | null;
  /**
   * How to fix it, written for AI clients (and shown to humans in Studio).
   */
  hint?: string | null;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ValidationReport".
 */
export interface ValidationReport1 {
  valid: boolean;
  issues: ValidationIssue[];
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "StepTypeDef".
 */
export interface StepTypeDef {
  /**
   * Stable identifier, `namespace.action`.
   */
  type: string;
  category: StepCategory;
  /**
   * Japanese display name.
   */
  label: string;
  /**
   * Description written for both humans and AI clients.
   */
  description: string;
  /**
   * JSON Schema (draft 2020-12) for `params`.
   */
  paramsSchema: {
    [k: string]: unknown;
  };
  /**
   * Child blocks allowed on this step (empty for action steps).
   */
  blocks?: BlockDef[];
  /**
   * Whether the step produces a value that `saveAs` can capture.
   */
  hasOutput?: boolean;
  /**
   * Params whose string value is an expression (not a template).
   */
  expressionParams?: string[];
  /**
   * Params that declare a variable name (introduced into scope).
   */
  bindsVariables?: string[];
  risk: RiskLevel;
  /**
   * Complete, valid step objects showing typical use (IDs omitted). AI
   * clients get them from `get_step_schema` and can copy them.
   */
  examples?: unknown[];
}
/**
 * Named child block of a control-flow step.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "BlockDef".
 */
export interface BlockDef {
  name: string;
  label: string;
}
/**
 * One committed change.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "HistoryEntry".
 */
export interface HistoryEntry {
  kind: ChangeKind;
  /**
   * Revision of the scenario after this change.
   */
  revision: number;
  actor: Actor;
  at: string;
  label: string;
  /**
   * Ops that were applied.
   */
  ops?: EditOp[];
  /**
   * Ops that revert this change.
   */
  inverse?: EditOp[];
}
/**
 * Who made a change. Recorded in history and the audit journal.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Actor".
 */
export interface Actor {
  kind: ActorKind;
  /**
   * Client name, e.g. the MCP client's reported name.
   */
  name?: string | null;
}
/**
 * Notification sent to in-process listeners after every committed change.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ChangeEvent".
 */
export interface ChangeEvent {
  scenarioId: ScenarioId;
  kind: ChangeKind;
  revision: number;
  actor: Actor;
}
/**
 * Serializable error shape returned over IPC / MCP.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ErrorPayload".
 */
export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}
/**
 * Input for creating a version.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "NewVersion".
 */
export interface NewVersion {
  /**
   * Short name, e.g. "v1" or "本番リリース".
   */
  name: string;
  /**
   * What changed or why this version matters.
   */
  note?: string;
}
/**
 * One named snapshot of a scenario.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioVersion".
 */
export interface ScenarioVersion {
  /**
   * Per-scenario sequence number (1, 2, …). This is how versions are referenced.
   */
  number: number;
  /**
   * Globally unique ID; keeps versions apart when bundles are imported.
   */
  uid: string;
  name: string;
  note?: string;
  createdAt: string;
  createdBy: Actor;
  /**
   * Scenario revision the snapshot was taken from.
   */
  revision: number;
  scenario: Scenario;
}
/**
 * Listing entry for versions (no scenario body).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "VersionSummary".
 */
export interface VersionSummary {
  number: number;
  name: string;
  note?: string;
  createdAt: string;
  createdBy: Actor;
  revision: number;
  stepCount: number;
}
/**
 * Differences from `from` to `to`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioDiff".
 */
export interface ScenarioDiff {
  from: DiffSide;
  to: DiffSide;
  /**
   * True when the contents are the same (names, variables, steps, settings).
   */
  identical: boolean;
  /**
   * Scenario-level fields: name, description, tags, settings.
   */
  scenario: FieldChange[];
  variables: VariableChange[];
  steps: StepChange[];
}
/**
 * Which side of a comparison: a version number, or the current content.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "DiffSide".
 */
export interface DiffSide {
  /**
   * Version number; absent for the current content.
   */
  version?: number | null;
  label: string;
  revision: number;
}
/**
 * One changed field: `name`, `params.url`, `settings`, …
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FieldChange".
 */
export interface FieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "VariableChange".
 */
export interface VariableChange {
  kind: DiffKind;
  name: string;
  fields?: FieldChange[];
}
/**
 * One step-level difference. Added and removed subtrees are reported once,
 * at their top step (`stepCount` includes the children).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "StepChange".
 */
export interface StepChange {
  kind: DiffKind;
  stepId: StepId;
  type: string;
  name?: string;
  /**
   * Changed fields (`changed` only).
   */
  fields?: FieldChange[];
  /**
   * Location in the older content (`removed`, `moved`).
   */
  from?: StepLocation | null;
  /**
   * Location in the newer content (`added`, `moved`).
   */
  to?: StepLocation | null;
  /**
   * Steps in the subtree (`added`, `removed`).
   */
  stepCount?: number | null;
}
/**
 * Where a step sits: top level (`parentId` absent) or a parent's block.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "StepLocation".
 */
export interface StepLocation {
  parentId?: StepId | null;
  block?: string | null;
  index: number;
}
/**
 * File format for moving a scenario (and its versions) between workspaces.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioBundle".
 */
export interface ScenarioBundle {
  /**
   * Always `shikigami.scenarioBundle`.
   */
  format: string;
  formatVersion: number;
  exportedAt: string;
  scenario: Scenario;
  versions?: ScenarioVersion[];
}
/**
 * Result of importing a bundle or scenario file.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ImportOutcome".
 */
export interface ImportOutcome {
  mode: ImportMode;
  /**
   * Versions from the bundle that were added (already present ones are skipped).
   */
  versionsAdded: number;
  scenario: Scenario;
  validation: ValidationReport2;
  canUndo: boolean;
  canRedo: boolean;
}
/**
 * Full validation of the new revision. Drafts may contain errors;
 * they must be fixed before the scenario can run.
 */
export interface ValidationReport2 {
  valid: boolean;
  issues: ValidationIssue[];
}
/**
 * Where a workspace keeps its data, for display and diagnostics.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "WorkspaceInfo".
 */
export interface WorkspaceInfo {
  root: string;
  /**
   * Undo history, run records and audit logs of this PC.
   */
  localRoot: string;
  shared: boolean;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Metadata".
 */
export interface Metadata1 {
  createdAt?: string | null;
  updatedAt?: string | null;
  tags?: string[];
  [k: string]: unknown;
}

/**
 * A run event with ordering and timing metadata.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunEventEnvelope".
 */
export type RunEventEnvelope = {
  runId: RunId;
  /**
   * Monotonic sequence number within the run, starting at 0.
   */
  seq: number;
  at: string;
} & RunEventEnvelope1;
/**
 * Identifier of a single scenario execution.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunId".
 */
export type RunId = string;
export type RunEventEnvelope1 =
  | {
      type: "runStarted";
      scenarioId: ScenarioId;
      scenarioName: string;
      revision: number;
    }
  | {
      type: "stepStarted";
      stepId: StepId;
      stepType: string;
      attempt: number;
    }
  | {
      type: "stepFinished";
      stepId: StepId;
      stepType: string;
      outcome: StepOutcome;
      durationMs: number;
      error?: RunError | null;
      willRetry?: boolean;
    }
  | {
      type: "log";
      level: LogLevel;
      message: string;
      stepId?: StepId | null;
    }
  | {
      type: "runFinished";
      status: RunStatus;
      error?: RunError | null;
      durationMs: number;
    };
/**
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "StepOutcome".
 */
export type StepOutcome = "succeeded" | "failed" | "skipped";
/**
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "LogLevel".
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
/**
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunStatus".
 */
export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface ShikigamiRunApi {
  run_event_envelope: RunEventEnvelope;
  run_report: RunReport;
  run_snapshot: RunSnapshot;
}
/**
 * Structured failure information, kept for AI-assisted diagnosis.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunError".
 */
export interface RunError {
  /**
   * Stable code, e.g. `STEP_TIMEOUT`, `EXPR_UNDEFINED_VARIABLE`, `ELEMENT_NOT_FOUND`.
   */
  code: string;
  message: string;
  stepId?: StepId | null;
  stepType?: string | null;
  /**
   * Adapter-specific evidence: UI element snapshot, screenshot path,
   * expected vs. actual state, etc.
   */
  details?: {
    [k: string]: unknown;
  };
}
/**
 * Final result of a run.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunReport".
 */
export interface RunReport {
  runId: RunId;
  scenarioId: ScenarioId;
  scenarioName: string;
  revision: number;
  /**
   * Named version whose content was run, when it matches one.
   */
  version?: number | null;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  error?: RunError | null;
  /**
   * Values of output variables (secret outputs are masked when recorded).
   */
  outputs: {
    [k: string]: unknown;
  };
}
/**
 * Live state of a run, for `get_run_status` while it is executing.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunSnapshot".
 */
export interface RunSnapshot {
  runId: RunId;
  scenarioId: ScenarioId;
  status: RunStatus;
  currentStep?: StepId | null;
  stepsExecuted: number;
}
