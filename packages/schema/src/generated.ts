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
  | ("control" | "variable" | "log" | "flow" | "browser" | "windows" | "office" | "file" | "other")
  | "network"
  | "system";
/**
 * Risk level used by the permission layer (MCP approval, allow-lists).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RiskLevel".
 */
export type RiskLevel = "safe" | "interactive" | "dangerous";
/**
 * What kind of target a step param names.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "TargetKind".
 */
export type TargetKind = "site" | "app";
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
 * What importing a bundle did with one of its sub-scenarios.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "SubscenarioImport".
 */
export type SubscenarioImport = "created" | "updated" | "kept";
/**
 * What to do when an imported scenario's ID already exists.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ImportConflict".
 */
export type ImportConflict = "update" | "copy";
/**
 * Identifier of a screen an AI looked at (review evidence).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ObservationId".
 */
export type ObservationId = string;
/**
 * One line of `history/<scenario-id>/evidence.jsonl`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Evidence".
 */
export type Evidence = {
  /**
   * Revision this record belongs to.
   */
  revision: number;
  at: string;
  actor: Actor;
} & Evidence1;
export type Evidence1 =
  | {
      kind: "testRun";
      runId: RunId;
      /**
       * `succeeded`, `failed`, `cancelled`, ...
       */
      status: string;
      errorCode?: string | null;
      errorMessage?: string | null;
      /**
       * Step the run failed at.
       */
      stepId?: StepId | null;
      /**
       * Named version the run's content matched.
       */
      version?: number | null;
      startedAt: string;
      finishedAt: string;
    }
  | {
      kind: "observation";
      observationId: ObservationId;
      source: ObservationSource;
      title: string;
      /**
       * Steps that edit touched.
       */
      stepIds?: StepId[];
      hasScreenshot: boolean;
    }
  | {
      kind: "review";
      verdict: ReviewVerdict;
      reason?: string;
      steps?: StepNote[];
    };
/**
 * Identifier of a single scenario execution.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RunId".
 */
export type RunId = string;
/**
 * What produced an observation.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ObservationSource".
 */
export type ObservationSource = ("inspectPage" | "inspectUi" | "testStep") | "runPause";
/**
 * A human's verdict on a revision.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ReviewVerdict".
 */
export type ReviewVerdict = "approved" | "rejected";
/**
 * What happens when an AI asks for an action.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Decision".
 */
export type Decision = ("allow" | "deny") | "ask";
/**
 * Identifier of a request for a person's approval of an AI action.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ApprovalId".
 */
export type ApprovalId = string;
/**
 * AI actions the policy can hold for approval.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "AiAction".
 */
export type AiAction = "runScenario" | "testStep" | "deleteScenario";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ApprovalStatus".
 */
export type ApprovalStatus = ("pending" | "approved" | "denied") | "used";
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
  extract_outcome: ExtractOutcome;
  import_conflict: ImportConflict;
  workspace_info: WorkspaceInfo;
  change_note: ChangeNote;
  review_timeline: ReviewTimeline;
  evidence: Evidence;
  new_review: NewReview;
  observation_content: ObservationContent;
  published_state: PublishedState;
  publish_input: PublishInput;
  publish_record: PublishRecord;
  policy: Policy;
  approval_request: ApprovalRequest;
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
   * Plugins the steps need, with the versions they were written for:
   * `{ "plugin:kintone": "^0.3.1" }`. Kept up to date by Core when steps
   * are added or removed, so authors normally leave it alone.
   */
  requires?: {
    [k: string]: string;
  };
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
  /**
   * Replaces `requires` (plugin version ranges). Core still adds plugins
   * that steps use and drops unused ones afterwards.
   */
  requires?: {
    [k: string]: string;
  } | null;
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
  /**
   * Params that name a site or a program, checked against the
   * workspace policy (`policy.json` `sites` / `apps`) before each run of
   * the step.
   */
  targets?: TargetDef[];
  /**
   * Params that may take a registered secret,
   * `{ "secret": "<name>", "field": "password" }`, instead of text.
   * Secrets are rejected everywhere else.
   */
  secretParams?: string[];
  /**
   * Timeout when the step sets none (takes precedence over the
   * scenario's default), for steps that wait on people (manual login).
   */
  defaultTimeoutMs?: number | null;
  /**
   * Set when the type should no longer be used in new steps. It keeps
   * working; validation warns and points at the replacement.
   */
  deprecated?: Deprecation | null;
  /**
   * The plugin that provides this type (`None` for built-in types).
   */
  plugin?: PluginInfo | null;
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
 * A step param that names something outside the run, checked against the
 * policy before the step executes.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "TargetDef".
 */
export interface TargetDef {
  param: string;
  kind: TargetKind;
}
/**
 * Why a step type is deprecated and what to use instead.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Deprecation".
 */
export interface Deprecation {
  /**
   * What to do instead, for people and AI clients.
   */
  note: string;
  /**
   * The step type that replaces this one, if any.
   */
  replacement?: string | null;
}
/**
 * A plugin that provides step types, as installed on this PC.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PluginInfo".
 */
export interface PluginInfo {
  /**
   * The plugin's name, also the prefix of its step types.
   */
  name: string;
  /**
   * Installed version (semver).
   */
  version: string;
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
   * The author's own explanation of the change (an AI's `summary`).
   */
  summary?: string | null;
  /**
   * Steps the change added, changed, moved or removed.
   */
  stepIds?: StepId[];
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
  /**
   * Every scenario `scenario` calls (directly or through others), without
   * versions, so the bundle runs on its own.
   */
  subscenarios?: Scenario[];
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
  /**
   * The bundle's sub-scenarios and what happened to each.
   */
  subscenarios?: ImportedSubscenario[];
  scenario: Scenario;
  validation: ValidationReport2;
  canUndo: boolean;
  canRedo: boolean;
}
/**
 * One sub-scenario of an imported bundle.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ImportedSubscenario".
 */
export interface ImportedSubscenario {
  id: ScenarioId;
  name: string;
  mode: SubscenarioImport;
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
 * Result of moving steps into a new sub-scenario.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ExtractOutcome".
 */
export interface ExtractOutcome {
  subscenario: EditOutcome1;
  caller: EditOutcome2;
  /**
   * Identifier of a step. Unique within a scenario and stable across edits.
   */
  callStepId: string;
}
/**
 * Result of a committed change.
 */
export interface EditOutcome1 {
  scenario: Scenario;
  validation: ValidationReport;
  canUndo: boolean;
  canRedo: boolean;
}
/**
 * Result of a committed change.
 */
export interface EditOutcome2 {
  scenario: Scenario;
  validation: ValidationReport;
  canUndo: boolean;
  canRedo: boolean;
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
 * What the author of a change says about it (MCP edit tools).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ChangeNote".
 */
export interface ChangeNote {
  /**
   * Why the change was made, in the author's words. Kept in the journal.
   */
  summary?: string | null;
  /**
   * Observations (screens looked at with inspect_* / test_step) the change
   * is based on. They are linked to the new revision and its steps.
   */
  observations?: ObservationId[];
}
/**
 * What to review: the changes since the last approval and their evidence.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ReviewTimeline".
 */
export interface ReviewTimeline {
  scenarioId: ScenarioId;
  /**
   * Current revision of the scenario.
   */
  revision: number;
  /**
   * Changes and evidence after this revision are listed (by default the
   * last approved revision, or 0).
   */
  sinceRevision: number;
  lastApproval?: Evidence | null;
  /**
   * The latest review when it sent the scenario back and nobody approved
   * it since: what the AI still has to address.
   */
  openFeedback?: Evidence | null;
  /**
   * Oldest first.
   */
  changes: ChangeRecord[];
  /**
   * Test runs, observations and reviews, oldest first.
   */
  evidence: Evidence[];
}
/**
 * A note on one step in a review.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "StepNote".
 */
export interface StepNote {
  stepId: StepId;
  note: string;
}
/**
 * One change in a review timeline (a journal entry without its ops).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ChangeRecord".
 */
export interface ChangeRecord {
  revision: number;
  kind: ChangeKind;
  actor: Actor;
  at: string;
  label: string;
  summary?: string | null;
  stepIds?: StepId[];
}
/**
 * Input for a review (Studio).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "NewReview".
 */
export interface NewReview {
  /**
   * The revision that was reviewed; must still be the current one.
   */
  revision: number;
  verdict: ReviewVerdict;
  /**
   * Why it was sent back (required for `rejected`) or a remark.
   */
  reason?: string;
  steps?: StepNote[];
}
/**
 * An observation with the contents of its files, for Studio.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ObservationContent".
 */
export interface ObservationContent {
  id: ObservationId;
  source: ObservationSource;
  at: string;
  actor: Actor;
  title: string;
  request: unknown;
  status?: string | null;
  output?: unknown;
  /**
   * File name of the UI tree (`tree.txt`) in the observation's folder.
   */
  treeFile?: string | null;
  /**
   * File name of the screenshot (`screenshot.png` / `.jpg`).
   */
  screenshotFile?: string | null;
  /**
   * What was cut or left out to keep the size down.
   */
  notes?: string[];
  /**
   * Revisions whose edits named this observation as their basis.
   */
  linked?: ObservationLink[];
  tree?: string | null;
  /**
   * `data:image/png;base64,...`
   */
  screenshotDataUrl?: string | null;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ObservationLink".
 */
export interface ObservationLink {
  scenarioId: ScenarioId;
  revision: number;
}
/**
 * The published version of a scenario (what `shikigami run <id>` and
 * other unattended runs execute).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PublishedState".
 */
export interface PublishedState {
  version: number;
  name: string;
  /**
   * Revision the version was taken from.
   */
  revision: number;
  publishedAt: string;
  publishedBy: Actor;
  note?: string;
  /**
   * Whether the current (working) content equals the published version.
   * `false` means there are changes that do not run unattended yet.
   */
  matchesCurrent: boolean;
}
/**
 * Input for publishing.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PublishInput".
 */
export interface PublishInput {
  /**
   * Version to publish. Omitted: the current content, saved as a new
   * version first unless one already matches it.
   */
  version?: number | null;
  /**
   * Name of the version created for the current content (default `v<n>`).
   */
  name?: string | null;
  note?: string;
  /**
   * With `version` omitted: fail with REVISION_CONFLICT unless the
   * current revision is this one (what the person reviewed).
   */
  expectedRevision?: number | null;
}
/**
 * One line of `versions/<scenario-id>/publish.jsonl`: which version runs
 * unattended from now on (`None`: none, the scenario was withdrawn). The
 * last line is in force; earlier lines are the record of who published
 * what, kept in the shared part of the workspace.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PublishRecord".
 */
export interface PublishRecord {
  version?: number | null;
  /**
   * The version's `uid`, so a record never points at another snapshot.
   */
  uid?: string | null;
  at: string;
  by: Actor;
  note?: string;
}
/**
 * `policy.json`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Policy".
 */
export interface Policy {
  formatVersion?: number;
  /**
   * Sites `browser.open`, `http.request` (and plugin steps that declare a
   * site param) may reach: origins such as `https://order.example.co.jp`,
   * or `https://*.example.co.jp` for every subdomain. Empty: any site.
   */
  sites?: string[];
  /**
   * Programs `desktop.launch` and `process.run` may start: a full path
   * (`C:\Program Files\Billing\billing.exe`) or a file name that matches
   * in any folder (`notepad.exe`). Empty: any program.
   */
  apps?: string[];
  ai?: AiPolicy;
  /**
   * Per-scenario settings, keyed by scenario ID.
   */
  scenarios?: {
    [k: string]: ScenarioPolicy;
  };
}
/**
 * What an AI client (MCP) may do. Studio and the CLI are people and are not
 * asked.
 */
export interface AiPolicy {
  runScenario?: ByRisk;
  testStep?: ByRisk1;
  /**
   * `delete_scenario` (moves to the trash).
   */
  deleteScenario?: ("allow" | "deny") | "ask";
}
/**
 * `run_scenario`, by the riskiest step the run may execute (including
 * the scenarios it calls).
 */
export interface ByRisk {
  /**
   * What happens when an AI asks for an action.
   */
  safe?: ("allow" | "deny") | "ask";
  /**
   * What happens when an AI asks for an action.
   */
  interactive?: ("allow" | "deny") | "ask";
  /**
   * What happens when an AI asks for an action.
   */
  dangerous?: ("allow" | "deny") | "ask";
}
/**
 * `test_step`, by the step's risk (a `scenario.call` counts as the
 * riskiest step of the scenarios it calls).
 */
export interface ByRisk1 {
  /**
   * What happens when an AI asks for an action.
   */
  safe?: ("allow" | "deny") | "ask";
  /**
   * What happens when an AI asks for an action.
   */
  interactive?: ("allow" | "deny") | "ask";
  /**
   * What happens when an AI asks for an action.
   */
  dangerous?: ("allow" | "deny") | "ask";
}
/**
 * Settings for one scenario.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ScenarioPolicy".
 */
export interface ScenarioPolicy {
  /**
   * Whether an AI may run or test this scenario. Overrides `ai.runScenario`
   * (and `ai.testStep` for calls of it) when it is stricter.
   */
  aiRun?: Decision | null;
  /**
   * `false`: `shikigami run` (scheduled, unattended) refuses it; it only
   * runs from Studio. Default `true`.
   */
  unattended?: boolean | null;
}
/**
 * One request, `approvals/<id>.json`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ApprovalRequest".
 */
export interface ApprovalRequest {
  id: ApprovalId;
  action: AiAction;
  status: ApprovalStatus;
  requestedAt: string;
  requestedBy: Actor;
  scenarioId?: ScenarioId | null;
  scenarioName?: string | null;
  risk: RiskLevel;
  stepTypes?: string[];
  subject: unknown;
  reason?: string | null;
  decidedAt?: string | null;
  decidedBy?: Actor | null;
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
 * What an AI client (MCP) may do. Studio and the CLI are people and are not
 * asked.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "AiPolicy".
 */
export interface AiPolicy1 {
  runScenario?: ByRisk;
  testStep?: ByRisk1;
  /**
   * `delete_scenario` (moves to the trash).
   */
  deleteScenario?: ("allow" | "deny") | "ask";
}
/**
 * A decision for each step risk level.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ByRisk".
 */
export interface ByRisk2 {
  /**
   * What happens when an AI asks for an action.
   */
  safe?: ("allow" | "deny") | "ask";
  /**
   * What happens when an AI asks for an action.
   */
  interactive?: ("allow" | "deny") | "ask";
  /**
   * What happens when an AI asks for an action.
   */
  dangerous?: ("allow" | "deny") | "ask";
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
  /**
   * The `scenario.call` steps (outermost first) the event happened
   * inside; empty for the scenario that was started. Step IDs in the
   * event belong to the innermost called scenario.
   */
  callPath?: StepId[];
} & RunEventEnvelope1;
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
      type: "variableChanged";
      variable: string;
      value: unknown;
      /**
       * The step that assigned it; absent for inputs and defaults.
       */
      stepId?: StepId | null;
      /**
       * Item index (from 0) of the concurrent `forEach` iteration that
       * made the change, so interleaved iterations can be told apart.
       */
      iteration?: number | null;
      secret?: boolean;
      /**
       * `value` is a preview: a long string cut short, or the start of
       * a large array / object's JSON text.
       */
      truncated?: boolean;
    }
  | {
      type: "log";
      level: LogLevel;
      message: string;
      stepId?: StepId | null;
    }
  | {
      type: "humanActionRequired";
      stepId: StepId;
      message: string;
    }
  | {
      type: "paused";
      stepId: StepId;
      stepType: string;
      reason: PauseReason;
      error?: RunError | null;
      variables: {
        [k: string]: unknown;
      };
      revision: number;
    }
  | {
      type: "resumed";
      action: ResumeAction;
      revision?: number | null;
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
 * Why a run paused.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "PauseReason".
 */
export type PauseReason = "breakpoint" | "step" | "requested" | "error";
/**
 * What a resumed run does next (reported as `resumed`).
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "ResumeAction".
 */
export type ResumeAction =
  "continue" | "stepOver" | "stepInto" | "stepOut" | "retry" | "skip" | "abort";
/**
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunStatus".
 */
export type RunStatus = ("pending" | "running" | "succeeded" | "failed" | "cancelled") | "paused";
/**
 * What a person does with a run (see [`DebugControl::send`]).
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "DebugCommand".
 */
export type DebugCommand =
  | {
      action: "continue";
    }
  | {
      action: "stepOver";
    }
  | {
      action: "stepInto";
    }
  | {
      action: "stepOut";
    }
  | {
      action: "retry";
    }
  | {
      action: "skip";
    }
  | {
      action: "abort";
    }
  | {
      action: "pause";
    }
  | {
      action: "setBreakpoints";
      stepIds: StepId[];
    };

export interface ShikigamiRunApi {
  run_event_envelope: RunEventEnvelope;
  run_report: RunReport;
  run_snapshot: RunSnapshot;
  debug_command: DebugCommand;
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
  /**
   * The scenarios `scenario.call` steps could run, as they were when the
   * run started.
   */
  subscenarios?: SubscenarioRef[];
}
/**
 * A called scenario's content as used by a run.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "SubscenarioRef".
 */
export interface SubscenarioRef {
  scenarioId: ScenarioId;
  scenarioName: string;
  revision: number;
  /**
   * Named version its content matches, if any.
   */
  version?: number | null;
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
