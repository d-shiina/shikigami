// Typed bridge to the Rust backend. Every call maps 1:1 to a Tauri command,
// which in turn is a thin wrapper over FlowService / Runtime. The
// frontend never edits flow documents itself; it only sends EditOps.
import type {
  ApprovalRequest,
  CaseResult,
  TestCase,
  DebugCommand,
  EditOp,
  EditOutcome,
  ErrorPayload,
  Evidence,
  ExtractOutcome,
  HistoryEntry,
  ImportConflict,
  ImportOutcome,
  NewReview,
  NewFlow,
  NewVersion,
  ObservationContent,
  Policy,
  PublishInput,
  PublishedState,
  ReviewTimeline,
  RunEventEnvelope,
  RunReport,
  RunSnapshot,
  Flow,
  FlowDiff,
  FlowSummary,
  StepTypeDef,
  ValidationReport,
  VersionSummary,
  WorkspaceInfo,
} from "@shikigami/schema";
import { isErrorPayload } from "@shikigami/schema";
import type { LogLevel, RunError, RunStatus } from "@shikigami/schema";

/** What a node run alone gave (Tauri `test_step`). */
export type StepTestResult = {
  status: RunStatus;
  output: unknown;
  error?: RunError;
  logs: { level: LogLevel; message: string }[];
};
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Why a pasted answer could not be read, written for the AI that wrote it. */
export type AnswerProblem = {
  path?: string;
  message: string;
  /** The node the problem is in, by its name (or type). */
  step?: string;
  /** What the answer has at `path`, as JSON (shortened). */
  found?: string;
};
/** The flow a pasted answer made or changed, or the problems to send back (nothing changed then). */
export type PasteOutcome = { outcome?: EditOutcome; problems: AnswerProblem[] };

/** When a schedule fires (docs/schedules.md). Times are local, "08:00". */
export type ScheduleWhen =
  | { kind: "daily"; at: string; days?: string[]; skipHolidays?: boolean }
  | { kind: "monthly"; day: number; at: string; businessDay?: boolean; onHoliday?: "before" | "after" | "skip" }
  | { kind: "every"; minutes: number; from?: string; to?: string; days?: string[]; skipHolidays?: boolean }
  | { kind: "once"; at: string }
  | { kind: "fileAdded"; folder: string; pattern: string; input?: string }
  | {
      kind: "mailReceived";
      folder?: string;
      subjectContains?: string;
      fromContains?: string;
      via?: "outlook" | "microsoft365";
      account?: { secret: string; field: "accessToken" };
      minutes?: number;
      input?: string;
    };

/** One schedule of this PC (`schedules.json`). `id` is empty for a new one. */
export type Schedule = {
  id: string;
  name: string;
  flowId: string;
  enabled: boolean;
  when: ScheduleWhen;
  inputs?: Record<string, unknown>;
};

export type ScheduleView = Schedule & { flowName: string | null; published: boolean };

export type ScheduleList = { schedules: ScheduleView[]; path: string };

/** The agent of this PC and workspace, which fires the schedules. */
export type AgentStatus = {
  pid: number;
  startedAt: string;
  workspace: string;
  running: { runId: string; flowId: string; flowName: string; startedAt: string; scheduleId?: string }[];
  schedules: { id: string; name: string; flowId: string; enabled: boolean; next?: string; last?: string }[];
  problem?: string;
};

/** `accessToken` is obtained by oauth.signIn, not typed by a person. */
export type SecretField = "username" | "password" | "totp" | "accessToken";

/**
 * What a secret holds. Stored, referenced and checked the same way: the kind
 * only names the fields and picks the ones a person fills in.
 */
export type SecretKind = "login" | "apiKey" | "oauth";

/** The OAuth tokens oauth.signIn saved (never the tokens themselves). */
export type OAuthStatus = {
  expiresAt?: string;
  /** When the provider last gave tokens (sign-in or refresh). */
  obtainedAt?: string;
  /** A refresh token is kept: an expired access token is renewed without a person. */
  refreshable: boolean;
};

/** A registered secret as Studio lists it: never the password or TOTP key. */
export type SecretInfo = {
  name: string;
  kind: SecretKind;
  username: string;
  sites: string[];
  fields: SecretField[];
  description?: string;
  /** oauth.signIn saved tokens for it. */
  signedIn?: boolean;
  oauth?: OAuthStatus;
  /** The user name and password are read from this generic credential of Windows Credential Manager. */
  windowsCredential?: string;
  updatedAt: string;
};

/** A generic credential of Windows Credential Manager (never its password). */
export type WindowsCredentialInfo = { target: string; username?: string };

/** Registers or updates a secret; fields left out keep their stored value. */
export type SecretInput = {
  name: string;
  /** Fields the kind does not use are removed. */
  kind?: SecretKind;
  username?: string;
  password?: string;
  totp?: string;
  sites?: string[];
  description?: string;
  /** Read the user name and password from this Windows credential; "" keeps them in Shikigami again. */
  windowsCredential?: string;
};

/** A login an AI asked the user for (request_secret): names and sites only. */
export type SecretRequest = {
  name: string;
  /** What the AI asked for; a login when left out. */
  kind?: SecretKind;
  sites: string[];
  fields: SecretField[];
  /** Written by the AI: shown as its words. */
  reason?: string;
  requestedAt: string;
  /** What the registered secret (if any) still lacks. */
  missing: { registered: boolean; fields: SecretField[]; sites: string[] };
};

/** An AI waiting for the person to point at something in the browser (ask_user_to_pick). */
export type PickRequest = {
  id: string;
  /** Written by the AI: shown as its words. */
  message: string;
  url?: string;
  /** How many elements the AI outlined with numbers on the page. */
  candidates: number;
  requestedAt: string;
};

/** The screen a run paused on (see `capture_pause`). */
export type RunEvidence = {
  runId: string;
  /** The `paused` event it belongs to. */
  seq: number;
  stepId: string;
  observation?: ObservationContent;
  /** Why there is no observation. */
  problem?: string;
};

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = "ApiError";
    this.code = payload.code;
    this.details = payload.details;
  }
}

export type RunRecord = { report: RunReport | null; events: RunEventEnvelope[]; truncated: boolean };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    if (isErrorPayload(e)) throw new ApiError(e);
    throw new ApiError({ code: "IPC_ERROR", message: String(e) });
  }
}

/** A node of an extension, as its manifest declares it. */
export type ExtensionStep = { type: string; label: string; risk: StepTypeDef["risk"]; external?: { service: string; data: string } | null };

/** What an extension's manifest says (`shikigami_plugins::install::manifest_summary`). */
export type ExtensionSummary = {
  name: string;
  version?: string;
  label: string;
  description?: string;
  publisher?: string;
  homepage?: string;
  tag?: string;
  icon?: string;
  /** The program it starts ("node main.mjs"). */
  program?: string;
  credentials?: { kind: SecretKind; label: string; description?: string }[];
  steps?: ExtensionStep[];
};

/** An extension folder on this PC. */
export type InstalledExtension = ExtensionSummary & {
  dir: string;
  enabled: boolean;
  /** Installed by Shikigami (else a developer's SHIKIGAMI_PLUGINS folder: listed only). */
  managed: boolean;
  source?: { source: ExtensionSource; installedAt: string };
  /** Why it cannot be loaded. */
  problems: string[];
};

export type ExtensionSource = { kind: "file"; path: string } | { kind: "url"; url: string } | { kind: "github"; repo: string };

/** A downloaded and checked extension, before it is installed. */
export type ExtensionPreview = ExtensionSummary & { id: string; source: ExtensionSource; installedVersion: string | null };

export type ExtensionList = { root: string; installed: InstalledExtension[]; registry: string | null; restartNeeded: boolean };

/** One extension a registry index offers. */
export type RegistryEntry = { name: string; label: string; description?: string; version?: string; publisher?: string; homepage?: string; source: string };

export const extensionsApi = {
  list: () => call<ExtensionList>("list_extensions"),
  /** Downloads and checks; installs nothing. */
  stage: (source: string) => call<ExtensionPreview>("stage_extension", { source }),
  stageUpdate: (name: string) => call<ExtensionPreview>("stage_extension_update", { name }),
  install: (id: string) => call<void>("install_extension", { id }),
  discard: (id: string) => call<void>("discard_extension", { id }),
  setEnabled: (name: string, enabled: boolean) => call<void>("set_extension_enabled", { name, enabled }),
  uninstall: (name: string) => call<void>("uninstall_extension", { name }),
  setRegistry: (url: string) => call<void>("set_extension_registry", { url }),
  registry: () => call<RegistryEntry[]>("fetch_extension_registry"),
  restart: () => call<void>("restart_for_extensions"),
  /** A zip file picked in the file dialog, or null. */
  pickZip: () => call<string | null>("runner_pick", { kind: "file", start: null }),
};

export const api = {
  /** The clipboard's text, read by Studio itself (no WebView permission prompt). */
  readClipboardText: () => call<string>("read_clipboard_text"),
  workspaceInfo: () => call<WorkspaceInfo>("workspace_info"),
  /** Saves the default workspace and restarts Studio on it. */
  setWorkspace: (path: string, shared: boolean) => call<void>("set_workspace", { path, shared }),
  listVersions: (id: string) => call<VersionSummary[]>("list_versions", { id }),
  createVersion: (id: string, expectedRevision: number, input: NewVersion) =>
    call<VersionSummary>("create_version", { id, expectedRevision, input }),
  /** `from` / `to` are version numbers; omitted means the current content. */
  diffVersions: (id: string, from?: number, to?: number) =>
    call<FlowDiff>("diff_versions", { id, from, to }),
  restoreVersion: (id: string, number: number, expectedRevision: number) =>
    call<EditOutcome>("restore_version", { id, number, expectedRevision }),
  /** The version unattended runs (`shikigami run <id>`) execute; null when none is published. */
  publishedState: (id: string) => call<PublishedState | null>("published_state", { id }),
  publishFlow: (id: string, input: PublishInput) => call<PublishedState>("publish_flow", { id, input }),
  /** The review desk's 「残して本番に使う」: approves `revision` and publishes it in one step. */
  approveAndPublish: (id: string, revision: number, reason?: string) =>
    call<PublishedState>("approve_and_publish", { id, revision, reason }),
  unpublishFlow: (id: string) => call<void>("unpublish_flow", { id }),
  getPolicy: () => call<Policy>("get_policy"),
  listSchedules: () => call<ScheduleList>("list_schedules"),
  saveSchedule: (schedule: Schedule) => call<ScheduleList>("save_schedule", { schedule }),
  deleteSchedule: (id: string) => call<ScheduleList>("delete_schedule", { id }),
  /** null when the agent is not running: schedules do not fire then. */
  agentStatus: () => call<AgentStatus | null>("agent_status"),
  startAgent: () => call<AgentStatus | null>("start_agent"),
  stopAgent: () => call<void>("stop_agent"),
  savePolicy: (policy: Policy) => call<Policy>("save_policy", { policy }),
  /** Requests from AI clients waiting for the person's approval. */
  listApprovals: () => call<ApprovalRequest[]>("list_approvals"),
  decideApproval: (id: string, approve: boolean) => call<ApprovalRequest>("decide_approval", { id, approve }),
  /** AI clients waiting for the person to point at something in the browser. */
  listPickRequests: () => call<PickRequest[]>("list_pick_requests"),
  cancelPickRequest: (id: string) => call<void>("cancel_pick_request", { id }),
  /** Writes a bundle to the Downloads folder; returns its path. */
  exportFlow: (id: string) => call<string>("export_flow", { id }),
  /** Writes the guide for an AI without MCP into Downloads and opens the folder; returns its path. */
  saveAiGuide: () => call<string>("save_ai_guide"),
  /** Takes in an answer pasted from an AI chat: a new flow, or the new content of `into`. */
  pasteAiAnswer: (text: string, into?: string, expectedRevision?: number) =>
    call<PasteOutcome>("paste_ai_answer", { text, into, expectedRevision }),
  importFlow: (contents: string, onConflict?: ImportConflict) =>
    call<ImportOutcome>("import_flow", { contents, onConflict }),
  listFlows: () => call<FlowSummary[]>("list_flows"),
  getFlow: (id: string) => call<Flow>("get_flow", { id }),
  createFlow: (input: NewFlow) => call<EditOutcome>("create_flow", { input }),
  duplicateFlow: (id: string, name?: string) =>
    call<EditOutcome>("duplicate_flow", { id, name }),
  deleteFlow: (id: string, expectedRevision?: number) =>
    call<void>("delete_flow", { id, expectedRevision }),
  edit: (id: string, expectedRevision: number, ops: EditOp[]) =>
    call<EditOutcome>("edit_flow", { id, expectedRevision, ops }),
  /** Moves neighbouring steps into a new flow and calls it from where they were. */
  extractSubflow: (id: string, expectedRevision: number, stepIds: string[], name: string) =>
    call<ExtractOutcome>("extract_subflow", { id, expectedRevision, stepIds, name }),
  undo: (id: string, expectedRevision: number) =>
    call<EditOutcome>("undo", { id, expectedRevision }),
  redo: (id: string, expectedRevision: number) =>
    call<EditOutcome>("redo", { id, expectedRevision }),
  undoState: (id: string) => call<{ canUndo: boolean; canRedo: boolean }>("undo_state", { id }),
  validate: (id: string) => call<ValidationReport>("validate_flow", { id }),
  listStepTypes: () => call<StepTypeDef[]>("list_step_types"),
  /** Evaluates an expression with the given variable values (no side effects). */
  /** The columns of the table a node reads (Excel sheet, CSV), read from its file now; [] when unknown. */
  tableColumns: (id: string, stepType: string, params: Record<string, unknown>) => call<string[]>("table_columns", { id, stepType, params }),
  evalExpression: (expression: string, values: Record<string, unknown>) => call<unknown>("eval_expression", { expression, values }),
  history: (id: string, limit = 100) => call<HistoryEntry[]>("flow_history", { id, limit }),
  reviewTimeline: (id: string, since?: number) => call<ReviewTimeline>("review_timeline", { id, since }),
  submitReview: (id: string, input: NewReview) => call<Evidence>("submit_review", { id, input }),
  getObservation: (id: string) => call<ObservationContent>("get_observation", { id }),
  /** A finished run's report and events (runs/<id>/), for what an AI test run did. */
  runRecord: (runId: string) => call<RunRecord>("run_record", { runId }),
  /** Studio runs pause on unhandled errors and at `debug.breakpoints`; `debug.step` pauses before the first step. */
  run: (
    id: string,
    inputs?: Record<string, unknown>,
    debug?: { breakpoints: string[]; step?: boolean; startAt?: string; startValues?: Record<string, unknown> },
  ) =>
    call<string>("run_flow", { id, inputs, debug }),
  /** Step commands for a paused run; resuming swaps in the stored revision first (e.g. the AI's fix). */
  debugRun: (runId: string, command: DebugCommand) =>
    call<{ revision: number; updated: boolean }>("debug_run", { runId, command }),
  stopRun: (runId: string) => call<void>("stop_run", { runId }),
  /** 「ノードの単体実行」: only the node runs, reading `values`; not recorded as a run. */
  testStep: (id: string, stepId: string, values: Record<string, unknown>) => call<StepTestResult>("test_step", { id, stepId, values }),
  /** The flow's test cases (tests/<name>.json), in name order. */
  listTestCases: (id: string) => call<{ name: string; case: TestCase }[]>("list_test_cases", { id }),
  saveTestCase: (id: string, name: string, testCase: TestCase) => call<void>("save_test_case", { id, name, case: testCase }),
  deleteTestCase: (id: string, name: string) => call<void>("delete_test_case", { id, name }),
  /** 「この実行をテストケースとして保存」: `leftOut` names the secret and cut values not kept. */
  testCaseFromRun: (id: string, runId: string, name: string) =>
    call<{ name: string; case: TestCase; leftOut: string[] }>("test_case_from_run", { id, runId, name }),
  /** Runs the cases (all, or `names`) one after another with the working content. */
  runTests: (id: string, names?: string[]) => call<CaseResult[]>("run_tests", { id, names }),
  stopTests: () => call<void>("stop_tests"),
  /** The picker (`action: "pick"`) and highlight (`action: "highlight"`) of an adapter. */
  /** `flowId`: relative picture paths (templates/…) are found in that flow's folder. */
  pointAt: (adapter: string, params: Record<string, unknown>, session?: string, flowId?: string) =>
    call<Record<string, unknown>>("point_at", { adapter, session, flowId, params }),
  runStatus: (runId: string) => call<RunSnapshot | null>("run_status", { runId }),
  listSecrets: () => call<{ secrets: SecretInfo[]; keyLocation: string; keyMissing: boolean }>("list_secrets"),
  setSecret: (input: SecretInput) => call<SecretInfo>("set_secret", { input }),
  removeSecret: (name: string) => call<void>("remove_secret", { name }),
  listWindowsCredentials: () => call<WindowsCredentialInfo[]>("list_windows_credentials"),
  resetSecrets: () => call<number>("reset_secrets"),
  forgetLogin: (session: string) => call<boolean>("forget_login", { session }),
  listSecretRequests: () => call<SecretRequest[]>("list_secret_requests"),
  dismissSecretRequest: (name: string) => call<boolean>("dismiss_secret_request", { name }),
};

export interface AppInfo {
  version: string;
  /** False in development builds. */
  updatesEnabled: boolean;
  /** The bundled CLI (MCP server), when Studio was installed. */
  cliPath: string | null;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

// Kept apart from `api` so the flow store and its test doubles stay
// unaware of app updates.
export const updates = {
  appInfo: () => call<AppInfo>("app_info"),
  check: () => call<UpdateInfo | null>("check_update"),
  /** Downloads the found update in the background; resolves with its version once ready. */
  download: () => call<string>("download_update"),
  /** Never resolves on success: the installer restarts Studio as the new version. */
  install: () => call<void>("install_update"),
  onProgress: (handler: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>("update-progress", (e) => handler(e.payload)),
};

export type Api = typeof api;

/** The person's own coding agent, run in the background with Shikigami's MCP server. */
export type AgentInfo = {
  /** Which agent is in use (config.json → agent.kind). */
  kind: AgentKind;
  available: boolean;
  name: string;
  command: string | null;
  /** Why it cannot be used, in words for the person. */
  problem: string | null;
  /** Whether later messages continue the same conversation. */
  remembers: boolean;
  /** Studio can install it from the pane (a known agent, not found yet). */
  installable: boolean;
  /** The pane can sign it in. */
  signsIn: boolean;
};

export type AgentRequest = {
  message: string;
  sessionId?: string | null;
  /** `empty`: it has no steps yet, so the AI builds in it instead of making another. */
  flow?: { id: string; name: string; stepId?: string | null; empty?: boolean } | null;
};

export type AgentEvent = { turnId: string } & (
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  /** The agent began writing this tool call; `tool` follows once it is written. */
  | { kind: "preparing"; name: string }
  | { kind: "tool"; name: string; detail: string | null }
  | { kind: "toolFailed"; message: string }
  | { kind: "created"; flowId: string; name: string }
  | { kind: "done"; ok: boolean; message: string | null; costUsd: number | null; needsLogin: boolean }
);

// Kept apart from `api` like `updates`: the flow store never talks to the AI.
export const agent = {
  info: () => call<AgentInfo>("agent_info"),
  /** Returns the turn id; progress arrives through `onEvent`. */
  send: (input: AgentRequest) => call<string>("agent_send", { input }),
  stop: (turnId: string) => call<void>("agent_stop", { turnId }),
  /** Starts Claude Code's sign-in; progress arrives through `onLogin`. */
  login: () => call<void>("agent_login"),
  /** The code the sign-in page shows when it cannot return by itself. */
  loginCode: (code: string) => call<void>("agent_login_code", { code }),
  cancelLogin: () => call<void>("agent_login_cancel"),
  /** The agents Studio can run, and which are on this PC. */
  choices: () => call<AgentChoice[]>("agent_choices"),
  /** Uses this agent from the next message on. */
  select: (kind: AgentKind) => call<AgentInfo>("agent_select", { kind }),
  /** Runs the agent's own installer in the background; progress arrives through `onInstall`. */
  install: (kind: AgentKind) => call<void>("agent_install", { kind }),
  cancelInstall: () => call<void>("agent_install_cancel"),
  openUrl: (url: string) => call<void>("agent_open_url", { url }),
  /** Opens a web page the AI linked to (http and https only). */
  openLink: (url: string) => call<void>("agent_open_link", { url }),
  onEvent: (handler: (e: AgentEvent) => void): Promise<UnlistenFn> =>
    listen<AgentEvent>("agent-event", (e) => handler(e.payload)),
  onLogin: (handler: (e: LoginEvent) => void): Promise<UnlistenFn> =>
    listen<LoginEvent>("agent-login", (e) => handler(e.payload)),
  onInstall: (handler: (e: InstallEvent) => void): Promise<UnlistenFn> =>
    listen<InstallEvent>("agent-install", (e) => handler(e.payload)),
};

export type LoginEvent = { kind: "url"; url: string } | { kind: "done"; ok: boolean; message: string | null };
/** Which AI to set up; the installer is chosen by this. */
export type AgentKind = "claudeCode" | "codex" | "gemini" | "copilot" | "command";
/** An agent Studio knows how to run. */
export type AgentChoice = { kind: AgentKind; name: string; maker: string; installed: boolean; selected: boolean };
export type InstallEvent = { kind: "progress"; line: string } | { kind: "done"; ok: boolean; message: string | null; needsLogin: boolean } | { kind: "cancelled" };

export type AgentApi = Omit<typeof agent, "onEvent" | "onLogin" | "onInstall">;

export const events = {
  onFlowChanged: (handler: (flowId: string) => void): Promise<UnlistenFn> =>
    listen<{ flowId: string }>("flow-changed", (e) => handler(e.payload.flowId)),
  onRunEvent: (handler: (event: RunEventEnvelope) => void): Promise<UnlistenFn> =>
    listen<RunEventEnvelope>("run-event", (e) => handler(e.payload)),
  onRunEvidence: (handler: (evidence: RunEvidence) => void): Promise<UnlistenFn> =>
    listen<RunEvidence>("run-evidence", (e) => handler(e.payload)),
  /** An AI asked for a login, or a request was answered or dismissed (any process). */
  onSecretRequestsChanged: (handler: () => void): Promise<UnlistenFn> =>
    listen("secret-requests-changed", () => handler()),
  /** An AI client asked for approval, or a request was answered, used or expired. */
  onApprovalsChanged: (handler: () => void): Promise<UnlistenFn> => listen("approvals-changed", () => handler()),
  /** An AI client asked the person to point at something, or stopped waiting. */
  onPickRequestsChanged: (handler: () => void): Promise<UnlistenFn> => listen("pick-requests-changed", () => handler()),
};
