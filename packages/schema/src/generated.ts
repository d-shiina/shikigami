/* eslint-disable */
/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: schemas/*.schema.json (generated from the Rust crates).
 * Regenerate with `pnpm schema:generate`.
 */

/**
 * Identifier of a flow. Also used as its file name in the store.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FlowId".
 */
export type FlowId = string;
/**
 * What a text variable holds ([`VariableDef::format`]).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "VarFormat".
 */
export type VarFormat = "file" | "folder" | "date" | "month";
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
      op: "updateFlow";
      patch: FlowPatch;
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
      op: "setPart";
      name: string;
      part: Part;
    }
  | {
      op: "removePart";
      name: string;
    }
  | {
      op: "replaceSteps";
      steps: Step[];
    };
/**
 * Identifier of a step. Unique within a flow and stable across edits.
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
  | "system"
  | "database";
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
 * What a secret holds, so Studio can name its fields and the AI can tell
 * a login from an API key. Every kind is stored, referenced (`{ "secret",
 * "field" }`), site-checked and masked the same way: the kind only changes
 * how the fields are called and which ones a person fills in.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "SecretKind".
 */
export type SecretKind = "login" | "apiKey" | "oauth";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ChangeKind".
 */
export type ChangeKind = "create" | "edit" | "undo" | "redo" | "delete";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ActorKind".
 */
export type ActorKind = ("studio" | "mcp" | "cli" | "system") | "chat";
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
 * What importing a bundle did with one of its sub-flows.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "SubflowImport".
 */
export type SubflowImport = "created" | "updated" | "kept";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "CheckKind".
 */
export type CheckKind = "plugin" | "secret" | "site" | "app";
/**
 * State of one requirement on this PC.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "CheckStatus".
 */
export type CheckStatus = "ok" | "missing" | "mismatch" | "notAllowed";
/**
 * What to do when an imported flow's ID already exists.
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
 * One line of `history/<flow-id>/evidence.jsonl`.
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
    }
  | {
      kind: "testCase";
      name: string;
      /**
       * The case's `description` when it was saved: the promise in words.
       */
      description?: string | null;
      /**
       * It replaced a case of the same name.
       */
      replaced?: boolean;
    }
  | {
      kind: "testCases";
      results: CaseOutcome[];
    };
/**
 * Identifier of a single flow execution.
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
 * How an unattended run ended, for [`NotifyRule::on`].
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RunOutcome".
 */
export type RunOutcome = "succeeded" | "failed" | "cancelled";
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
export type AiAction = "runFlow" | "testStep" | "deleteFlow";
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
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PartApp".
 */
export type PartApp = "browser" | "desktop";
/**
 * Which content of the flow goes into a package.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageContent".
 */
export type PackageContent = "auto" | "published" | "current";
/**
 * Which versions come along.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageVersions".
 */
export type PackageVersions = "none" | "content" | "all";
/**
 * The shape of the message posted to a webhook.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "NotifyFormat".
 */
export type NotifyFormat = "teams" | "slack" | "json";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ConfigType".
 */
export type ConfigType = ("text" | "number" | "boolean") | "date" | "list";
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ExpectedStatus".
 */
export type ExpectedStatus = "succeeded" | "failed" | "cancelled";

/**
 * Bundle of the IPC/API payload types used by Studio and MCP tools.
 */
export interface ShikigamiApi {
  flow: Flow;
  flow_summary: FlowSummary;
  new_flow: NewFlow;
  edit_op: EditOp;
  edit_outcome: EditOutcome;
  validation_report: ValidationReport1;
  step_type_def: StepTypeDef;
  history_entry: HistoryEntry;
  change_event: ChangeEvent;
  error_payload: ErrorPayload;
  new_version: NewVersion;
  flow_version: FlowVersion;
  version_summary: VersionSummary;
  flow_diff: FlowDiff;
  flow_bundle: FlowBundle;
  import_outcome: ImportOutcome;
  package_manifest: PackageManifest;
  package_plan: PackagePlan;
  package_options: PackageOptions;
  package_preview: PackagePreview;
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
  project_files: ProjectFiles;
  project_file: ProjectFile;
  config_file: ConfigFile;
  test_case: TestCase;
}
/**
 * A flow: the unit that AI clients, Studio and the Runtime share.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Flow".
 */
export interface Flow {
  /**
   * Optional JSON Schema reference for editors. Ignored by Shikigami.
   */
  $schema?: string | null;
  /**
   * Version of the flow file format.
   */
  schemaVersion: number;
  id: FlowId;
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
   * Named screen parts (a button, a field…): a node's `target` can be
   * `{ "part": "<name>" }` instead of the whole target, so a part that
   * changes is fixed in one place. Keys are like variable names.
   */
  parts?: {
    [k: string]: Part;
  };
  /**
   * Top-level steps, executed in order.
   */
  steps?: Step[];
  settings?: FlowSettings;
  metadata?: Metadata;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "VariableDef".
 */
export interface VariableDef {
  /**
   * Identifier used in expressions: letters of any script (orderNo, 受注番号),
   * digits and `_`, not starting with a digit.
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
  /**
   * What a `string` input holds, so the run window can offer the right
   * field (a file picker, a calendar). Runs do not check it.
   */
  format?: VarFormat | null;
  /**
   * The only values an input takes: the run window shows a list to pick
   * from. Each one must match `type`.
   */
  choices?: unknown[];
}
/**
 * A named screen part: what a node finds on screen, kept in one place.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Part".
 */
export interface Part {
  /**
   * What people call it (保存ボタン). The key is for nodes and AI.
   */
  label?: string;
  /**
   * The kind of node that can use it.
   */
  app: "browser" | "desktop";
  /**
   * The target, exactly as the nodes of `app` take it. Left out (null)
   * when the author could not see the screen (an AI in a chat window):
   * a person picks it in Studio, and until then the nodes that use the
   * part do not validate (`PART_NOT_PICKED`).
   */
  target?: {
    [k: string]: unknown;
  };
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
   * Disabled steps are skipped by the Runtime but kept in the flow.
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
 * Flow-wide defaults for error handling, timeouts and retries.
 */
export interface FlowSettings {
  /**
   * Default per-step timeout in milliseconds (30 s when omitted).
   */
  defaultTimeoutMs?: number | null;
  defaultRetry?: RetryPolicy | null;
  onError?: OnError | null;
  /**
   * Leave the files in the flow's `work/` folder when a run starts.
   * By default a run starts with `work/` emptied.
   */
  keepWork?: boolean;
}
export interface Metadata {
  createdAt?: string | null;
  updatedAt?: string | null;
  tags?: string[];
  [k: string]: unknown;
}
/**
 * Listing entry returned by `list_flows`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FlowSummary".
 */
export interface FlowSummary {
  id: FlowId;
  name: string;
  description: string;
  revision: number;
  stepCount: number;
  tags: string[];
  updatedAt?: string | null;
  /**
   * Input variables (`input` and `inOut`), in declared order: what a
   * `flow.call` to it can pass in.
   */
  inputs?: string[];
  /**
   * Output variables (`output` and `inOut`): what a call can receive.
   */
  outputs?: string[];
  /**
   * Secrets its steps refer to by name: the secrets page shows where
   * each one is used.
   */
  secrets?: string[];
}
/**
 * Input for creating a flow.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "NewFlow".
 */
export interface NewFlow {
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
 * Partial update of flow-level fields.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FlowPatch".
 */
export interface FlowPatch {
  name?: string | null;
  description?: string | null;
  settings?: FlowSettings1 | null;
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
 * via the `definition` "FlowSettings".
 */
export interface FlowSettings1 {
  /**
   * Default per-step timeout in milliseconds (30 s when omitted).
   */
  defaultTimeoutMs?: number | null;
  defaultRetry?: RetryPolicy | null;
  onError?: OnError | null;
  /**
   * Leave the files in the flow's `work/` folder when a run starts.
   * By default a run starts with `work/` emptied.
   */
  keepWork?: boolean;
}
/**
 * Result of a committed change.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "EditOutcome".
 */
export interface EditOutcome {
  flow: Flow;
  validation: ValidationReport;
  canUndo: boolean;
  canRedo: boolean;
}
/**
 * Full validation of the new revision. Drafts may contain errors;
 * they must be fixed before the flow can run.
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
   * JSON Pointer into the flow document.
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
   * Params that name a file or folder (a string, or a list of strings).
   * A relative path there is resolved from the flow's folder
   * (`input/orders.xlsx`). File resources are included automatically.
   */
  pathParams?: string[];
  /**
   * Timeout when the step sets none (takes precedence over the
   * flow's default), for steps that wait on people (manual login).
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
 * A plugin (an extension, in Studio) that provides step types, as
 * installed on this PC, with what Studio shows about it.
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
  /**
   * The plugin's display name (its palette group).
   */
  label?: string;
  /**
   * Where its nodes work, shown as the tag before a node's name
   * ("AI-OCR"). Empty: the label.
   */
  tag?: string;
  /**
   * A Lucide icon name for its nodes (`scan-text`).
   */
  icon?: string;
  /**
   * Who makes it.
   */
  publisher?: string;
  /**
   * The registered secrets it takes, by kind, so Studio offers the
   * right ones (and a form of that kind) for its secret params.
   */
  credentials?: PluginCredential[];
  /**
   * What this step does, in one sentence for people (Studio shows it
   * under the node's name; `description` is written for AI clients).
   */
  summary?: string;
  /**
   * What this step sends outside the PC, when it does: shown on the
   * review panel before publishing.
   */
  external?: ExternalUse | null;
}
/**
 * A secret a plugin's steps take: of which kind, and in which params.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PluginCredential".
 */
export interface PluginCredential {
  kind: SecretKind;
  /**
   * What to register, for people ("Azure のキー").
   */
  label: string;
  description?: string;
  /**
   * The step params (in `secretParams`) that take it.
   */
  params: string[];
}
/**
 * Data a step sends to a service outside the PC.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ExternalUse".
 */
export interface ExternalUse {
  /**
   * The service it is sent to ("Azure AI Document Intelligence").
   */
  service: string;
  /**
   * What is sent ("読み取る画像・PDF").
   */
  data: string;
  /**
   * The param holding the address it is sent to, when it has one.
   */
  param?: string | null;
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
   * Revision of the flow after this change.
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
   * What the author asked a person to confirm before approving (an AI's `checks`).
   */
  checks?: string[];
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
  flowId: FlowId;
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
 * One named snapshot of a flow.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FlowVersion".
 */
export interface FlowVersion {
  /**
   * Per-flow sequence number (1, 2, …). This is how versions are referenced.
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
   * Flow revision the snapshot was taken from.
   */
  revision: number;
  flow: Flow;
}
/**
 * Listing entry for versions (no flow body).
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
 * via the `definition` "FlowDiff".
 */
export interface FlowDiff {
  from: DiffSide;
  to: DiffSide;
  /**
   * True when the contents are the same (names, variables, steps, settings).
   */
  identical: boolean;
  /**
   * Flow-level fields: name, description, tags, settings, and each
   * named part (`parts.<name>`; `before` / `after` is absent when it was
   * added / removed).
   */
  flow: FieldChange[];
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
 * File format for moving a flow (and its versions) between workspaces.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FlowBundle".
 */
export interface FlowBundle {
  /**
   * Always `shikigami.flowBundle`.
   */
  format: string;
  formatVersion: number;
  exportedAt: string;
  flow: Flow;
  versions?: FlowVersion[];
  /**
   * Every flow `flow` calls (directly or through others), without
   * versions, so the bundle runs on its own.
   */
  subflows?: Flow[];
  /**
   * Files of the flows' folders (`input/`, `config/`, `templates/`
   * and the author's own; not `output/`, `work/` or `logs/`).
   */
  files?: BundledFile[];
}
/**
 * A file carried in a bundle.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "BundledFile".
 */
export interface BundledFile {
  /**
   * Identifier of a flow. Also used as its file name in the store.
   */
  flowId: string;
  /**
   * Relative to that folder, `/`-separated.
   */
  path: string;
  /**
   * The contents, base64 (standard alphabet, padded).
   */
  data: string;
}
/**
 * Result of importing a bundle or flow file.
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
   * The bundle's sub-flows and what happened to each.
   */
  subflows?: ImportedSubflow[];
  flow: Flow;
  validation: ValidationReport2;
  canUndo: boolean;
  canRedo: boolean;
}
/**
 * One sub-flow of an imported bundle.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ImportedSubflow".
 */
export interface ImportedSubflow {
  id: FlowId;
  name: string;
  mode: SubflowImport;
}
/**
 * Full validation of the new revision. Drafts may contain errors;
 * they must be fixed before the flow can run.
 */
export interface ValidationReport2 {
  valid: boolean;
  issues: ValidationIssue[];
}
/**
 * What a package holds and what the receiving PC needs.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageManifest".
 */
export interface PackageManifest {
  /**
   * Always `spellsheet.package`.
   */
  format: string;
  formatVersion: number;
  exportedAt: string;
  /**
   * Version of SpellSheet that wrote it.
   */
  appVersion: string;
  /**
   * Who wrote it (the Windows user name), when known.
   */
  exportedBy?: string | null;
  flow: PackagedFlow;
  subflows?: PackagedSubflow[];
  requires?: PackageRequires;
  /**
   * Every entry other than the manifest.
   */
  contents: PackageEntry[];
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackagedFlow".
 */
export interface PackagedFlow {
  id: FlowId;
  name: string;
  description?: string;
  /**
   * The version the content is, if it is one.
   */
  version?: PackagedVersion | null;
  /**
   * Whether the content is the version published on the PC it came from.
   */
  published?: boolean;
  /**
   * Steps, nested ones included.
   */
  stepCount?: number;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackagedVersion".
 */
export interface PackagedVersion {
  number: number;
  uid: string;
  name: string;
  note?: string;
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackagedSubflow".
 */
export interface PackagedSubflow {
  id: FlowId;
  name: string;
}
/**
 * What the flow (and the flows it calls) needs on the PC that runs it.
 */
export interface PackageRequires {
  /**
   * `plugin:<name>` → version range, as in `requires`.
   */
  plugins?: {
    [k: string]: string;
  };
  /**
   * Names of the logins (secrets) the steps use. Never their values.
   */
  secrets?: string[];
  /**
   * Sites the steps open (`https://host`), when written out literally.
   */
  sites?: string[];
  /**
   * Programs the steps start, when written out literally.
   */
  apps?: string[];
  /**
   * Inputs asked for when the flow runs (no default value).
   */
  inputs?: PackageInput[];
}
/**
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageInput".
 */
export interface PackageInput {
  name: string;
  description?: string;
}
/**
 * One entry of the zip.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageEntry".
 */
export interface PackageEntry {
  path: string;
  size: number;
  sha256: string;
}
/**
 * What exporting would put in, for the export dialog.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackagePlan".
 */
export interface PackagePlan {
  flowId: FlowId;
  name: string;
  /**
   * The published version, if any.
   */
  published?: PackagedVersion | null;
  /**
   * Whether the current content differs from the published version.
   */
  hasUnpublishedChanges: boolean;
  subflows: PackagedSubflow[];
  files: PackageFileChoice[];
  requires: PackageRequires1;
  /**
   * File name to save as (without folder).
   */
  fileName: string;
}
/**
 * A file that may go into a package, for choosing before exporting.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageFileChoice".
 */
export interface PackageFileChoice {
  flowId: FlowId;
  /**
   * Name of that flow (the main flow or a sub-flow).
   */
  flowName: string;
  path: string;
  size: number;
  /**
   * Whether it goes in with the default options (`input/` does not).
   */
  includedByDefault: boolean;
}
/**
 * What the flow (and the flows it calls) needs on the PC that runs it.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageRequires".
 */
export interface PackageRequires1 {
  /**
   * `plugin:<name>` → version range, as in `requires`.
   */
  plugins?: {
    [k: string]: string;
  };
  /**
   * Names of the logins (secrets) the steps use. Never their values.
   */
  secrets?: string[];
  /**
   * Sites the steps open (`https://host`), when written out literally.
   */
  sites?: string[];
  /**
   * Programs the steps start, when written out literally.
   */
  apps?: string[];
  /**
   * Inputs asked for when the flow runs (no default value).
   */
  inputs?: PackageInput[];
}
/**
 * Options of [`crate::FlowService::export_package`].
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackageOptions".
 */
export interface PackageOptions {
  /**
   * Which content of the flow goes into a package.
   */
  content?: "auto" | "published" | "current";
  /**
   * Which versions come along.
   */
  versions?: "none" | "content" | "all";
  /**
   * Include files under `input/`. Off by default: they are usually real
   * business data (and may hold personal data).
   */
  includeInput?: boolean;
  /**
   * Files to leave out (after `include_input`).
   */
  exclude?: FileRef[];
  /**
   * Shown to the receiver as who wrote the package.
   */
  exportedBy?: string | null;
}
/**
 * A file of a flow's folder, by flow and path.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FileRef".
 */
export interface FileRef {
  flowId: FlowId;
  path: string;
}
/**
 * What importing a package would do, shown before importing.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "PackagePreview".
 */
export interface PackagePreview {
  manifest: PackageManifest;
  existing?: ExistingFlow | null;
  checks: RequirementCheck[];
}
/**
 * The flow with the same ID that is already in the workspace.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ExistingFlow".
 */
export interface ExistingFlow {
  name: string;
  /**
   * Newest version here.
   */
  latestVersion?: number | null;
  /**
   * Published version here.
   */
  publishedVersion?: number | null;
  /**
   * The package's version is already here (same `uid`).
   */
  hasPackageVersion: boolean;
  diff: FlowDiff1;
}
/**
 * Differences from `from` to `to`.
 */
export interface FlowDiff1 {
  from: DiffSide;
  to: DiffSide;
  /**
   * True when the contents are the same (names, variables, steps, settings).
   */
  identical: boolean;
  /**
   * Flow-level fields: name, description, tags, settings, and each
   * named part (`parts.<name>`; `before` / `after` is absent when it was
   * added / removed).
   */
  flow: FieldChange[];
  variables: VariableChange[];
  steps: StepChange[];
}
/**
 * One thing the package needs, checked against this PC.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RequirementCheck".
 */
export interface RequirementCheck {
  kind: CheckKind;
  /**
   * Plugin name, login name, site origin or program.
   */
  name: string;
  /**
   * Version range for plugins.
   */
  range?: string | null;
  /**
   * Installed version when it does not match.
   */
  installed?: string | null;
  status: CheckStatus;
}
/**
 * Result of moving steps into a new sub-flow.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ExtractOutcome".
 */
export interface ExtractOutcome {
  subflow: EditOutcome1;
  caller: EditOutcome2;
  /**
   * Identifier of a step. Unique within a flow and stable across edits.
   */
  callStepId: string;
}
/**
 * Result of a committed change.
 */
export interface EditOutcome1 {
  flow: Flow;
  validation: ValidationReport;
  canUndo: boolean;
  canRedo: boolean;
}
/**
 * Result of a committed change.
 */
export interface EditOutcome2 {
  flow: Flow;
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
   * Things the author wants a person to decide or confirm before the change
   * is approved (assumptions, guesses), one question each. Kept in the journal.
   */
  checks?: string[];
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
  flowId: FlowId;
  /**
   * Current revision of the flow.
   */
  revision: number;
  /**
   * Changes and evidence after this revision are listed (by default the
   * last approved revision, or 0).
   */
  sinceRevision: number;
  lastApproval?: Evidence | null;
  /**
   * The latest review when it sent the flow back and nobody approved
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
 * How one test case went in a `testCases` record.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "CaseOutcome".
 */
export interface CaseOutcome {
  name: string;
  passed: boolean;
  runId: string;
  /**
   * How the run ended (`succeeded`, `failed`, `cancelled`).
   */
  status: string;
  mismatches?: Mismatch[];
}
/**
 * One difference between what the case expects and what the run did.
 * `actual` is `null` when the run had no such value.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Mismatch".
 */
export interface Mismatch {
  /**
   * `status`, `outputs.total`, `outputs.rows[2].金額`, `errorCode`, `errorStep`.
   */
  at: string;
  expected: unknown;
  actual: unknown;
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
  checks?: string[];
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
  flowId: FlowId;
  revision: number;
}
/**
 * The published version of a flow (what `spellsheet run <id>` and
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
 * One line of `versions/<flow-id>/publish.jsonl`: which version runs
 * unattended from now on (`None`: none, the flow was withdrawn). The
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
   * Per-flow settings, keyed by flow ID.
   */
  flows?: {
    [k: string]: FlowPolicy;
  };
  records?: RecordsPolicy;
  remote?: RemotePolicy;
  /**
   * Who hears about unattended runs (the agent's and `spellsheet run`).
   */
  notify?: NotifyRule[];
  desktop?: DesktopPolicy;
}
/**
 * What an AI client (MCP) may do. Studio and the CLI are people and are not
 * asked.
 */
export interface AiPolicy {
  runFlow?: ByRisk;
  testStep?: ByRisk1;
  /**
   * `delete_flow` (moves to the trash).
   */
  deleteFlow?: ("allow" | "deny") | "ask";
}
/**
 * `run_flow`, by the riskiest step the run may execute (including
 * the flows it calls).
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
 * `test_step`, by the step's risk (a `flow.call` counts as the
 * riskiest step of the flows it calls).
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
 * Settings for one flow.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "FlowPolicy".
 */
export interface FlowPolicy {
  /**
   * Whether an AI may run or test this flow. Overrides `ai.runFlow`
   * (and `ai.testStep` for calls of it) when it is stricter.
   */
  aiRun?: Decision | null;
  /**
   * `false`: `spellsheet run` (scheduled, unattended) refuses it; it only
   * runs from Studio. Default `true`.
   */
  unattended?: boolean | null;
}
/**
 * How long this PC keeps run records (`runs/`).
 */
export interface RecordsPolicy {
  /**
   * Delete run records older than this many days.
   */
  keepDays?: number | null;
  /**
   * Keep at most this many run records (the newest).
   */
  keepRuns?: number | null;
  /**
   * When a run fails at a browser or desktop step, keep a picture of that
   * screen beside the run's log (`logs/<time>_failed.png`). On unless `false`.
   */
  failureScreenshots?: boolean | null;
  /**
   * When the flow is run from Studio, keep a picture of the screen at
   * each browser or desktop step (the first time it runs) for the
   * flow's 手順書. The pictures stay on this PC. On unless `false`.
   */
  manualScreens?: boolean | null;
}
/**
 * Runs asked for by a management server (see
 * docs/design/remote-runs.md). Off unless enabled here.
 */
export interface RemotePolicy {
  /**
   * Connect to the management server at all.
   */
  enabled?: boolean;
  /**
   * The management server's URL (`https://…`).
   */
  manager?: string | null;
  /**
   * Flow IDs it may start (`"*"` for every flow). Empty: none.
   */
  flows?: string[];
  /**
   * Run flows the server sends as bundles (not only the published
   * versions in this workspace).
   */
  acceptBundles?: boolean;
}
/**
 * One place unattended runs are reported to.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "NotifyRule".
 */
export interface NotifyRule {
  /**
   * Which endings to report. Default: failures only.
   */
  on?: RunOutcome[];
  /**
   * Only these flow IDs (default: every flow).
   */
  flows?: string[];
  /**
   * The webhook URL (`https://`). Anyone with it can post to the channel:
   * treat it like a password.
   */
  webhook: string;
  /**
   * The shape of the message posted to a webhook.
   */
  format?: "teams" | "slack" | "json";
}
/**
 * Nodes that use the mouse and keyboard when the screen is locked.
 */
export interface DesktopPolicy {
  /**
   * Wait up to this many minutes for someone to unlock the screen before
   * stopping with `DESKTOP_UNAVAILABLE`. Without it (or 0) they stop at
   * once. For PCs with people at them: the run goes on after lunch.
   */
  waitUnlockedMinutes?: number | null;
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
  flowId?: FlowId | null;
  flowName?: string | null;
  risk: RiskLevel;
  stepTypes?: string[];
  subject: unknown;
  reason?: string | null;
  decidedAt?: string | null;
  decidedBy?: Actor | null;
}
/**
 * What a flow's project folder holds.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ProjectFiles".
 */
export interface ProjectFiles {
  flowId: FlowId;
  /**
   * Absolute path of the folder.
   */
  dir: string;
  /**
   * Every folder, relative and `/`-separated: the standard ones first,
   * then the author's own (`input/2026`), sorted.
   */
  folders: string[];
  /**
   * Every file except `flow.json`, sorted by path.
   */
  files: ProjectFile[];
}
/**
 * One file in a project folder.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ProjectFile".
 */
export interface ProjectFile {
  /**
   * Relative to the project folder, `/`-separated (`input/orders.xlsx`).
   * Write it as is in a step's path param.
   */
  path: string;
  size: number;
  modified?: string | null;
  /**
   * Open in Excel or Word (their `~$` owner file is next to it): a run
   * that writes it fails with `FILE_IN_USE`.
   */
  inUse?: boolean;
}
/**
 * A settings file (`config/*.json`) kept out of the flow: values a
 * person changes without touching the flow (a cut-off day, a recipient, a
 * folder). Studio edits it as a form; `config.read` turns it into
 * `{ "締め日": 25, … }`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ConfigFile".
 */
export interface ConfigFile {
  /**
   * Always `shikigami.config`.
   */
  format: string;
  items?: ConfigItem[];
}
/**
 * One setting of a [`ConfigFile`].
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "ConfigItem".
 */
export interface ConfigItem {
  /**
   * The key in the object `config.read` returns (`settings.締め日`).
   */
  name: string;
  type?: ("text" | "number" | "boolean") | "date" | "list";
  value?: {
    [k: string]: unknown;
  };
  /**
   * What the setting is for, shown under it in the form.
   */
  description?: string;
}
/**
 * One test case, `tests/<name>.json`.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "TestCase".
 */
export interface TestCase {
  /**
   * `https://…/test-case.schema.json`, for editors (optional, not used).
   */
  $schema?: string | null;
  /**
   * What the case is about, in the author's words.
   */
  description?: string | null;
  /**
   * Values of the flow's input variables, as `spellsheet run -i` takes them.
   */
  inputs?: {
    [k: string]: unknown;
  };
  expect?: Expect;
}
/**
 * What should come out of the run.
 */
export interface Expect {
  /**
   * How the run ends. `failed` for a case that checks an error is raised.
   */
  status?: "succeeded" | "failed" | "cancelled";
  /**
   * Output variables to compare (a subset, see the module docs).
   */
  outputs?: {
    [k: string]: unknown;
  };
  /**
   * The error's code, when `status` is `failed` (e.g. `ELEMENT_NOT_FOUND`).
   */
  errorCode?: string | null;
  /**
   * The node the run should stop at, when `status` is `failed`.
   */
  errorStep?: string | null;
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
  runFlow?: ByRisk;
  testStep?: ByRisk1;
  /**
   * `delete_flow` (moves to the trash).
   */
  deleteFlow?: ("allow" | "deny") | "ask";
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
 * How long run records are kept. Each PC applies it to its own records;
 * without a limit they are kept until deleted by hand.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RecordsPolicy".
 */
export interface RecordsPolicy1 {
  /**
   * Delete run records older than this many days.
   */
  keepDays?: number | null;
  /**
   * Keep at most this many run records (the newest).
   */
  keepRuns?: number | null;
  /**
   * When a run fails at a browser or desktop step, keep a picture of that
   * screen beside the run's log (`logs/<time>_failed.png`). On unless `false`.
   */
  failureScreenshots?: boolean | null;
  /**
   * When the flow is run from Studio, keep a picture of the screen at
   * each browser or desktop step (the first time it runs) for the
   * flow's 手順書. The pictures stay on this PC. On unless `false`.
   */
  manualScreens?: boolean | null;
}
/**
 * Runs a management server may ask this PC for. Everything is closed by
 * default; `flows.<id>.unattended: false` still refuses a flow.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "RemotePolicy".
 */
export interface RemotePolicy1 {
  /**
   * Connect to the management server at all.
   */
  enabled?: boolean;
  /**
   * The management server's URL (`https://…`).
   */
  manager?: string | null;
  /**
   * Flow IDs it may start (`"*"` for every flow). Empty: none.
   */
  flows?: string[];
  /**
   * Run flows the server sends as bundles (not only the published
   * versions in this workspace).
   */
  acceptBundles?: boolean;
}
/**
 * What nodes that use the mouse and keyboard do while the screen is
 * locked (docs/design/locked-runs.md).
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "DesktopPolicy".
 */
export interface DesktopPolicy1 {
  /**
   * Wait up to this many minutes for someone to unlock the screen before
   * stopping with `DESKTOP_UNAVAILABLE`. Without it (or 0) they stop at
   * once. For PCs with people at them: the run goes on after lunch.
   */
  waitUnlockedMinutes?: number | null;
}
/**
 * What should come out of the run.
 *
 * This interface was referenced by `ShikigamiApi`'s JSON-Schema
 * via the `definition` "Expect".
 */
export interface Expect1 {
  /**
   * How the run ends. `failed` for a case that checks an error is raised.
   */
  status?: "succeeded" | "failed" | "cancelled";
  /**
   * Output variables to compare (a subset, see the module docs).
   */
  outputs?: {
    [k: string]: unknown;
  };
  /**
   * The error's code, when `status` is `failed` (e.g. `ELEMENT_NOT_FOUND`).
   */
  errorCode?: string | null;
  /**
   * The node the run should stop at, when `status` is `failed`.
   */
  errorStep?: string | null;
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
   * The `flow.call` steps (outermost first) the event happened
   * inside; empty for the flow that was started. Step IDs in the
   * event belong to the innermost called flow.
   */
  callPath?: StepId[];
} & RunEventEnvelope1;
export type RunEventEnvelope1 =
  | {
      type: "runStarted";
      flowId: FlowId;
      flowName: string;
      revision: number;
      origin?: RunOrigin;
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
      type: "loopRound";
      stepId: StepId;
      round: number;
      total?: number | null;
    }
  | {
      type: "loopEnded";
      stepId: StepId;
      rounds: number;
      total?: number | null;
      leftEarly?: boolean;
    }
  | {
      type: "screenCaptured";
      stepId: StepId;
      file: string;
      width: number;
      height: number;
      mark?: ScreenRect | null;
      regions?: ScreenRect[];
      /**
       * The page's or window's title, secrets masked.
       */
      title?: string | null;
      /**
       * Equal for two pictures of the same view (the same address
       * scrolled to the same place): their marks share one picture.
       * An opaque digest.
       */
      view?: string | null;
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
 * How a run was started.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunTrigger".
 */
export type RunTrigger = "studio" | "mcp" | "cli" | "schedule" | "remote";
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
    }
  | {
      action: "setVariable";
      name: string;
      value: unknown;
    };

export interface ShikigamiRunApi {
  run_event_envelope: RunEventEnvelope;
  run_report: RunReport;
  run_snapshot: RunSnapshot;
  debug_command: DebugCommand;
  case_result: CaseResult;
}
/**
 * Who asked for the run, from where, on which PC.
 */
export interface RunOrigin {
  trigger?: RunTrigger | null;
  /**
   * The person, AI client, schedule or manager that asked, in its own
   * words (e.g. "claude-code", a schedule's name).
   */
  requestedBy?: string | null;
  /**
   * The job of a schedule or management server this run carries out.
   */
  jobId?: string | null;
  /**
   * The PC the run happened on (its computer name). Filled in by the
   * Runtime when not given.
   */
  machine?: string | null;
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
   * The node as people know it: its name, else its type's label. Set on
   * the run's final error (report, notifications), so the place can be
   * told without the flow at hand; `stepId` stays the key to the node.
   */
  stepLabel?: string | null;
  /**
   * Adapter-specific evidence: UI element snapshot, screenshot path,
   * expected vs. actual state, etc.
   */
  details?: {
    [k: string]: unknown;
  };
}
/**
 * A rectangle in a picture's pixels, from its top-left corner.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "ScreenRect".
 */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * Final result of a run.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunReport".
 */
export interface RunReport {
  runId: RunId;
  flowId: FlowId;
  flowName: string;
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
   * The flows `flow.call` steps could run, as they were when the
   * run started.
   */
  subflows?: SubflowRef[];
  origin?: RunOrigin1;
  /**
   * Names of the secrets the run used (typed values, API auth, saved
   * logins, OAuth tokens), never their values.
   */
  secretsUsed?: string[];
}
/**
 * A called flow's content as used by a run.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "SubflowRef".
 */
export interface SubflowRef {
  flowId: FlowId;
  flowName: string;
  revision: number;
  /**
   * Named version its content matches, if any.
   */
  version?: number | null;
}
/**
 * Who asked for the run, from where, on which PC.
 */
export interface RunOrigin1 {
  trigger?: RunTrigger | null;
  /**
   * The person, AI client, schedule or manager that asked, in its own
   * words (e.g. "claude-code", a schedule's name).
   */
  requestedBy?: string | null;
  /**
   * The job of a schedule or management server this run carries out.
   */
  jobId?: string | null;
  /**
   * The PC the run happened on (its computer name). Filled in by the
   * Runtime when not given.
   */
  machine?: string | null;
}
/**
 * Live state of a run, for `get_run_status` while it is executing.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunSnapshot".
 */
export interface RunSnapshot {
  runId: RunId;
  flowId: FlowId;
  status: RunStatus;
  currentStep?: StepId | null;
  stepsExecuted: number;
}
/**
 * One test case's run, compared with what it expects.
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "CaseResult".
 */
export interface CaseResult {
  name: string;
  description?: string | null;
  passed: boolean;
  runId: string;
  status: RunStatus;
  error?: RunError | null;
  mismatches: Mismatch[];
  durationMs: number;
}
/**
 * Who asked for a run, from where, and on which PC. Recorded in
 * `runStarted` and the report so that runs can be told apart later (and
 * collected from many PCs).
 *
 * This interface was referenced by `ShikigamiRunApi`'s JSON-Schema
 * via the `definition` "RunOrigin".
 */
export interface RunOrigin2 {
  trigger?: RunTrigger | null;
  /**
   * The person, AI client, schedule or manager that asked, in its own
   * words (e.g. "claude-code", a schedule's name).
   */
  requestedBy?: string | null;
  /**
   * The job of a schedule or management server this run carries out.
   */
  jobId?: string | null;
  /**
   * The PC the run happened on (its computer name). Filled in by the
   * Runtime when not given.
   */
  machine?: string | null;
}
