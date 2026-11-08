// Studio state. All mutations go through the backend API as EditOps; the
// store only mirrors what Core returns (flow, validation, undo state).
import { unsetParams } from "./lib/nodeRows";
import { valuesBefore } from "./lib/startAt";
import type {
  ApprovalRequest,
  DebugCommand,
  EditOp,
  EditOutcome,
  Policy,
  PublishedState,
  HistoryEntry,
  ImportConflict,
  LogLevel,
  PauseReason,
  ReviewTimeline,
  RunError,
  RunEventEnvelope,
  RunStatus,
  Flow,
  FlowPatch,
  FlowSummary,
  Step,
  StepNote,
  StepPatch,
  StepTypeDef,
  ValidationReport,
  VariableDef,
  VersionSummary,
  WorkspaceInfo,
} from "@shikigami/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  type Api,
  ApiError,
  type RunEvidence,
  type SecretField,
  type SecretInfo,
  type SecretInput,
  type PasteOutcome,
  type PickRequest,
  type SecretKind,
  type SecretRequest,
  type StepTestResult,
} from "./lib/api";
import { CALL, CASE, FOR_EACH, SWITCH } from "./lib/stepTypes";
import { registerExtensions } from "./lib/extensions";
import { boxRange, copyText, partOps, readCopied, siblingRange, withNewIds, type Copied } from "./lib/stepClipboard";
import { errorLine } from "./lib/errorText";
import { t } from "./lib/i18n";
import { neighbor, outline } from "./lib/outline";
import { ancestorsOf } from "./flow/layout";
import { resultName } from "./lib/resultName";
import { summarize } from "./lib/review";
import { setFlowNames } from "./lib/sentence";
import { readClipboardText } from "./lib/clipboard";
import { focusFirstSetting } from "./lib/focusSetting";

export type Selection =
  | { kind: "step"; stepId: string }
  | { kind: "slot"; parentId: string | null; block: string | null }
  /** A named screen part (`flow.parts`). */
  | { kind: "part"; name: string }
  | null;

/** A place between nodes (the "+" on a line of the flow chart): a new node goes at `index` of the block. */
export type InsertAt = { parentId: string | null; block: string | null; index: number };

/** Where on screen the palette was opened from (the "+", the node, the dock), so it opens beside it. */
export type PaletteAnchor = { left: number; top: number; right: number; bottom: number };

/**
 * The places in the sidebar; each fills the window right of it. "library" is
 * the page of all flows, "flows" the editor of the open one.
 */
export type Place = "library" | "flows" | "review" | "runs" | "secrets" | "extensions" | "settings";

/** Tabs of the panel under the chart: what happened, and what is wrong. */
export type BottomTab = "log" | "issues" | "tests";

export type StepRunState = "running" | "succeeded" | "failed" | "skipped" | "paused";

/** Where an interactive run waits for the person (the Runtime's `paused` event). */
export type Pause = {
  seq: number;
  stepId: string;
  stepType: string;
  reason: PauseReason;
  /** Set when it paused because the step failed. */
  error: RunError | null;
  /** Every variable's value at that point (masked, previews for large ones). */
  variables: Record<string, unknown>;
  /** The flow revision the run executes. */
  revision: number;
  /** The `flow.call` steps it paused inside (outermost first); empty in the open flow. */
  callPath: string[];
};

export type LogEntry = {
  seq: number;
  at: string;
  level: LogLevel;
  message: string;
  stepId?: string | null;
};

/**
 * One variable write reported by the Runtime (`variableChanged`). Declared
 * here until the schema package carries the event; unknown fields are
 * ignored, so the shape only needs to be a subset of what arrives.
 */
export type VariableChange = {
  seq: number;
  at: string;
  variable: string;
  value: unknown;
  /** The step that wrote it; absent for inputs and defaults set at start. */
  stepId?: string | null;
  /** Element number inside a parallel forEach. */
  iteration?: number | null;
  /** The value is masked as "***". */
  secret?: boolean;
  /** The value is a shortened preview. */
  truncated?: boolean;
};

function asVariableChange(env: RunEventEnvelope): VariableChange | null {
  const e = env as unknown as { type: string } & Partial<VariableChange>;
  if (e.type !== "variableChanged" || typeof e.variable !== "string") return null;
  return {
    seq: env.seq,
    at: env.at,
    variable: e.variable,
    value: e.value,
    stepId: e.stepId ?? null,
    iteration: e.iteration ?? null,
    secret: e.secret === true,
    truncated: e.truncated === true,
  };
}

/** The run id a node run alone has (Tauri `test_step`; also the browser 「画面から選ぶ」 opens). */
export const STEP_TEST_RUN = "studio-pick";

/** A node run alone (「ノードの単体実行」) and what it gave. */
export type StepTest = {
  flowId: string;
  stepId: string;
  running: boolean;
  result: StepTestResult | null;
  /** Why it could not start (not a failure of the node: that is in `result`). */
  error: string | null;
};

export type RunState = {
  runId: string;
  /** The flow being run (known from `runStarted`). */
  flowId: string | null;
  status: RunStatus;
  pause: Pause | null;
  /** The screen at an error pause, once Studio has looked at it. */
  evidence: RunEvidence | null;
  /** Why the run failed, until the person closes the notice. */
  failure: RunError | null;
  steps: Record<string, StepRunState>;
  logs: LogEntry[];
  changes: VariableChange[];
  /** When each step began, in run order (retries not counted), to tell what a step saw. */
  starts: StepStart[];
  /**
   * Steps of called flows, by the call steps they ran under (`callKey`):
   * what an unfolded or entered call shows. Their events never touch `steps`.
   */
  inner: Record<string, Record<string, StepRunState>>;
  /** The step each call path started last (a control step stays running while its blocks run). */
  innerLatest: Record<string, string>;
  /** The flow revision it runs (a resume can move it to a newer one). */
  revision: number | null;
  /** The person cleared the marks it left on the chart. */
  trailHidden: boolean;
  /** Stop was pressed and the run has not ended yet. */
  stopping: boolean;
};

/** The `flow.call` steps a run event happened inside (outermost first). */
const callPathOf = (env: RunEventEnvelope): string[] => (env as { callPath?: string[] }).callPath ?? [];

/** Key of a call path (outermost call step first), for `inner` and `unfolded`. */
export const callKey = (path: string[]): string => path.join("/");

/** One level of the chart the person has entered: the call step and the flow it runs. */
export type DiveLevel = { stepId: string; flow: Flow };

/**
 * The flows behind a path of entered call steps, outermost first. Stops at
 * the first call that is gone or whose flow is not loaded.
 */
export function diveChain(root: Flow | null, called: Record<string, Flow>, path: string[]): DiveLevel[] {
  const chain: DiveLevel[] = [];
  let current = root;
  for (const stepId of path) {
    const step = current ? findStep(current.steps ?? [], stepId) : undefined;
    const target = step?.type === CALL ? step.params?.flow : undefined;
    const callee = typeof target === "string" ? called[target] : undefined;
    if (!callee) break;
    chain.push({ stepId, flow: callee });
    current = callee;
  }
  return chain;
}

/**
 * Breakpoints a run of the open flow stops at: its own, and those of every
 * flow it calls as `<flowId>/<stepId>` (copies of a flow share step IDs).
 */
export function runBreakpoints(s: Pick<StudioState, "flow" | "called" | "breakpoints">): string[] {
  if (!s.flow) return [];
  const called = Object.keys(s.called).flatMap((id) => (s.breakpoints[id] ?? []).map((step) => `${id}/${step}`));
  return [...(s.breakpoints[s.flow.id] ?? []), ...called];
}

/** Flows a step tree calls directly. */
export function calledIds(steps: Step[]): string[] {
  const ids = new Set<string>();
  const walk = (list: Step[]) => {
    for (const step of list) {
      const target = step.type === CALL ? step.params?.flow : undefined;
      if (typeof target === "string" && target) ids.add(target);
      for (const children of Object.values(step.blocks ?? {})) walk(children);
    }
  };
  walk(steps);
  return [...ids];
}

export type StepStart = { stepId: string; seq: number };

export type StudioState = {
  summaries: FlowSummary[];
  stepTypes: StepTypeDef[];
  flow: Flow | null;
  validation: ValidationReport | null;
  canUndo: boolean;
  canRedo: boolean;
  selection: Selection;
  /** Nodes picked with Shift+click: siblings from the anchor to `focus` (the selected node). */
  range: { anchor: string; focus: string; ids: string[] } | null;
  /** The "サブフローにまとめる" form is open beside the selected node. */
  extractOpen: boolean;
  /** The new flow's name typed in that form: kept while Shift+click moves the form to another node. */
  extractName: string;
  notice: string | null;
  error: string | null;
  run: RunState | null;
  /** Core's change journal for the open flow, oldest first. */
  history: HistoryEntry[];
  /** Revisions of non-Studio changes the user has looked at, per flow. */
  reviewed: Record<string, number[]>;
  /** Every flow's journal, oldest first, for the review inbox. */
  histories: Record<string, HistoryEntry[]>;
  /** Per flow: changes and evidence since the last approval (Core's reviews). */
  timelines: Record<string, ReviewTimeline>;
  /** The review desk is open instead of the flow list. */
  reviewing: boolean;
  /** A step the canvas should bring into view; `seq` changes on every request. */
  reveal: { stepId: string; seq: number } | null;
  /** The node open in the full-size editor (double-click on the chart). */
  editing: string | null;
  /** 「ここまで実行」: the run pauses before this node, runs it, and pauses again after. */
  trying: string | null;
  /** The last 「ノードの単体実行」 (only that node ran), until another node is run alone. */
  stepTest: StepTest | null;
  /** Results of nodes run alone, by flow and variable: the next node run alone reads them. */
  tested: Record<string, Record<string, unknown>>;
  /** While running, keep the running step in view. */
  followRun: boolean;
  /** Steps to pause before, per flow (this PC only). */
  breakpoints: Record<string, string[]>;
  /** Frames (a loop, if, group, …) folded to their head on the chart, per flow (this PC only). */
  folded: Record<string, string[]>;
  outlineOpen: boolean;
  paletteOpen: boolean;
  /** The search over the chart (Ctrl+F). */
  searchOpen: boolean;
  /** Counts each Ctrl+F (or search button), so an open box takes the focus again. */
  searchAsked: number;
  /** Where the palette adds, when it was opened from a "+" between nodes; otherwise after the selection. */
  paletteAt: InsertAt | null;
  paletteAnchor: PaletteAnchor | null;
  place: Place;
  /** The panel under the chart (run log, issues); null when closed. */
  bottom: BottomTab | null;
  /** The flow's record and versions, opened from its revision. */
  historyOpen: boolean;
  /** The tab the history dialog opens on. */
  historyTab: "timeline" | "versions";
  /** Named versions of the open flow, newest first. */
  versions: VersionSummary[];
  /** The open flow's published version (what unattended runs execute). */
  published: PublishedState | null;
  /** Requests from AI clients waiting for the person's approval, oldest first. */
  approvals: ApprovalRequest[];
  /** AI clients waiting for the person to point at something in the browser, oldest first. */
  pickRequests: PickRequest[];
  /** The workspace policy, while its dialog is open. */
  policy: Policy | null;
  policyOpen: boolean;
  /** The flows the open one calls, directly or deeper, by id, for call nodes and their inputs. */
  called: Record<string, Flow>;
  /** Call steps shown unfolded on the chart, by `callKey` of their path. */
  unfolded: Record<string, boolean>;
  /** Call steps the chart has entered (double-click), outermost first: it shows the innermost one's flow. */
  dive: string[];
  workspace: WorkspaceInfo | null;
  /** A file whose flow already exists, waiting for the user's choice. */
  pendingImport: { contents: string; name: string } | null;
  /** The dialog for an answer pasted from an AI chat without MCP: a new flow, or into the open one. */
  pasteOpen: "new" | "into" | null;
  /** Registered secrets (names, user names, sites; never values). */
  secrets: SecretInfo[];
  secretKeyLocation: string;
  /** Secrets are listed by name only: their key is not on this PC / user. */
  secretKeyMissing: boolean;
  /** Whether `secrets` has been read once (until then nothing counts as unregistered). */
  secretsLoaded: boolean;
  secretsOpen: boolean;
  /** A running step waits for the person at the PC (manual login, MFA). */
  human: { stepId: string; message: string } | null;
  /** Logins AI clients asked the user to register (request_secret), oldest first. */
  secretRequests: SecretRequest[];
  /** The last run stopped on a missing or incomplete secret. */
  secretFix: SecretFix | null;
  /** What the secrets dialog opens its form with (from a request or a failed run). */
  secretPrefill: SecretPrefill | null;

  init(): Promise<void>;
  refreshList(): Promise<void>;
  open(id: string): Promise<void>;
  create(name: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  applyOps(ops: EditOp[]): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  select(selection: Selection): void;
  /** Selects a step and brings it into view. */
  goTo(stepId: string): void;
  /** Moves the selection to the previous / next step in reading order. */
  stepBy(delta: number): void;
  /** Moves to the previous / next step the AI changed (review desk). */
  changeBy(delta: number): void;
  setFollowRun(on: boolean): void;
  setOutlineOpen(open: boolean): void;
  /** Also keeps `reviewing` and `secretsOpen` in step. */
  setPlace(place: Place): void;
  setBottom(tab: BottomTab | null): void;
  setHistoryOpen(open: boolean, tab?: "timeline" | "versions"): void;
  /** Name, description and run settings of the open flow. */
  updateFlow(patch: FlowPatch): Promise<void>;
  /** Adds a step after the selection; `params` and `name` override the type's defaults (palette presets). */
  addStep(type: string, params?: Record<string, unknown>, name?: string): Promise<void>;
  moveSelected(delta: -1 | 1): Promise<void>;
  removeSelected(): Promise<void>;
  /** Shift+click: selects the nodes from the selected one to `stepId` (same block only). */
  selectTo(stepId: string): void;
  /** Shift+drag: selects the nodes the box was drawn around (as one run of siblings, see `boxRange`). */
  selectBox(stepIds: string[]): void;
  /** Puts the selected nodes inside a new control node (繰り返し・条件分岐・エラー処理・グループ), where they were. */
  wrapSelected(type: string): Promise<void>;
  /** Opens or closes the "サブフローにまとめる" form beside the selected node. */
  setExtractOpen(open: boolean): void;
  setExtractName(name: string): void;
  /** Puts the selected nodes on the clipboard (`cut` also removes them). */
  copySelected(cut?: boolean): Promise<void>;
  /** Adds the nodes on the clipboard after the selection (or at the "+" / empty block). */
  paste(): Promise<void>;
  /** Adds a copy of the selected nodes right after them. */
  duplicateSelected(): Promise<void>;
  /** Adds copies (new IDs) of `copied` where a new node would go. */
  insertCopies(copied: Copied): Promise<void>;
  updateStep(stepId: string, patch: StepPatch): Promise<void>;
  setVariable(variable: VariableDef): Promise<void>;
  removeVariable(name: string): Promise<void>;
  loadCalled(): Promise<void>;
  /** `key`: `callKey` of the call step's path. */
  toggleUnfolded(key: string): void;
  /** Shows the flow a call step of the chart's current level runs, in place. */
  enterCall(stepId: string): void;
  /** Goes back up to `depth` entered calls (0: the open flow itself). */
  leaveCalls(depth: number): void;
  /** Moves neighbouring steps into a new flow; returns true when done. */
  extract(stepIds: string[], name: string): Promise<boolean>;
  onExternalChange(flowId: string): Promise<void>;
  /** `step`: pause before the first step. */
  startRun(options?: { step?: boolean; stopAt?: string; startAt?: string; startValues?: Record<string, unknown> }): Promise<void>;
  openEditor(stepId: string): void;
  closeEditor(): void;
  /** 「ここまで実行」: runs the flow up to and through `stepId`, then pauses, so its result can be looked at. */
  runTo(stepId: string): Promise<void>;
  /** 「ここから実行」: the nodes before it do not run; variables start as the last run had them there. */
  runFrom(stepId: string): Promise<void>;
  /** 「ノードの単体実行」: runs only `stepId`, with `values` for the variables it reads. */
  testStep(stepId: string, values: Record<string, unknown>): Promise<void>;
  /** 「中止」 for the node running alone. */
  stopStepTest(): Promise<void>;
  stopRun(): Promise<void>;
  /** Step command for the paused (or running) run; false when it was refused. */
  debug(command: DebugCommand): Promise<boolean>;
  /** `flowId`: the flow the step is in, when it is a called one shown on the chart. */
  toggleBreakpoint(stepId: string, flowId?: string): void;
  /** Removes every breakpoint of the open flow and of the flows it calls. */
  clearBreakpoints(): void;
  /** Folds a frame to its head on the chart, or opens it again. */
  toggleFold(stepId: string, flowId?: string): void;
  /** Opens the folded frames around a step of the open flow, so it can be shown. */
  unfoldTo(stepId: string): void;
  onRunEvent(event: RunEventEnvelope): void;
  onRunEvidence(evidence: RunEvidence): void;
  /** Closes the notice about a failed run. */
  dismissFailure(): void;
  /** Takes the last run's marks off the chart (its log stays). */
  hideTrail(): void;
  clearLog(): void;
  dismiss(): void;
  loadHistory(): Promise<void>;
  approve(revision: number): void;
  /** Marks every unreviewed external change of the open flow as looked at (this PC only). */
  markAllReviewed(): void;
  /** Keeps the open flow's current revision: recorded in Core as approved. */
  approveAll(): Promise<void>;
  /** The review desk's 「残して本番に使う」: approves the current revision and publishes it. */
  approveAndPublish(): Promise<void>;
  /** Publishes a version (default: the current content). */
  publish(version?: number): Promise<void>;
  unpublish(): Promise<void>;
  loadApprovals(): Promise<void>;
  decideApproval(id: string, approve: boolean): Promise<void>;
  loadPickRequests(): Promise<void>;
  cancelPickRequest(id: string): Promise<void>;
  setPolicyOpen(open: boolean): void;
  /** Returns true when saved. */
  savePolicy(policy: Policy): Promise<boolean>;
  /** Sends the current revision back to the AI with a reason it reads over MCP. */
  sendBack(reason: string, steps: StepNote[]): Promise<boolean>;
  loadTimeline(id: string): Promise<void>;
  /** Reverts one journal entry by sending its inverse ops to Core as a new edit. */
  revert(entry: HistoryEntry): Promise<void>;
  /** Reverts every unreviewed external change of the open flow in one edit. */
  revertAll(): Promise<void>;
  loadInbox(): Promise<void>;
  setReviewing(on: boolean): void;
  /** Opens the node palette, adding at `at` (or after the selection) when a node is picked. */
  setPaletteOpen(open: boolean, at?: InsertAt | null, anchor?: PaletteAnchor | null): void;
  setSearchOpen(open: boolean): void;
  loadVersions(): Promise<void>;
  createVersion(name: string, note: string): Promise<boolean>;
  restoreVersion(number: number): Promise<void>;
  exportFlow(): Promise<void>;
  /** Imports file contents; on IMPORT_CONFLICT keeps them in `pendingImport`. True once it is in. */
  importFile(contents: string, onConflict?: ImportConflict): Promise<boolean>;
  cancelImport(): void;
  setPasteOpen(mode: "new" | "into" | null): void;
  /**
   * Takes in an AI's answer: a new flow, or with `into` the open flow's new
   * content. Opens the flow it made; returns what happened, null on an error.
   */
  pasteAnswer(text: string, into: boolean): Promise<PasteOutcome | null>;
  setWorkspace(path: string, shared: boolean): Promise<void>;
  loadSecrets(): Promise<void>;
  /** Returns true when saved. */
  saveSecret(input: SecretInput): Promise<boolean>;
  /**
   * Saves values and adds `addSites` to the sites the secret has now (read
   * again first: the CLI may have changed them while Studio was open).
   */
  saveSecretAdding(input: Omit<SecretInput, "sites">, addSites: string[]): Promise<boolean>;
  removeSecret(name: string): Promise<void>;
  /** Forgets the saved sign-in (browser login, OAuth tokens) of a name. */
  signOutSecret(name: string): Promise<void>;
  resetSecrets(): Promise<void>;
  setSecretsOpen(open: boolean): void;
  loadSecretRequests(): Promise<void>;
  dismissSecretRequest(name: string): Promise<void>;
  /** Opens the secrets dialog on the form for `prefill.name`, with its sites added. */
  openSecretForm(prefill: SecretPrefill): void;
  clearSecretPrefill(): void;
  dismissSecretFix(): void;
};

export type SecretPrefill = { name: string; sites: string[]; fields: SecretField[]; kind?: SecretKind };

export type SecretFix = { name: string; code: string; site?: string; field?: SecretField };

/** Step errors the user fixes by registering or editing a secret. */
export const SECRET_FIX_CODES = [
  "SECRET_NOT_FOUND",
  "SECRET_FIELD_EMPTY",
  "SECRET_SITE_NOT_SET",
  "SECRET_SITE_MISMATCH",
  "SECRET_APP_NOT_SET",
];

/** The secret a failed step asks the user to fix, from the error's details. */
export function secretFixOf(error: { code: string; details?: unknown } | null | undefined): SecretFix | null {
  if (!error || !SECRET_FIX_CODES.includes(error.code)) return null;
  const details = (error.details ?? {}) as { secret?: unknown; page?: unknown; field?: unknown };
  if (typeof details.secret !== "string" || !details.secret) return null;
  const site = typeof details.page === "string" && details.page ? details.page : undefined;
  const field = (["username", "password", "totp"] as const).find((f) => f === details.field);
  return { name: details.secret, code: error.code, site, ...(field ? { field } : {}) };
}

export const isExternal = (entry: HistoryEntry) => entry.actor.kind !== "studio";

/** Whether Core recorded ops that can be sent back to revert this entry. */
export const isRevertible = (entry: HistoryEntry) =>
  entry.kind !== "create" && entry.kind !== "delete" && (entry.inverse?.length ?? 0) > 0;

/** What an entry's ops touch; "*" when they rewrite the whole step tree. */
function targets(entry: HistoryEntry): Set<string> {
  const keys = new Set<string>();
  for (const op of entry.ops ?? []) {
    if (op.op === "addStep") keys.add(`step:${op.step.id}`);
    else if (op.op === "updateStep" || op.op === "removeStep" || op.op === "moveStep") keys.add(`step:${op.stepId}`);
    else if (op.op === "setVariable") keys.add(`var:${op.variable.name}`);
    else if (op.op === "removeVariable") keys.add(`var:${op.name}`);
    else if (op.op === "updateFlow") keys.add("flow");
    else keys.add("*");
  }
  return keys;
}

/**
 * Why an entry cannot be reverted safely, or null. Core's inverse ops restore
 * whole previous values (e.g. all params), so sending them after a later edit
 * to the same step or variable would silently undo that later edit too.
 */
export function revertBlocker(entry: HistoryEntry, history: HistoryEntry[]): string | null {
  if (!isRevertible(entry)) return t.revertUnsupported;
  const mine = targets(entry);
  for (const later of history) {
    if (later.revision <= entry.revision) continue;
    for (const key of targets(later)) {
      if (key === "*" || mine.has("*") || mine.has(key)) return t.revertBlocked;
    }
  }
  return null;
}

/** External edits the user has not reviewed yet, newest first. */
export function pendingReview(
  state: Pick<StudioState, "history" | "reviewed" | "flow"> & Partial<Pick<StudioState, "timelines">>,
): HistoryEntry[] {
  const id = state.flow?.id ?? "";
  return pendingIn(state.history, state.reviewed[id], approvedUpTo(state.timelines?.[id]));
}

/** The last revision someone approved (on any PC sharing this workspace's history), or 0. */
export function approvedUpTo(timeline: ReviewTimeline | undefined): number {
  return timeline?.lastApproval?.revision ?? 0;
}

/** Unreviewed external edits in one flow's journal, newest first. */
export function pendingIn(history: HistoryEntry[], reviewed: number[] | undefined, approved = 0): HistoryEntry[] {
  const seen = new Set(reviewed ?? []);
  return history
    .filter((e) => isExternal(e) && (isRevertible(e) || e.kind === "create") && e.revision > approved && !seen.has(e.revision))
    .reverse();
}

/**
 * Why a group of entries cannot be reverted together, or null: an entry
 * outside the group changed the same thing afterwards.
 */
export function groupRevertBlocker(group: HistoryEntry[], history: HistoryEntry[]): string | null {
  if (group.some((e) => !isRevertible(e))) return t.revertUnsupported;
  const inGroup = new Set(group.map((e) => e.revision));
  const oldest = Math.min(...group.map((e) => e.revision));
  const mine = new Set(group.flatMap((e) => [...targets(e)]));
  for (const later of history) {
    if (later.revision <= oldest || inGroup.has(later.revision)) continue;
    for (const key of targets(later)) {
      if (key === "*" || mine.has("*") || mine.has(key)) return t.revertBlocked;
    }
  }
  return null;
}

/** Step IDs an entry's ops point at (for highlighting on the canvas). */
export function touchedSteps(entry: HistoryEntry): string[] {
  const ids: string[] = [];
  for (const op of entry.ops ?? []) {
    if (op.op === "addStep" && op.step.id) ids.push(op.step.id);
    else if (op.op === "updateStep" || op.op === "moveStep") ids.push(op.stepId);
  }
  return ids;
}

const REVIEWED_KEY = "shikigami.studio.reviewed";
const BREAKPOINTS_KEY = "shikigami.studio.breakpoints";

function loadBreakpoints(): Record<string, string[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(BREAKPOINTS_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

const FOLDED_KEY = "shikigami.studio.folded";

function loadFolded(): Record<string, string[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(FOLDED_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

function saveFolded(folded: Record<string, string[]>) {
  try {
    globalThis.localStorage?.setItem(FOLDED_KEY, JSON.stringify(folded));
  } catch {
    // Only how the chart is shown on this PC.
  }
}

function saveBreakpoints(breakpoints: Record<string, string[]>) {
  try {
    globalThis.localStorage?.setItem(BREAKPOINTS_KEY, JSON.stringify(breakpoints));
  } catch {
    // Breakpoints are a convenience on this PC.
  }
}

/** A run that has not ended yet (running or paused). */
export const isActive = (run: RunState | null) => run?.status === "running" || run?.status === "paused" || run?.status === "pending";

const newRun = (runId: string, flowId: string | null = null): RunState => ({
  runId,
  flowId,
  status: "running",
  pause: null,
  evidence: null,
  failure: null,
  steps: {},
  logs: [],
  changes: [],
  starts: [],
  inner: {},
  innerLatest: {},
  revision: null,
  trailHidden: false,
  stopping: false,
});

/**
 * The run whose marks the chart shows: the open flow's latest run, while
 * it runs and afterwards, until the flow is edited, another run starts or
 * the person clears them. Marks of an older revision would point at steps that
 * have changed since.
 */
export function trailOf(s: Pick<StudioState, "run" | "flow">): RunState | null {
  const run = s.run;
  if (!run || !s.flow || run.flowId !== s.flow.id) return null;
  if (isActive(run)) return run;
  if (run.trailHidden) return null;
  return run.revision === s.flow.revision ? run : null;
}
const OUTLINE_KEY = "shikigami.studio.outline";

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value == null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    globalThis.localStorage?.setItem(key, on ? "1" : "0");
  } catch {
    // Only a remembered preference.
  }
}

function loadReviewed(): Record<string, number[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(REVIEWED_KEY) ?? "{}") as Record<string, number[]>;
  } catch {
    return {};
  }
}

function saveReviewed(reviewed: Record<string, number[]>) {
  try {
    globalThis.localStorage?.setItem(REVIEWED_KEY, JSON.stringify(reviewed));
  } catch {
    // Review marks are a convenience; losing them only re-shows the cards.
  }
}

/** Where a step lives in the tree. */
export type Location = { parentId: string | null; block: string | null; index: number; siblings: number };

export function locate(steps: Step[], id: string, parentId: string | null = null, block: string | null = null): Location | null {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.id === id) return { parentId, block, index, siblings: steps.length };
    for (const [name, children] of Object.entries(step.blocks ?? {})) {
      const found = locate(children, id, step.id ?? null, name);
      if (found) return found;
    }
  }
  return null;
}

type Position = { parentId?: string | null; block?: string | null; index?: number | null };

/**
 * Where a new node goes, and which node it goes next to: at the "+" it was
 * asked for, else after the selected node, else at the end of the selected
 * empty block, else at the end of the flow.
 */
export function insertPlace(
  steps: Step[],
  selection: Selection,
  at: InsertAt | null,
): { position: Position; before?: Step; after?: Step; into?: { parent: Step; block: string }; prev?: Step } {
  if (at) {
    const siblings = at.parentId === null ? steps : (findStep(steps, at.parentId)?.blocks?.[at.block ?? ""] ?? []);
    const before = siblings[at.index];
    const after = siblings[at.index - 1];
    const parent = at.parentId === null ? null : findStep(steps, at.parentId);
    return {
      position: { parentId: at.parentId, block: at.block, index: at.index },
      ...(before ? { before } : after ? { after } : parent && at.block ? { into: { parent, block: at.block } } : {}),
      // The step the new one follows, when adding on a line between two (the palette offers what usually comes next).
      ...(before && after ? { prev: after } : {}),
    };
  }
  if (selection?.kind === "slot") {
    const parent = selection.parentId === null ? null : findStep(steps, selection.parentId);
    return {
      position: { parentId: selection.parentId, block: selection.block },
      ...(parent && selection.block ? { into: { parent, block: selection.block } } : {}),
    };
  }
  if (selection?.kind === "step") {
    const loc = locate(steps, selection.stepId);
    const step = findStep(steps, selection.stepId);
    if (loc && step) return { position: { parentId: loc.parentId, block: loc.block, index: loc.index + 1 }, after: step };
  }
  return { position: {} };
}

export function findStep(steps: Step[], id: string): Step | null {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const children of Object.values(step.blocks ?? {})) {
      const found = findStep(children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Sensible starting params so a freshly added step is close to runnable. */
const DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  "control.if": { condition: "true" },
  "control.switch": { value: "''" },
  "control.case": { values: [""] },
  "control.while": { condition: "false" },
  "control.repeat": { count: 1 },
  "control.forEach": { itemVar: "item" },
  get "control.fail"() {
    return { message: t.severity.error };
  },
  "variable.set": { name: "value", value: "" },
  "log.message": { message: "" },
  "flow.delay": { ms: 1000 },
  "wait.until": { condition: "true" },
  "flow.call": { flow: "" },
  "browser.open": { url: "https://" },
  "browser.click": { target: { role: "button", name: "" } },
  "browser.fill": { target: { label: "" }, value: "" },
  "browser.waitFor": { target: { text: "" } },
  "browser.getText": { target: { text: "" } },
  "browser.press": { key: "Enter" },
};


/**
 * The nodes the person has selected, in flow order: the Shift+click range when
 * there is one for the selected node, else the selected node alone.
 */
export function selectedIds(state: Pick<StudioState, "selection" | "range">): string[] {
  const { selection, range } = state;
  if (selection?.kind !== "step") return [];
  if (range && range.focus === selection.stepId) return range.ids;
  return [selection.stepId];
}

/**
 * What "サブフローにまとめる" offers for the selection. Several picked nodes
 * (Shift+click) are taken as they are; one node offers itself and the nodes
 * after it in the same block, to choose how many.
 */
export function extractChoices(steps: Step[], state: Pick<StudioState, "selection" | "range">): { picked: Step[] } | { from: Step[] } | null {
  const ids = selectedIds(state);
  if (ids.length === 0) return null;
  const found = ids.map((id) => findStep(steps, id)).filter((s): s is Step => !!s);
  if (found.length !== ids.length) return null;
  if (ids.length > 1) return { picked: found };
  return { from: siblingsAfter(steps, ids[0]!) ?? found };
}

/** The step and the ones after it, in its block. */
function siblingsAfter(steps: Step[], id: string): Step[] | null {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) return steps.slice(i);
  for (const step of steps) {
    for (const children of Object.values(step.blocks ?? {})) {
      const found = siblingsAfter(children, id);
      if (found) return found;
    }
  }
  return null;
}

/** A case of a switch, with nothing to compare to yet. */
function newCase(body: Step[] = []): Step {
  return { id: newStepId(), type: CASE, params: { ...(DEFAULT_PARAMS[CASE] ?? {}) }, ...(body.length > 0 ? { blocks: { body } } : {}) };
}

/** The control nodes selected nodes can be put inside, and the block they go into. */
export const WRAP_BLOCK: Record<string, string> = {
  "control.forEach": "body",
  "control.repeat": "body",
  "control.if": "then",
  "control.try": "try",
  "control.group": "body",
};

export function newStepId(): string {
  return `stp_${crypto.randomUUID().replaceAll("-", "")}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function publishMessage(e: unknown): string {
  return e instanceof ApiError ? t.publishError(e.code, e.message) : message(e);
}

export function createStudioStore(api: Api): StoreApi<StudioState> {
  return createStore<StudioState>()((set, get) => {
    const applyOutcome = (outcome: EditOutcome) => {
      set({
        flow: outcome.flow,
        validation: outcome.validation,
        canUndo: outcome.canUndo,
        canRedo: outcome.canRedo,
        error: null,
      });
    };

    const reloadCurrent = async () => {
      const id = get().flow?.id;
      if (!id) return;
      const [flow, validation, undo] = await Promise.all([api.getFlow(id), api.validate(id), api.undoState(id)]);
      set({ flow, validation, canUndo: undo.canUndo, canRedo: undo.canRedo });
      await Promise.all([get().loadHistory(), get().loadCalled(), get().loadVersions()]);
    };

    /** Runs a mutation; on a revision conflict reloads and tells the user. */
    const mutate = async (fn: (id: string, revision: number) => Promise<EditOutcome>): Promise<boolean> => {
      const flow = get().flow;
      if (!flow) return false;
      try {
        applyOutcome(await fn(flow.id, flow.revision ?? 0));
        void get().refreshList();
        void get().loadHistory();
        void get().loadCalled();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
          await reloadCurrent();
          set({ notice: t.reloadedByConflict });
        } else {
          set({ error: message(e) });
        }
        return false;
      }
    };

    return {
      summaries: [],
      stepTypes: [],
      flow: null,
      validation: null,
      canUndo: false,
      canRedo: false,
      selection: null,
      range: null,
      extractOpen: false,
      extractName: "",
      notice: null,
      error: null,
      run: null,
      history: [],
      reviewed: loadReviewed(),
      histories: {},
      timelines: {},
      reviewing: false,
      reveal: null,
      editing: null,
      trying: null,
      stepTest: null,
      tested: {},
      followRun: true,
      breakpoints: loadBreakpoints(),
      folded: loadFolded(),
      outlineOpen: loadFlag(OUTLINE_KEY, false),
      paletteOpen: false,
      searchOpen: false,
      searchAsked: 0,
      paletteAt: null,
      paletteAnchor: null,
      place: "library",
      bottom: null,
      historyOpen: false,
      historyTab: "timeline",
      versions: [],
      published: null,
      approvals: [],
      pickRequests: [],
      policy: null,
      policyOpen: false,
      called: {},
      unfolded: {},
      dive: [],
      workspace: null,
      pendingImport: null,
      pasteOpen: null,
      secrets: [],
      secretKeyLocation: "",
      secretKeyMissing: false,
      secretsLoaded: false,
      secretsOpen: false,
      human: null,
      secretRequests: [],
      secretFix: null,
      secretPrefill: null,

      async init() {
        try {
          const [stepTypes, summaries] = await Promise.all([api.listStepTypes(), api.listFlows()]);
          setFlowNames(new Map(summaries.map((s) => [s.id, s.name] as const)));
          registerExtensions(stepTypes);
          set({ stepTypes, summaries });
          void get().loadInbox();
          set({ workspace: await api.workspaceInfo() });
        } catch (e) {
          set({ error: message(e) });
        }
        await get().loadSecrets();
        await get().loadSecretRequests();
      },

      async loadSecrets() {
        try {
          const { secrets, keyLocation, keyMissing } = await api.listSecrets();
          set({ secrets, secretKeyLocation: keyLocation, secretKeyMissing: keyMissing, secretsLoaded: true });
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async saveSecret(input) {
        try {
          await api.setSecret(input);
          await get().loadSecrets();
          await get().loadSecretRequests();
          set((s) => ({
            notice: t.secretSaved(input.name),
            error: null,
            secretFix: s.secretFix?.name === input.name ? null : s.secretFix,
          }));
          return true;
        } catch (e) {
          set({ error: message(e) });
          return false;
        }
      },

      async saveSecretAdding(input, addSites) {
        await get().loadSecrets();
        const current = get().secrets.find((s) => s.name === input.name)?.sites ?? [];
        const sites = [...current, ...addSites.filter((site) => !current.includes(site))];
        return get().saveSecret({ ...input, sites });
      },

      async removeSecret(name) {
        try {
          await api.removeSecret(name);
          await get().loadSecrets();
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async signOutSecret(name) {
        try {
          await api.forgetLogin(name);
          await get().loadSecrets();
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async resetSecrets() {
        try {
          await api.resetSecrets();
          await get().loadSecrets();
        } catch (e) {
          set({ error: message(e) });
        }
      },

      setSecretsOpen(open) {
        get().setPlace(open ? "secrets" : "flows");
      },

      async loadSecretRequests() {
        try {
          // The dialog reads what each secret already has: keep both fresh.
          const [secretRequests] = await Promise.all([api.listSecretRequests(), get().loadSecrets()]);
          set({ secretRequests });
        } catch {
          // Requests are a convenience: the dialog still works without them.
        }
      },

      async dismissSecretRequest(name) {
        try {
          await api.dismissSecretRequest(name);
        } catch (e) {
          set({ error: message(e) });
        }
        await get().loadSecretRequests();
      },

      openSecretForm(prefill) {
        set({ place: "secrets", reviewing: false, secretsOpen: true });
        // The form edits the secret when it exists: list first, then fill.
        void get()
          .loadSecrets()
          .then(() => set({ secretPrefill: prefill }));
      },

      clearSecretPrefill() {
        set({ secretPrefill: null });
      },

      dismissSecretFix() {
        set({ secretFix: null });
      },

      async refreshList() {
        try {
          const summaries = await api.listFlows();
          setFlowNames(new Map(summaries.map((s) => [s.id, s.name] as const)));
          set({ summaries });
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async open(id) {
        try {
          const [flow, validation, undo] = await Promise.all([api.getFlow(id), api.validate(id), api.undoState(id)]);
          set({
            // Opened from the library (or by the AI while it shows): show it in the editor.
            ...(get().place === "library" ? { place: "flows" as const } : {}),
            flow,
            validation,
            canUndo: undo.canUndo,
            canRedo: undo.canRedo,
            selection: null,
            editing: null,
            error: null,
            history: [],
            versions: [],
            published: null,
            called: {},
            dive: [],
          });
          await Promise.all([get().loadHistory(), get().loadVersions(), get().loadCalled()]);
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async create(name) {
        try {
          const outcome = await api.createFlow({ name });
          applyOutcome(outcome);
          set({ selection: null, history: [], versions: [] });
          void get().loadHistory();
          await get().refreshList();
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async duplicate(id) {
        try {
          const outcome = await api.duplicateFlow(id);
          applyOutcome(outcome);
          set({ history: [], versions: [] });
          void get().loadHistory();
          await get().refreshList();
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async remove(id) {
        try {
          const current = get().flow;
          await api.deleteFlow(id, current?.id === id ? current.revision : undefined);
          if (current?.id === id) set({ flow: null, validation: null, selection: null });
          await get().refreshList();
        } catch (e) {
          if (e instanceof ApiError && e.code === "FLOW_IN_USE") {
            const callers = ((e.details as { callers?: { name?: string }[] } | undefined)?.callers ?? []).map((c) => c.name ?? "");
            set({ error: t.inUse(callers) });
          } else {
            set({ error: message(e) });
          }
        }
      },

      applyOps: (ops) => mutate((id, rev) => api.edit(id, rev, ops)),
      undo: async () => void (await mutate((id, rev) => api.undo(id, rev))),
      redo: async () => void (await mutate((id, rev) => api.redo(id, rev))),

      // Picking a step of the open flow brings the chart back up to it.
      select(selection) {
        set(selection ? { selection, range: null, dive: [], extractOpen: false, extractName: "" } : { selection, range: null, extractOpen: false, extractName: "" });
      },

      goTo(stepId) {
        get().unfoldTo(stepId);
        set({ selection: { kind: "step", stepId }, range: null, reveal: { stepId, seq: (get().reveal?.seq ?? 0) + 1 }, dive: [] });
      },

      stepBy(delta) {
        const { flow, stepTypes, selection } = get();
        const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
        const ids = outline(flow?.steps ?? [], defs).map((i) => i.id);
        const next = neighbor(ids, selection?.kind === "step" ? selection.stepId : null, delta);
        if (next) get().goTo(next);
      },

      changeBy(delta) {
        const { flow, stepTypes, selection } = get();
        const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
        const changed = summarize([...pendingReview(get())].reverse(), flow?.steps).steps;
        const all = outline(flow?.steps ?? [], defs).map((i) => i.id);
        const current = selection?.kind === "step" ? selection.stepId : null;
        const at = current ? all.indexOf(current) : -1;
        // The nearest changed step in that direction from wherever the selection is.
        const ahead = at < 0 ? (delta > 0 ? all : [...all].reverse()) : delta > 0 ? all.slice(at + 1) : all.slice(0, at).reverse();
        const next = ahead.find((id) => changed.has(id));
        if (next) get().goTo(next);
      },

      setFollowRun(on) {
        set({ followRun: on });
      },

      setOutlineOpen(open) {
        saveFlag(OUTLINE_KEY, open);
        set({ outlineOpen: open });
      },

      setPlace(place) {
        set({ place, reviewing: place === "review", secretsOpen: place === "secrets", historyOpen: false });
        if (place === "secrets") void get().loadSecrets();
        else set({ secretPrefill: null });
      },

      setBottom(tab) {
        set({ bottom: tab });
      },

      setHistoryOpen(open, tab = "timeline") {
        set({ historyOpen: open, historyTab: tab });
      },

      async updateFlow(patch) {
        await get().applyOps([{ op: "updateFlow", patch }]);
      },

      async addStep(type, params, name) {
        const { flow, selection, paletteAt } = get();
        if (!flow) return;
        const { position, after } = insertPlace(flow.steps ?? [], selection, paletteAt);
        let step: Step = { id: newStepId(), type, params: params ?? { ...(DEFAULT_PARAMS[type] ?? {}) }, ...(name ? { name } : {}) };
        // Keep the result under a name from the start, so the next node can use it without one being invented.
        const saveAs = resultName(get().stepTypes.find((d) => d.type === type), flow.variables, flow.steps ?? []);
        if (saveAs) step.saveAs = saveAs;
        // A repeat added right after a node that read a list goes over that list.
        if (type === FOR_EACH && !params && after?.saveAs) step.params = { ...step.params, items: after.saveAs };
        // A switch starts with its first case; a node added among the cases becomes a case of its own.
        if (type === SWITCH) step.blocks = { cases: [newCase()] };
        const parent = position.parentId ? findStep(flow.steps ?? [], position.parentId) : null;
        if (parent?.type === SWITCH && position.block === "cases" && type !== CASE) step = newCase([step]);
        const ok = await get().applyOps([{ op: "addStep", step, position }]);
        if (!ok || !step.id) return;
        set({ selection: { kind: "step", stepId: step.id } });
        // A node with settings it cannot run without opens at once, so they
        // are filled in now instead of turning up later as a problem.
        if (unsetParams(step, get().stepTypes.find((d) => d.type === type)).length > 0) focusFirstSetting();
      },

      async moveSelected(delta) {
        const { flow, selection } = get();
        if (!flow || selection?.kind !== "step") return;
        const loc = locate(flow.steps ?? [], selection.stepId);
        if (!loc) return;
        const index = loc.index + delta;
        if (index < 0 || index >= loc.siblings) return;
        await get().applyOps([
          { op: "moveStep", stepId: selection.stepId, position: { parentId: loc.parentId, block: loc.block, index } },
        ]);
      },

      async removeSelected() {
        const ids = selectedIds(get());
        if (ids.length === 0) return;
        const ok = await get().applyOps(ids.map((stepId) => ({ op: "removeStep", stepId }) as EditOp));
        if (ok) set({ selection: null, range: null });
      },

      async wrapSelected(type) {
        const { flow } = get();
        const ids = selectedIds(get());
        const block = WRAP_BLOCK[type];
        if (!flow || ids.length === 0 || !block) return;
        const steps = flow.steps ?? [];
        const loc = locate(steps, ids[0]!);
        // A case belongs to its switch: it cannot move into another node.
        if (!loc || ids.some((id) => findStep(steps, id)?.type === CASE)) return;
        const first = findStep(steps, ids[0]!);
        const wrapper: Step = { id: newStepId(), type, params: { ...(DEFAULT_PARAMS[type] ?? {}) } };
        // A repeat over the list the node before it read, like adding one there.
        const before = loc.index > 0 ? (loc.parentId === null ? steps : (findStep(steps, loc.parentId)?.blocks?.[loc.block ?? ""] ?? []))[loc.index - 1] : undefined;
        if (type === FOR_EACH && before?.saveAs) wrapper.params = { ...wrapper.params, items: before.saveAs };
        const ops: EditOp[] = [
          { op: "addStep", step: wrapper, position: { parentId: loc.parentId, block: loc.block, index: loc.index } },
          ...ids.map((stepId, index) => ({ op: "moveStep", stepId, position: { parentId: wrapper.id, block, index } }) as EditOp),
        ];
        const ok = await get().applyOps(ops);
        if (!ok || !wrapper.id || !first) return;
        set({ selection: { kind: "step", stepId: wrapper.id }, range: null });
        if (unsetParams(wrapper, get().stepTypes.find((d) => d.type === type)).length > 0) focusFirstSetting();
      },

      setExtractOpen(open) {
        set({ extractOpen: open && get().selection?.kind === "step", extractName: "" });
      },

      setExtractName(name) {
        set({ extractName: name });
      },

      selectBox(stepIds) {
        const { flow } = get();
        if (!flow) return;
        const ids = boxRange(flow.steps ?? [], stepIds, CASE);
        if (ids.length === 0) return;
        const focus = ids.at(-1)!;
        set({ selection: { kind: "step", stepId: focus }, range: ids.length > 1 ? { anchor: ids[0]!, focus, ids } : null, dive: [] });
      },

      selectTo(stepId) {
        const { flow, selection } = get();
        if (selection?.kind !== "step" || !flow) return get().select({ kind: "step", stepId });
        const range = get().range;
        const anchor = range && range.focus === selection.stepId ? range.anchor : selection.stepId;
        const ids = siblingRange(flow.steps ?? [], anchor, stepId);
        set({
          selection: { kind: "step", stepId },
          range: ids && ids.length > 1 ? { anchor, focus: stepId, ids } : null,
          dive: [],
        });
      },

      async copySelected(cut = false) {
        const { flow } = get();
        const ids = selectedIds(get());
        if (!flow || ids.length === 0) return;
        const steps = ids.map((id) => findStep(flow.steps ?? [], id)).filter((s): s is Step => !!s);
        try {
          await navigator.clipboard.writeText(copyText(steps, flow.parts));
        } catch (e) {
          set({ error: message(e) });
          return;
        }
        if (!cut) return void set({ notice: t.copiedNodes(steps.length) });
        // The nodes copied, even if the selection moved while the clipboard was busy.
        if (get().flow?.id !== flow.id) return;
        const ok = await get().applyOps(ids.map((stepId) => ({ op: "removeStep", stepId }) as EditOp));
        if (ok) set({ selection: null, range: null });
      },

      async paste() {
        const { flow } = get();
        if (!flow) return;
        let text = "";
        try {
          text = await readClipboardText();
        } catch (e) {
          set({ error: message(e) });
          return;
        }
        const copied = readCopied(text);
        if (!copied) {
          set({ notice: t.nothingToPaste });
          return;
        }
        await get().insertCopies(copied);
      },

      async duplicateSelected() {
        const { flow } = get();
        const ids = selectedIds(get());
        if (!flow || ids.length === 0) return;
        const steps = ids.map((id) => findStep(flow.steps ?? [], id)).filter((s): s is Step => !!s);
        // Right after the last of them (ids are in flow order).
        set({ selection: { kind: "step", stepId: ids.at(-1)! }, range: null, paletteAt: null });
        await get().insertCopies({ steps, parts: {} });
      },

      async insertCopies(copied) {
        const { flow, selection, paletteAt } = get();
        if (!flow) return;
        const { position } = insertPlace(flow.steps ?? [], selection, paletteAt);
        const parent = position.parentId ? findStep(flow.steps ?? [], position.parentId) : null;
        const intoCases = parent?.type === SWITCH && position.block === "cases";
        // A case belongs in a switch: elsewhere its nodes are pasted without it,
        // and other nodes pasted among the cases get a case of their own.
        const steps = copied.steps
          .flatMap((s) => (s.type === CASE && !intoCases ? (s.blocks?.body ?? []) : [s]))
          .map((s) => withNewIds(s, newStepId))
          .map((s) => (intoCases && s.type !== CASE ? newCase([s]) : s));
        if (steps.length === 0) return;
        const base = position.index ?? null;
        const ops: EditOp[] = [
          ...partOps(copied, flow.parts),
          ...steps.map(
            (step, i) => ({ op: "addStep", step, position: { ...position, index: base === null ? null : base + i } }) as EditOp,
          ),
        ];
        const ok = await get().applyOps(ops);
        if (!ok) return;
        const ids = steps.map((s) => s.id ?? "");
        const focus = ids.at(-1)!;
        set({ selection: { kind: "step", stepId: focus }, range: ids.length > 1 ? { anchor: ids[0]!, focus, ids } : null, paletteAt: null });
      },

      async updateStep(stepId, patch) {
        await get().applyOps([{ op: "updateStep", stepId, patch }]);
      },

      async setVariable(variable) {
        await get().applyOps([{ op: "setVariable", variable }]);
      },

      async removeVariable(name) {
        await get().applyOps([{ op: "removeVariable", name }]);
      },

      async loadCalled() {
        const flow = get().flow;
        if (!flow) return;
        // Calls inside called flows too, so the chart can enter them.
        const called: Record<string, Flow> = {};
        const seen = new Set([flow.id]);
        let next = calledIds(flow.steps ?? []);
        while (next.length > 0) {
          const ids = next.filter((id) => !seen.has(id));
          ids.forEach((id) => seen.add(id));
          const loaded = await Promise.all(ids.map((id) => api.getFlow(id).catch(() => null)));
          next = [];
          for (const callee of loaded) {
            if (!callee) continue;
            called[callee.id] = callee;
            next.push(...calledIds(callee.steps ?? []));
          }
        }
        // Ignore a late answer for a flow that is no longer open.
        if (get().flow?.id !== flow.id) return;
        set({ called });
      },

      toggleUnfolded(key) {
        set((s) => ({ unfolded: { ...s.unfolded, [key]: !s.unfolded[key] } }));
      },

      enterCall(stepId) {
        const { flow, called, dive } = get();
        const chain = diveChain(flow, called, dive);
        const path = [...dive.slice(0, chain.length), stepId];
        if (diveChain(flow, called, path).length !== path.length) return;
        // The inspector edits the open flow: nothing of it stays selected down here.
        set({ dive: path, selection: null });
      },

      leaveCalls(depth) {
        set((s) => ({ dive: s.dive.slice(0, Math.max(0, depth)) }));
      },

      async extract(stepIds, name) {
        const flow = get().flow;
        if (!flow || stepIds.length === 0) return false;
        try {
          const outcome = await api.extractSubflow(flow.id, flow.revision ?? 0, stepIds, name);
          applyOutcome(outcome.caller);
          set({ selection: { kind: "step", stepId: outcome.callStepId }, range: null, extractOpen: false, extractName: "", notice: t.extracted(outcome.subflow.flow.name) });
          await Promise.all([get().refreshList(), get().loadHistory(), get().loadCalled()]);
          return true;
        } catch (e) {
          if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
            await reloadCurrent();
            set({ notice: t.reloadedByConflict });
          } else {
            set({ error: message(e) });
          }
          return false;
        }
      },

      async onExternalChange(flowId) {
        if (get().called[flowId]) void get().loadCalled();
        await get().refreshList();
        void api
          .history(flowId)
          .then((h) => set({ histories: { ...get().histories, [flowId]: h } }))
          .catch(() => {});
        void get().loadTimeline(flowId);
        const current = get().flow;
        if (current?.id !== flowId) return;
        try {
          const latest = await api.getFlow(flowId);
          if ((latest.revision ?? 0) !== (current.revision ?? 0)) {
            await reloadCurrent();
            const selection = get().selection;
            if (selection?.kind === "step" && !findStep(latest.steps ?? [], selection.stepId)) {
              set({ selection: null });
            }
            set({ notice: t.externalChange });
          }
        } catch (e) {
          // Deleted elsewhere.
          if (e instanceof ApiError && e.code === "FLOW_NOT_FOUND") {
            set({ flow: null, validation: null, selection: null });
          }
        }
      },

      openEditor(stepId) {
        set({ editing: stepId, selection: { kind: "step", stepId } });
      },

      closeEditor() {
        set({ editing: null });
      },

      async testStep(stepId, values) {
        const flow = get().flow;
        if (!flow || get().stepTest?.running || (get().run && isActive(get().run))) return;
        set({ stepTest: { flowId: flow.id, stepId, running: true, result: null, error: null } });
        try {
          const result = await api.testStep(flow.id, stepId, values);
          set({ stepTest: { flowId: flow.id, stepId, running: false, result, error: null } });
          // Kept under the node's result name, so the node after it can be run alone next.
          const saveAs = findStep(flow.steps ?? [], stepId)?.saveAs;
          if (saveAs && result.status === "succeeded" && result.output !== undefined) {
            set((s) => ({ tested: { ...s.tested, [flow.id]: { ...(s.tested[flow.id] ?? {}), [saveAs]: result.output } } }));
          }
        } catch (e) {
          set({ stepTest: { flowId: flow.id, stepId, running: false, result: null, error: message(e) } });
        }
      },

      async stopStepTest() {
        if (!get().stepTest?.running) return;
        try {
          await api.stopRun(STEP_TEST_RUN);
        } catch {
          // It already ended: its result is on its way.
        }
      },

      async runTo(stepId) {
        if (get().run && isActive(get().run)) return;
        set({ trying: stepId });
        await get().startRun({ stopAt: stepId });
        if (!get().run) set({ trying: null });
      },

      async runFrom(stepId) {
        const { run, flow } = get();
        if (!flow || (run && isActive(run))) return;
        await get().startRun({ startAt: stepId, startValues: valuesBefore(run, flow.id, stepId) });
      },

      async startRun(options) {
        const flow = get().flow;
        if (!flow) return;
        try {
          const breakpoints = [...new Set([...runBreakpoints(get()), ...(options?.stopAt ? [options.stopAt] : [])])];
          const runId = await api.run(flow.id, undefined, {
            breakpoints,
            step: options?.step ?? false,
            ...(options?.startAt ? { startAt: options.startAt, startValues: options.startValues ?? {} } : {}),
          });
          set((s) => ({
            // Events may have arrived before the command returned.
            run: s.run?.runId === runId ? s.run : newRun(runId, flow.id),
            // A new run's result replaces what a node run alone gave.
            stepTest: null,
            // Values tested alone before this run are older than what it reads.
            tested: { ...s.tested, [flow.id]: {} },
            error: null,
            followRun: true,
            // A run's log opens under the chart.
            bottom: "log",
          }));
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async stopRun() {
        const run = get().run;
        if (!run) return;
        set((s) => (s.run?.runId === run.runId && isActive(s.run) ? { run: { ...s.run, stopping: true } } : s));
        try {
          await api.stopRun(run.runId);
        } catch (e) {
          if (e instanceof ApiError && e.code === "RUN_NOT_FOUND") {
            // It already ended but its last event never came: do not leave
            // the chart saying it runs, with a stop button that does nothing.
            set((s) =>
              s.run?.runId === run.runId && isActive(s.run)
                ? { run: { ...s.run, status: "cancelled", pause: null, stopping: false }, human: null }
                : s,
            );
            return;
          }
          set({ error: message(e) });
        }
      },

      async debug(command) {
        const run = get().run;
        if (!run || !isActive(run)) return false;
        // Resuming runs the stored revision: never with AI edits nobody has looked at.
        const resumes = !["pause", "setBreakpoints", "setVariable", "abort"].includes(command.action);
        if (resumes && run.pause && get().flow?.revision !== run.pause.revision && pendingReview(get()).length > 0) {
          set({ error: t.runMsg.reviewBeforeResume });
          return false;
        }
        try {
          const outcome = await api.debugRun(run.runId, command);
          if (outcome.updated) set({ notice: t.runMsg.continuingAt(outcome.revision) });
          return true;
        } catch (e) {
          set({
            error:
              e instanceof ApiError && e.code === "RESUME_INCOMPATIBLE"
                ? t.runMsg.pausedStepGone
                : e instanceof ApiError && e.code === "VARIABLE_NOT_EDITABLE"
                  ? t.pause.notEditable
                  : message(e),
          });
          return false;
        }
      },

      toggleFold(stepId, flowId) {
        const id = flowId ?? get().flow?.id;
        if (!id) return;
        const current = get().folded[id] ?? [];
        const next = current.includes(stepId) ? current.filter((s) => s !== stepId) : [...current, stepId];
        const folded = { ...get().folded, [id]: next };
        if (next.length === 0) delete folded[id];
        saveFolded(folded);
        set({ folded });
      },

      unfoldTo(stepId) {
        const flow = get().flow;
        const current = flow ? get().folded[flow.id] : undefined;
        if (!flow || !current) return;
        const around = new Set(ancestorsOf(flow.steps ?? [], stepId));
        const next = current.filter((id) => !around.has(id));
        if (next.length === current.length) return;
        const folded = { ...get().folded, [flow.id]: next };
        if (next.length === 0) delete folded[flow.id];
        saveFolded(folded);
        set({ folded });
      },

      toggleBreakpoint(stepId, flowId) {
        const id = flowId ?? get().flow?.id;
        if (!id) return;
        const current = get().breakpoints[id] ?? [];
        const next = current.includes(stepId) ? current.filter((s) => s !== stepId) : [...current, stepId];
        const breakpoints = { ...get().breakpoints, [id]: next };
        if (next.length === 0) delete breakpoints[id];
        saveBreakpoints(breakpoints);
        set({ breakpoints });
        const run = get().run;
        if (run && isActive(run) && run.flowId === get().flow?.id) {
          void api.debugRun(run.runId, { action: "setBreakpoints", stepIds: runBreakpoints(get()) }).catch(() => {});
        }
      },

      clearBreakpoints() {
        const flow = get().flow;
        if (!flow) return;
        const breakpoints = { ...get().breakpoints };
        delete breakpoints[flow.id];
        for (const id of Object.keys(get().called)) delete breakpoints[id];
        saveBreakpoints(breakpoints);
        set({ breakpoints });
        const run = get().run;
        if (run && isActive(run) && run.flowId === flow.id) {
          void api.debugRun(run.runId, { action: "setBreakpoints", stepIds: [] }).catch(() => {});
        }
      },

      onRunEvidence(evidence) {
        set((s) =>
          s.run && s.run.runId === evidence.runId && s.run.pause?.seq === evidence.seq ? { run: { ...s.run, evidence } } : s,
        );
      },

      dismissFailure() {
        set((s) => (s.run ? { run: { ...s.run, failure: null } } : s));
      },

      onRunEvent(env) {
        set((s) => {
          let human = s.human;
          let secretFix = s.secretFix;
          let reveal = s.reveal;
          const run: RunState =
            s.run && s.run.runId === env.runId ? { ...s.run, steps: { ...s.run.steps }, logs: s.run.logs } : newRun(env.runId);
          const push = (level: LogLevel, msg: string, stepId?: string | null) => {
            run.logs = [...run.logs, { seq: env.seq, at: env.at, level, message: msg, stepId }];
          };
          const path = callPathOf(env);
          // Followed, the chart goes where the run is: into a called flow
          // when a step starts inside it, back out when one starts outside.
          let dive = s.dive;
          if (env.type === "stepStarted" && s.followRun && callKey(path) !== callKey(s.dive)) {
            if (path.length === 0) dive = [];
            else if (diveChain(s.flow, s.called, path).length === path.length) dive = path;
          }
          // A pause shows where it stopped, followed or not: inside a call, or
          // back in the open flow (a breakpoint after a call, a call that failed).
          if (env.type === "paused" && callKey(path) !== callKey(s.dive)) {
            if (path.length === 0) dive = [];
            else if (diveChain(s.flow, s.called, path).length === path.length) dive = path;
          }
          const moved = dive !== s.dive ? { dive, selection: null } : {};
          // A value changed while paused (by the person) shows at the pause.
          const edited = asVariableChange(env);
          if (edited && run.pause && edited.iteration == null && callKey(path) === callKey(run.pause.callPath)) {
            run.pause = { ...run.pause, variables: { ...run.pause.variables, [edited.variable]: edited.value } };
          }
          if (path.length > 0 && env.type !== "paused" && env.type !== "resumed") {
            // Inside a called flow: its steps and variables are not the
            // chart's. They show when their call is unfolded or entered.
            const call = path[0]!;
            const key = callKey(path);
            const states = { ...(run.inner[key] ?? {}) };
            if (env.type === "stepStarted") {
              states[env.stepId] = "running";
              run.innerLatest = { ...run.innerLatest, [key]: env.stepId };
            }
            if (env.type === "stepFinished") {
              states[env.stepId] = env.outcome;
              // A failure reaches the call step itself and is logged there.
              if (human?.stepId === call) human = null;
            }
            if (env.type === "log") push(env.level, env.message, call);
            if (env.type === "humanActionRequired") {
              human = { stepId: call, message: env.message };
              push("warn", `${t.waitingForYou}: ${env.message}`, call);
            }
            run.inner = { ...run.inner, [key]: states };
            return { run, human, secretFix, ...moved };
          }
          const change = asVariableChange(env);
          if (change) run.changes = [...run.changes, change];
          switch (env.type) {
            case "runStarted":
              secretFix = null;
              run.status = "running";
              run.flowId = env.flowId;
              run.revision = env.revision;
              push("info", `▶ ${env.flowName}${t.runMsg.atRevision(env.revision)}`);
              break;
            case "stepStarted":
              run.steps[env.stepId] = "running";
              if ((env.attempt ?? 1) <= 1) run.starts = [...run.starts, { stepId: env.stepId, seq: env.seq }];
              break;
            case "humanActionRequired":
              human = { stepId: env.stepId, message: env.message };
              push("warn", `${t.waitingForYou}: ${env.message}`, env.stepId);
              break;
            case "stepFinished":
              if (human?.stepId === env.stepId) human = null;
              run.steps[env.stepId] = env.outcome;
              if (env.error) {
                push("error", `${errorLine(env.error, findStep(s.flow?.steps ?? [], env.stepId))}${env.willRetry ? t.runMsg.willRetry : ""}`, env.stepId);
                secretFix = secretFixOf(env.error) ?? secretFix;
              }
              break;
            case "log":
              push(env.level, env.message, env.stepId);
              break;
            case "paused": {
              // Inside a call, the step's state lives with the call's (see `inner`).
              const states = path.length > 0 ? { ...(run.inner[callKey(path)] ?? {}) } : run.steps;
              run.status = "paused";
              run.pause = {
                callPath: path,
                seq: env.seq,
                stepId: env.stepId,
                stepType: env.stepType,
                reason: env.reason,
                error: env.error ?? null,
                variables: env.variables,
                revision: env.revision,
              };
              run.evidence = null;
              states[env.stepId] = env.reason === "error" ? "failed" : "paused";
              if (path.length > 0) run.inner = { ...run.inner, [callKey(path)]: states };
              // The log points at what the open flow shows: the call step.
              const at = path[0] ?? env.stepId;
              push(env.reason === "error" ? "error" : "info", env.reason === "error" ? `❚❚ ${t.runMsg.pausedOnError}` : `❚❚ ${t.runMsg.paused}`, at);
              if (path.length === 0) reveal = { stepId: env.stepId, seq: (reveal?.seq ?? 0) + 1 };
              break;
            }
            case "resumed": {
              const pause = run.pause;
              run.status = "running";
              run.pause = null;
              run.evidence = null;
              if (pause && pause.callPath.length > 0) {
                const key = callKey(pause.callPath);
                const states = { ...(run.inner[key] ?? {}) };
                if (states[pause.stepId] === "paused") delete states[pause.stepId];
                run.inner = { ...run.inner, [key]: states };
              } else if (pause && run.steps[pause.stepId] === "paused") delete run.steps[pause.stepId];
              if (env.revision != null && pause?.callPath.length === 0) run.revision = env.revision;
              push("info", `▶ ${(t.runMsg.resume as Record<string, string>)[env.action] ?? env.action}${env.revision != null ? t.runMsg.atRevision(env.revision) : ""}`);
              break;
            }
            case "runFinished":
              human = null;
              run.stopping = false;
              run.status = env.status;
              run.pause = null;
              run.failure = env.status === "failed" ? (env.error ?? null) : null;
              push(env.status === "succeeded" ? "info" : "error", `■ ${t.status[env.status]}${t.runMsg.took(env.durationMs)}`);
              break;
          }
          return { run, human, secretFix, reveal, ...moved };
        });
        // Where a run pauses is shown, even inside a folded frame.
        const reveal = get().reveal;
        if (env.type === "paused" && reveal?.stepId === env.stepId) get().unfoldTo(env.stepId);
        // 「ここまで実行」: the pause before the node is only a way to get there; run it and pause after.
        const trying = get().trying;
        if (trying && env.type === "paused" && env.stepId === trying && env.reason === "breakpoint") {
          set({ trying: null });
          void get().debug({ action: "stepOver" });
        } else if (trying && env.type === "runFinished") set({ trying: null });
      },

      hideTrail() {
        set((s) => (s.run ? { run: { ...s.run, trailHidden: true } } : s));
      },

      clearLog() {
        set((s) => (s.run ? { run: { ...s.run, logs: [] } } : s));
      },

      dismiss() {
        set({ notice: null, error: null });
      },

      async loadHistory() {
        const id = get().flow?.id;
        if (!id) return;
        try {
          const [history] = await Promise.all([api.history(id), get().loadTimeline(id)]);
          set({ histories: { ...get().histories, [id]: history } });
          // Ignore a late answer for a flow that is no longer open.
          if (get().flow?.id === id) set({ history });
        } catch {
          // The timeline is secondary; editing keeps working without it.
        }
      },

      approve(revision) {
        const id = get().flow?.id;
        if (!id) return;
        const reviewed = { ...get().reviewed, [id]: [...(get().reviewed[id] ?? []), revision] };
        saveReviewed(reviewed);
        set({ reviewed });
      },

      markAllReviewed() {
        const id = get().flow?.id;
        if (!id) return;
        const revisions = pendingReview(get()).map((e) => e.revision);
        const reviewed = { ...get().reviewed, [id]: [...(get().reviewed[id] ?? []), ...revisions] };
        saveReviewed(reviewed);
        set({ reviewed });
      },

      async approveAll() {
        const flow = get().flow;
        if (!flow) return;
        get().markAllReviewed();
        try {
          await api.submitReview(flow.id, { revision: flow.revision ?? 0, verdict: "approved" });
          set({ notice: t.approved });
        } catch (e) {
          // Marked here anyway; Core refuses only when the flow moved on (REVISION_CONFLICT).
          set({ error: message(e) });
        }
        await get().loadTimeline(flow.id);
      },

      async approveAndPublish() {
        const flow = get().flow;
        if (!flow) return;
        try {
          const published = await api.approveAndPublish(flow.id, flow.revision ?? 0);
          get().markAllReviewed();
          set({ notice: t.approvedPublished(published.version), published, error: null });
          await get().loadVersions();
        } catch (e) {
          set({ error: publishMessage(e) });
        }
        await get().loadTimeline(flow.id);
      },

      async publish(version) {
        const flow = get().flow;
        if (!flow) return;
        try {
          const published = await api.publishFlow(
            flow.id,
            version == null ? { expectedRevision: flow.revision ?? 0, note: "" } : { version, note: "" },
          );
          set({ notice: t.publishDone(published.version), published, error: null });
          await get().loadVersions();
        } catch (e) {
          set({ error: publishMessage(e) });
        }
      },

      async unpublish() {
        const flow = get().flow;
        if (!flow) return;
        try {
          await api.unpublishFlow(flow.id);
          set({ notice: t.unpublished, published: null, error: null });
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async loadApprovals() {
        try {
          set({ approvals: await api.listApprovals() });
        } catch {
          // The banner is a convenience; the AI's call fails safe without an answer.
        }
      },

      async loadPickRequests() {
        try {
          set({ pickRequests: await api.listPickRequests() });
        } catch {
          // A convenience: the banner in the browser asks the person anyway.
        }
      },

      async cancelPickRequest(id) {
        try {
          await api.cancelPickRequest(id);
        } catch (e) {
          set({ error: message(e) });
        }
        await get().loadPickRequests();
      },

      async decideApproval(id, approve) {
        try {
          await api.decideApproval(id, approve);
          set({ notice: approve ? t.approvalApproved : t.approvalDenied, error: null });
        } catch (e) {
          set({ error: message(e) });
        }
        await get().loadApprovals();
      },

      setPolicyOpen(open) {
        set(open ? { policyOpen: true } : { policyOpen: false, policy: null });
        if (!open) return;
        void api
          .getPolicy()
          .then((policy) => set({ policy }))
          .catch((e) => set({ error: message(e), policyOpen: false }));
      },

      async savePolicy(policy) {
        try {
          set({ policy: await api.savePolicy(policy), notice: t.policySaved, error: null });
          return true;
        } catch (e) {
          set({ error: message(e) });
          return false;
        }
      },

      async sendBack(reason, steps) {
        const flow = get().flow;
        if (!flow) return false;
        try {
          await api.submitReview(flow.id, {
            revision: flow.revision ?? 0,
            verdict: "rejected",
            reason: reason.trim(),
            steps: steps.filter((n) => n.note.trim()).map((n) => ({ ...n, note: n.note.trim() })),
          });
          set({ notice: t.sentBack });
          await get().loadTimeline(flow.id);
          return true;
        } catch (e) {
          set({ error: message(e) });
          return false;
        }
      },

      async loadTimeline(id) {
        try {
          const timeline = await api.reviewTimeline(id);
          // Polled while reviewing: keep the old object when nothing changed.
          if (JSON.stringify(timeline) === JSON.stringify(get().timelines[id])) return;
          set({ timelines: { ...get().timelines, [id]: timeline } });
        } catch {
          // Evidence is secondary; reviewing works from the journal alone.
        }
      },

      async revert(entry) {
        const blocker = revertBlocker(entry, get().history);
        if (blocker) {
          set({ error: blocker });
          return;
        }
        const ok = await get().applyOps(entry.inverse ?? []);
        if (ok) {
          get().approve(entry.revision);
          set({ notice: t.reverted });
        }
      },

      async revertAll() {
        const group = pendingReview(get());
        if (group.length === 0) return;
        const blocker = groupRevertBlocker(group, get().history);
        if (blocker) {
          set({ error: blocker });
          return;
        }
        // Newest first, so each inverse meets the state its own edit left.
        const ok = await get().applyOps(group.flatMap((e) => e.inverse ?? []));
        if (ok) {
          get().markAllReviewed();
          set({ notice: t.reverted });
        }
      },

      async loadInbox() {
        const ids = get().summaries.map((s) => s.id);
        const pairs = await Promise.all(
          ids.map((id) =>
            api
              .history(id)
              .then((h) => [id, h] as const)
              .catch(() => [id, [] as HistoryEntry[]] as const),
          ),
        );
        for (const id of ids) void get().loadTimeline(id);
        // A journal fetched since (after an outside edit) may be newer than
        // this batch's answer; keep whichever reaches the later revision.
        const latest = (h: HistoryEntry[] | undefined) => h?.at(-1)?.revision ?? -1;
        const histories = { ...get().histories };
        for (const [id, h] of pairs) if (latest(h) >= latest(histories[id])) histories[id] = h;
        set({ histories });
      },

      setReviewing(on) {
        set({ reviewing: on, place: on ? "review" : "flows", secretsOpen: false });
      },

      setSearchOpen(open) {
        set((s) => ({ searchOpen: open, searchAsked: open ? s.searchAsked + 1 : s.searchAsked }));
      },

      setPaletteOpen(open, at, anchor) {
        // Steps are added to the open flow: show it.
        set(
          open
            ? { paletteOpen: true, paletteAt: at ?? null, paletteAnchor: anchor ?? null, dive: [] }
            : { paletteOpen: false, paletteAt: null, paletteAnchor: null },
        );
      },

      async loadVersions() {
        const id = get().flow?.id;
        if (!id) return;
        try {
          const [versions, published] = await Promise.all([api.listVersions(id), api.publishedState(id)]);
          if (get().flow?.id === id) set({ versions, published });
        } catch {
          // Versions are secondary; editing keeps working without them.
        }
      },

      async createVersion(name, note) {
        const flow = get().flow;
        if (!flow) return false;
        try {
          await api.createVersion(flow.id, flow.revision ?? 0, { name, note });
          await get().loadVersions();
          set({ notice: t.versionSaved, error: null });
          return true;
        } catch (e) {
          if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
            await reloadCurrent();
            set({ notice: t.reloadedByConflict });
          } else {
            set({ error: message(e) });
          }
          return false;
        }
      },

      async restoreVersion(number) {
        const ok = await mutate((id, rev) => api.restoreVersion(id, number, rev));
        if (ok) set({ notice: t.restored, selection: null });
      },

      async exportFlow() {
        const id = get().flow?.id;
        if (!id) return;
        try {
          const path = await api.exportFlow(id);
          set({ notice: `${t.exported}: ${path}`, error: null });
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async importFile(contents, onConflict) {
        try {
          const outcome = await api.importFlow(contents, onConflict);
          applyOutcome(outcome);
          set({ pendingImport: null, selection: null, history: [], versions: [], notice: `${t.imported}: ${outcome.flow.name}` });
          await Promise.all([get().refreshList(), get().loadHistory(), get().loadVersions()]);
          return true;
        } catch (e) {
          if (e instanceof ApiError && e.code === "IMPORT_CONFLICT") {
            const name = (e.details as { name?: string } | undefined)?.name ?? "";
            set({ pendingImport: { contents, name }, error: null });
          } else {
            set({ pendingImport: null, error: message(e) });
          }
          return false;
        }
      },

      cancelImport() {
        set({ pendingImport: null });
      },

      setPasteOpen(mode) {
        set({ pasteOpen: mode });
      },

      async pasteAnswer(text, into) {
        const flow = into ? get().flow : null;
        try {
          const result = await api.pasteAiAnswer(text, flow?.id, flow?.revision);
          if (result.outcome) {
            applyOutcome(result.outcome);
            set({ selection: null, error: null, ...(flow ? {} : { history: [], versions: [] }) });
            await Promise.all([get().refreshList(), get().loadHistory(), get().loadVersions(), get().loadCalled()]);
          }
          return result;
        } catch (e) {
          set({ error: message(e) });
          return null;
        }
      },

      async setWorkspace(path, shared) {
        try {
          // Studio restarts on success, so nothing after this runs.
          await api.setWorkspace(path, shared);
        } catch (e) {
          set({ error: message(e) });
        }
      },
    };
  });
}
