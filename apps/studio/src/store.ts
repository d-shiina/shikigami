// Studio state. All mutations go through the backend API as EditOps; the
// store only mirrors what Core returns (scenario, validation, undo state).
import type {
  DebugCommand,
  EditOp,
  EditOutcome,
  HistoryEntry,
  ImportConflict,
  LogLevel,
  PauseReason,
  ReviewTimeline,
  RunError,
  RunEventEnvelope,
  RunStatus,
  Scenario,
  ScenarioPatch,
  ScenarioSummary,
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
  type SecretRequest,
} from "./lib/api";
import { t } from "./lib/i18n";
import { neighbor, outline } from "./lib/outline";
import { summarize } from "./lib/review";
import { setScenarioNames } from "./lib/sentence";

export type Selection =
  | { kind: "step"; stepId: string }
  | { kind: "slot"; parentId: string | null; block: string | null }
  | null;

/**
 * The places in the sidebar; each fills the window right of it. "library" is
 * the page of all scenarios, "scenarios" the editor of the open one.
 */
export type Place = "library" | "scenarios" | "review" | "secrets" | "settings";

/** Tabs of the panel under the chart: what happened, and what is wrong. */
export type BottomTab = "log" | "issues";

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
  /** The scenario revision the run executes. */
  revision: number;
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

export type RunState = {
  runId: string;
  /** The scenario being run (known from `runStarted`). */
  scenarioId: string | null;
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
   * Steps of called scenarios, by the call steps they ran under (`callKey`):
   * what an unfolded or entered call shows. Their events never touch `steps`.
   */
  inner: Record<string, Record<string, StepRunState>>;
  /** The step each call path started last (a control step stays running while its blocks run). */
  innerLatest: Record<string, string>;
};

/** The `scenario.call` steps a run event happened inside (outermost first). */
const callPathOf = (env: RunEventEnvelope): string[] => (env as { callPath?: string[] }).callPath ?? [];

/** Key of a call path (outermost call step first), for `inner` and `unfolded`. */
export const callKey = (path: string[]): string => path.join("/");

/** One level of the chart the person has entered: the call step and the scenario it runs. */
export type DiveLevel = { stepId: string; scenario: Scenario };

/**
 * The scenarios behind a path of entered call steps, outermost first. Stops at
 * the first call that is gone or whose scenario is not loaded.
 */
export function diveChain(root: Scenario | null, called: Record<string, Scenario>, path: string[]): DiveLevel[] {
  const chain: DiveLevel[] = [];
  let current = root;
  for (const stepId of path) {
    const step = current ? findStep(current.steps ?? [], stepId) : undefined;
    const target = step?.type === "scenario.call" ? step.params?.scenario : undefined;
    const callee = typeof target === "string" ? called[target] : undefined;
    if (!callee) break;
    chain.push({ stepId, scenario: callee });
    current = callee;
  }
  return chain;
}

/** Scenarios a step tree calls directly. */
export function calledIds(steps: Step[]): string[] {
  const ids = new Set<string>();
  const walk = (list: Step[]) => {
    for (const step of list) {
      const target = step.type === "scenario.call" ? step.params?.scenario : undefined;
      if (typeof target === "string" && target) ids.add(target);
      for (const children of Object.values(step.blocks ?? {})) walk(children);
    }
  };
  walk(steps);
  return [...ids];
}

export type StepStart = { stepId: string; seq: number };

export type StudioState = {
  summaries: ScenarioSummary[];
  stepTypes: StepTypeDef[];
  scenario: Scenario | null;
  validation: ValidationReport | null;
  canUndo: boolean;
  canRedo: boolean;
  selection: Selection;
  notice: string | null;
  error: string | null;
  run: RunState | null;
  /** Core's change journal for the open scenario, oldest first. */
  history: HistoryEntry[];
  /** Revisions of non-Studio changes the user has looked at, per scenario. */
  reviewed: Record<string, number[]>;
  /** Every scenario's journal, oldest first, for the review inbox. */
  histories: Record<string, HistoryEntry[]>;
  /** Per scenario: changes and evidence since the last approval (Core's reviews). */
  timelines: Record<string, ReviewTimeline>;
  /** The review desk is open instead of the scenario list. */
  reviewing: boolean;
  /** A step the canvas should bring into view; `seq` changes on every request. */
  reveal: { stepId: string; seq: number } | null;
  /** While running, keep the running step in view. */
  followRun: boolean;
  /** Steps to pause before, per scenario (this PC only). */
  breakpoints: Record<string, string[]>;
  outlineOpen: boolean;
  paletteOpen: boolean;
  place: Place;
  /** The panel under the chart (run log, issues); null when closed. */
  bottom: BottomTab | null;
  /** The scenario's record and versions, opened from its revision. */
  historyOpen: boolean;
  /** Named versions of the open scenario, newest first. */
  versions: VersionSummary[];
  /** The scenarios the open one calls, directly or deeper, by id, for call nodes and their inputs. */
  called: Record<string, Scenario>;
  /** Call steps shown unfolded on the chart, by `callKey` of their path. */
  unfolded: Record<string, boolean>;
  /** Call steps the chart has entered (double-click), outermost first: it shows the innermost one's scenario. */
  dive: string[];
  workspace: WorkspaceInfo | null;
  /** A file whose scenario already exists, waiting for the user's choice. */
  pendingImport: { contents: string; name: string } | null;
  /** Registered secrets (names, user names, sites; never values). */
  secrets: SecretInfo[];
  secretKeyLocation: string;
  /** Secrets are listed by name only: their key is not on this PC / user. */
  secretKeyMissing: boolean;
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
  setHistoryOpen(open: boolean): void;
  /** Name, description and run settings of the open scenario. */
  updateScenario(patch: ScenarioPatch): Promise<void>;
  /** Adds a step after the selection; `params` and `name` override the type's defaults (palette presets). */
  addStep(type: string, params?: Record<string, unknown>, name?: string): Promise<void>;
  moveSelected(delta: -1 | 1): Promise<void>;
  removeSelected(): Promise<void>;
  updateStep(stepId: string, patch: StepPatch): Promise<void>;
  setVariable(variable: VariableDef): Promise<void>;
  removeVariable(name: string): Promise<void>;
  loadCalled(): Promise<void>;
  /** `key`: `callKey` of the call step's path. */
  toggleUnfolded(key: string): void;
  /** Shows the scenario a call step of the chart's current level runs, in place. */
  enterCall(stepId: string): void;
  /** Goes back up to `depth` entered calls (0: the open scenario itself). */
  leaveCalls(depth: number): void;
  /** Moves neighbouring steps into a new scenario; returns true when done. */
  extract(stepIds: string[], name: string): Promise<boolean>;
  onExternalChange(scenarioId: string): Promise<void>;
  /** `step`: pause before the first step. */
  startRun(options?: { step?: boolean }): Promise<void>;
  stopRun(): Promise<void>;
  /** Step command for the paused (or running) run; false when it was refused. */
  debug(command: DebugCommand): Promise<boolean>;
  toggleBreakpoint(stepId: string): void;
  onRunEvent(event: RunEventEnvelope): void;
  onRunEvidence(evidence: RunEvidence): void;
  /** Closes the notice about a failed run. */
  dismissFailure(): void;
  clearLog(): void;
  dismiss(): void;
  loadHistory(): Promise<void>;
  approve(revision: number): void;
  /** Marks every unreviewed external change of the open scenario as looked at (this PC only). */
  markAllReviewed(): void;
  /** Keeps the open scenario's current revision: recorded in Core as approved. */
  approveAll(): Promise<void>;
  /** Sends the current revision back to the AI with a reason it reads over MCP. */
  sendBack(reason: string, steps: StepNote[]): Promise<boolean>;
  loadTimeline(id: string): Promise<void>;
  /** Reverts one journal entry by sending its inverse ops to Core as a new edit. */
  revert(entry: HistoryEntry): Promise<void>;
  /** Reverts every unreviewed external change of the open scenario in one edit. */
  revertAll(): Promise<void>;
  loadInbox(): Promise<void>;
  setReviewing(on: boolean): void;
  setPaletteOpen(open: boolean): void;
  loadVersions(): Promise<void>;
  createVersion(name: string, note: string): Promise<boolean>;
  restoreVersion(number: number): Promise<void>;
  exportScenario(): Promise<void>;
  /** Imports file contents; on IMPORT_CONFLICT keeps them in `pendingImport`. True once it is in. */
  importFile(contents: string, onConflict?: ImportConflict): Promise<boolean>;
  cancelImport(): void;
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
  resetSecrets(): Promise<void>;
  setSecretsOpen(open: boolean): void;
  loadSecretRequests(): Promise<void>;
  dismissSecretRequest(name: string): Promise<void>;
  /** Opens the secrets dialog on the form for `prefill.name`, with its sites added. */
  openSecretForm(prefill: SecretPrefill): void;
  clearSecretPrefill(): void;
  dismissSecretFix(): void;
};

export type SecretPrefill = { name: string; sites: string[]; fields: SecretField[] };

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
    else if (op.op === "updateScenario") keys.add("scenario");
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
  state: Pick<StudioState, "history" | "reviewed" | "scenario"> & Partial<Pick<StudioState, "timelines">>,
): HistoryEntry[] {
  const id = state.scenario?.id ?? "";
  return pendingIn(state.history, state.reviewed[id], approvedUpTo(state.timelines?.[id]));
}

/** The last revision someone approved (on any PC sharing this workspace's history), or 0. */
export function approvedUpTo(timeline: ReviewTimeline | undefined): number {
  return timeline?.lastApproval?.revision ?? 0;
}

/** Unreviewed external edits in one scenario's journal, newest first. */
export function pendingIn(history: HistoryEntry[], reviewed: number[] | undefined, approved = 0): HistoryEntry[] {
  const seen = new Set(reviewed ?? []);
  return history
    .filter((e) => isExternal(e) && isRevertible(e) && e.revision > approved && !seen.has(e.revision))
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

function saveBreakpoints(breakpoints: Record<string, string[]>) {
  try {
    globalThis.localStorage?.setItem(BREAKPOINTS_KEY, JSON.stringify(breakpoints));
  } catch {
    // Breakpoints are a convenience on this PC.
  }
}

/** A run that has not ended yet (running or paused). */
export const isActive = (run: RunState | null) => run?.status === "running" || run?.status === "paused" || run?.status === "pending";

const newRun = (runId: string, scenarioId: string | null = null): RunState => ({
  runId,
  scenarioId,
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
});
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
  "control.while": { condition: "false" },
  "control.repeat": { count: 1 },
  "control.forEach": { items: "[]", itemVar: "item" },
  get "control.fail"() {
    return { message: t.severity.error };
  },
  "variable.set": { name: "value", value: "" },
  "log.message": { message: "" },
  "flow.delay": { ms: 1000 },
  "wait.until": { condition: "true" },
  "scenario.call": { scenario: "" },
  "browser.open": { url: "https://" },
  "browser.click": { target: { role: "button", name: "" } },
  "browser.fill": { target: { label: "" }, value: "" },
  "browser.waitFor": { target: { text: "" } },
  "browser.getText": { target: { text: "" } },
  "browser.press": { key: "Enter" },
};

export function newStepId(): string {
  return `stp_${crypto.randomUUID().replaceAll("-", "")}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createStudioStore(api: Api): StoreApi<StudioState> {
  return createStore<StudioState>()((set, get) => {
    const applyOutcome = (outcome: EditOutcome) => {
      set({
        scenario: outcome.scenario,
        validation: outcome.validation,
        canUndo: outcome.canUndo,
        canRedo: outcome.canRedo,
        error: null,
      });
    };

    const reloadCurrent = async () => {
      const id = get().scenario?.id;
      if (!id) return;
      const [scenario, validation, undo] = await Promise.all([api.getScenario(id), api.validate(id), api.undoState(id)]);
      set({ scenario, validation, canUndo: undo.canUndo, canRedo: undo.canRedo });
      await Promise.all([get().loadHistory(), get().loadCalled()]);
    };

    /** Runs a mutation; on a revision conflict reloads and tells the user. */
    const mutate = async (fn: (id: string, revision: number) => Promise<EditOutcome>): Promise<boolean> => {
      const scenario = get().scenario;
      if (!scenario) return false;
      try {
        applyOutcome(await fn(scenario.id, scenario.revision ?? 0));
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
      scenario: null,
      validation: null,
      canUndo: false,
      canRedo: false,
      selection: null,
      notice: null,
      error: null,
      run: null,
      history: [],
      reviewed: loadReviewed(),
      histories: {},
      timelines: {},
      reviewing: false,
      reveal: null,
      followRun: true,
      breakpoints: loadBreakpoints(),
      outlineOpen: loadFlag(OUTLINE_KEY, false),
      paletteOpen: false,
      place: "library",
      bottom: null,
      historyOpen: false,
      versions: [],
      called: {},
      unfolded: {},
      dive: [],
      workspace: null,
      pendingImport: null,
      secrets: [],
      secretKeyLocation: "",
      secretKeyMissing: false,
      secretsOpen: false,
      human: null,
      secretRequests: [],
      secretFix: null,
      secretPrefill: null,

      async init() {
        try {
          const [stepTypes, summaries] = await Promise.all([api.listStepTypes(), api.listScenarios()]);
          setScenarioNames(new Map(summaries.map((s) => [s.id, s.name] as const)));
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
          set({ secrets, secretKeyLocation: keyLocation, secretKeyMissing: keyMissing });
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

      async resetSecrets() {
        try {
          await api.resetSecrets();
          await get().loadSecrets();
        } catch (e) {
          set({ error: message(e) });
        }
      },

      setSecretsOpen(open) {
        get().setPlace(open ? "secrets" : "scenarios");
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
          const summaries = await api.listScenarios();
          setScenarioNames(new Map(summaries.map((s) => [s.id, s.name] as const)));
          set({ summaries });
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async open(id) {
        try {
          const [scenario, validation, undo] = await Promise.all([api.getScenario(id), api.validate(id), api.undoState(id)]);
          set({
            // Opened from the library (or by the AI while it shows): show it in the editor.
            ...(get().place === "library" ? { place: "scenarios" as const } : {}),
            scenario,
            validation,
            canUndo: undo.canUndo,
            canRedo: undo.canRedo,
            selection: null,
            error: null,
            history: [],
            versions: [],
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
          const outcome = await api.createScenario({ name });
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
          const outcome = await api.duplicateScenario(id);
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
          const current = get().scenario;
          await api.deleteScenario(id, current?.id === id ? current.revision : undefined);
          if (current?.id === id) set({ scenario: null, validation: null, selection: null });
          await get().refreshList();
        } catch (e) {
          if (e instanceof ApiError && e.code === "SCENARIO_IN_USE") {
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

      // Picking a step of the open scenario brings the chart back up to it.
      select(selection) {
        set(selection ? { selection, dive: [] } : { selection });
      },

      goTo(stepId) {
        set({ selection: { kind: "step", stepId }, reveal: { stepId, seq: (get().reveal?.seq ?? 0) + 1 }, dive: [] });
      },

      stepBy(delta) {
        const { scenario, stepTypes, selection } = get();
        const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
        const ids = outline(scenario?.steps ?? [], defs).map((i) => i.id);
        const next = neighbor(ids, selection?.kind === "step" ? selection.stepId : null, delta);
        if (next) get().goTo(next);
      },

      changeBy(delta) {
        const { scenario, stepTypes, selection } = get();
        const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
        const changed = summarize([...pendingReview(get())].reverse()).steps;
        const all = outline(scenario?.steps ?? [], defs).map((i) => i.id);
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

      setHistoryOpen(open) {
        set({ historyOpen: open });
      },

      async updateScenario(patch) {
        await get().applyOps([{ op: "updateScenario", patch }]);
      },

      async addStep(type, params, name) {
        const { scenario, selection } = get();
        if (!scenario) return;
        let position: { parentId?: string | null; block?: string | null; index?: number | null } = {};
        if (selection?.kind === "slot") {
          position = { parentId: selection.parentId, block: selection.block };
        } else if (selection?.kind === "step") {
          const loc = locate(scenario.steps ?? [], selection.stepId);
          if (loc) position = { parentId: loc.parentId, block: loc.block, index: loc.index + 1 };
        }
        const step: Step = { id: newStepId(), type, params: params ?? { ...(DEFAULT_PARAMS[type] ?? {}) }, ...(name ? { name } : {}) };
        const ok = await get().applyOps([{ op: "addStep", step, position }]);
        if (ok && step.id) set({ selection: { kind: "step", stepId: step.id } });
      },

      async moveSelected(delta) {
        const { scenario, selection } = get();
        if (!scenario || selection?.kind !== "step") return;
        const loc = locate(scenario.steps ?? [], selection.stepId);
        if (!loc) return;
        const index = loc.index + delta;
        if (index < 0 || index >= loc.siblings) return;
        await get().applyOps([
          { op: "moveStep", stepId: selection.stepId, position: { parentId: loc.parentId, block: loc.block, index } },
        ]);
      },

      async removeSelected() {
        const selection = get().selection;
        if (selection?.kind !== "step") return;
        const ok = await get().applyOps([{ op: "removeStep", stepId: selection.stepId }]);
        if (ok) set({ selection: null });
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
        const scenario = get().scenario;
        if (!scenario) return;
        // Calls inside called scenarios too, so the chart can enter them.
        const called: Record<string, Scenario> = {};
        const seen = new Set([scenario.id]);
        let next = calledIds(scenario.steps ?? []);
        while (next.length > 0) {
          const ids = next.filter((id) => !seen.has(id));
          ids.forEach((id) => seen.add(id));
          const loaded = await Promise.all(ids.map((id) => api.getScenario(id).catch(() => null)));
          next = [];
          for (const callee of loaded) {
            if (!callee) continue;
            called[callee.id] = callee;
            next.push(...calledIds(callee.steps ?? []));
          }
        }
        // Ignore a late answer for a scenario that is no longer open.
        if (get().scenario?.id !== scenario.id) return;
        set({ called });
      },

      toggleUnfolded(key) {
        set((s) => ({ unfolded: { ...s.unfolded, [key]: !s.unfolded[key] } }));
      },

      enterCall(stepId) {
        const { scenario, called, dive } = get();
        const chain = diveChain(scenario, called, dive);
        const path = [...dive.slice(0, chain.length), stepId];
        if (diveChain(scenario, called, path).length !== path.length) return;
        // The inspector edits the open scenario: nothing of it stays selected down here.
        set({ dive: path, selection: null });
      },

      leaveCalls(depth) {
        set((s) => ({ dive: s.dive.slice(0, Math.max(0, depth)) }));
      },

      async extract(stepIds, name) {
        const scenario = get().scenario;
        if (!scenario || stepIds.length === 0) return false;
        try {
          const outcome = await api.extractSubscenario(scenario.id, scenario.revision ?? 0, stepIds, name);
          applyOutcome(outcome.caller);
          set({ selection: { kind: "step", stepId: outcome.callStepId }, notice: t.extracted(outcome.subscenario.scenario.name) });
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

      async onExternalChange(scenarioId) {
        if (get().called[scenarioId]) void get().loadCalled();
        await get().refreshList();
        void api
          .history(scenarioId)
          .then((h) => set({ histories: { ...get().histories, [scenarioId]: h } }))
          .catch(() => {});
        void get().loadTimeline(scenarioId);
        const current = get().scenario;
        if (current?.id !== scenarioId) return;
        try {
          const latest = await api.getScenario(scenarioId);
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
          if (e instanceof ApiError && e.code === "SCENARIO_NOT_FOUND") {
            set({ scenario: null, validation: null, selection: null });
          }
        }
      },

      async startRun(options) {
        const scenario = get().scenario;
        if (!scenario) return;
        try {
          const breakpoints = get().breakpoints[scenario.id] ?? [];
          const runId = await api.run(scenario.id, undefined, { breakpoints, step: options?.step ?? false });
          set((s) => ({
            // Events may have arrived before the command returned.
            run: s.run?.runId === runId ? s.run : newRun(runId, scenario.id),
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
        try {
          await api.stopRun(run.runId);
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async debug(command) {
        const run = get().run;
        if (!run || !isActive(run)) return false;
        // Resuming runs the stored revision: never with AI edits nobody has looked at.
        const resumes = !["pause", "setBreakpoints", "abort"].includes(command.action);
        if (resumes && run.pause && get().scenario?.revision !== run.pause.revision && pendingReview(get()).length > 0) {
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
                : message(e),
          });
          return false;
        }
      },

      toggleBreakpoint(stepId) {
        const id = get().scenario?.id;
        if (!id) return;
        const current = get().breakpoints[id] ?? [];
        const next = current.includes(stepId) ? current.filter((s) => s !== stepId) : [...current, stepId];
        const breakpoints = { ...get().breakpoints, [id]: next };
        if (next.length === 0) delete breakpoints[id];
        saveBreakpoints(breakpoints);
        set({ breakpoints });
        const run = get().run;
        if (run && isActive(run) && run.scenarioId === id) {
          void api.debugRun(run.runId, { action: "setBreakpoints", stepIds: next }).catch(() => {});
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
          if (path.length > 0) {
            // Inside a called scenario: its steps and variables are not the
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
            return { run, human, secretFix };
          }
          const change = asVariableChange(env);
          if (change) run.changes = [...run.changes, change];
          switch (env.type) {
            case "runStarted":
              secretFix = null;
              run.status = "running";
              run.scenarioId = env.scenarioId;
              push("info", `▶ ${env.scenarioName} (rev ${env.revision})`);
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
                push("error", `${env.error.code}: ${env.error.message}${env.willRetry ? t.runMsg.willRetry : ""}`, env.stepId);
                secretFix = secretFixOf(env.error) ?? secretFix;
              }
              break;
            case "log":
              push(env.level, env.message, env.stepId);
              break;
            case "paused": {
              run.status = "paused";
              run.pause = {
                seq: env.seq,
                stepId: env.stepId,
                stepType: env.stepType,
                reason: env.reason,
                error: env.error ?? null,
                variables: env.variables,
                revision: env.revision,
              };
              run.evidence = null;
              run.steps[env.stepId] = env.reason === "error" ? "failed" : "paused";
              push(env.reason === "error" ? "error" : "info", env.reason === "error" ? `❚❚ ${t.runMsg.pausedOnError}` : `❚❚ ${t.runMsg.paused}`, env.stepId);
              reveal = { stepId: env.stepId, seq: (reveal?.seq ?? 0) + 1 };
              break;
            }
            case "resumed": {
              const pause = run.pause;
              run.status = "running";
              run.pause = null;
              run.evidence = null;
              if (pause && run.steps[pause.stepId] === "paused") delete run.steps[pause.stepId];
              push("info", `▶ ${(t.runMsg.resume as Record<string, string>)[env.action] ?? env.action}${env.revision != null ? t.runMsg.atRevision(env.revision) : ""}`);
              break;
            }
            case "runFinished":
              human = null;
              run.status = env.status;
              run.pause = null;
              run.failure = env.status === "failed" ? (env.error ?? null) : null;
              push(env.status === "succeeded" ? "info" : "error", `■ ${t.status[env.status]} (${env.durationMs} ms)`);
              break;
          }
          return { run, human, secretFix, reveal };
        });
      },

      clearLog() {
        set((s) => (s.run ? { run: { ...s.run, logs: [] } } : s));
      },

      dismiss() {
        set({ notice: null, error: null });
      },

      async loadHistory() {
        const id = get().scenario?.id;
        if (!id) return;
        try {
          const [history] = await Promise.all([api.history(id), get().loadTimeline(id)]);
          set({ histories: { ...get().histories, [id]: history } });
          // Ignore a late answer for a scenario that is no longer open.
          if (get().scenario?.id === id) set({ history });
        } catch {
          // The timeline is secondary; editing keeps working without it.
        }
      },

      approve(revision) {
        const id = get().scenario?.id;
        if (!id) return;
        const reviewed = { ...get().reviewed, [id]: [...(get().reviewed[id] ?? []), revision] };
        saveReviewed(reviewed);
        set({ reviewed });
      },

      markAllReviewed() {
        const id = get().scenario?.id;
        if (!id) return;
        const revisions = pendingReview(get()).map((e) => e.revision);
        const reviewed = { ...get().reviewed, [id]: [...(get().reviewed[id] ?? []), ...revisions] };
        saveReviewed(reviewed);
        set({ reviewed });
      },

      async approveAll() {
        const scenario = get().scenario;
        if (!scenario) return;
        get().markAllReviewed();
        try {
          await api.submitReview(scenario.id, { revision: scenario.revision ?? 0, verdict: "approved" });
          set({ notice: t.approved });
        } catch (e) {
          // Marked here anyway; Core refuses only when the scenario moved on (REVISION_CONFLICT).
          set({ error: message(e) });
        }
        await get().loadTimeline(scenario.id);
      },

      async sendBack(reason, steps) {
        const scenario = get().scenario;
        if (!scenario) return false;
        try {
          await api.submitReview(scenario.id, {
            revision: scenario.revision ?? 0,
            verdict: "rejected",
            reason: reason.trim(),
            steps: steps.filter((n) => n.note.trim()).map((n) => ({ ...n, note: n.note.trim() })),
          });
          set({ notice: t.sentBack });
          await get().loadTimeline(scenario.id);
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
        set({ reviewing: on, place: on ? "review" : "scenarios", secretsOpen: false });
      },

      setPaletteOpen(open) {
        // Steps are added to the open scenario: show it.
        set(open ? { paletteOpen: open, dive: [] } : { paletteOpen: open });
      },

      async loadVersions() {
        const id = get().scenario?.id;
        if (!id) return;
        try {
          const versions = await api.listVersions(id);
          if (get().scenario?.id === id) set({ versions });
        } catch {
          // Versions are secondary; editing keeps working without them.
        }
      },

      async createVersion(name, note) {
        const scenario = get().scenario;
        if (!scenario) return false;
        try {
          await api.createVersion(scenario.id, scenario.revision ?? 0, { name, note });
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

      async exportScenario() {
        const id = get().scenario?.id;
        if (!id) return;
        try {
          const path = await api.exportScenario(id);
          set({ notice: `${t.exported}: ${path}`, error: null });
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async importFile(contents, onConflict) {
        try {
          const outcome = await api.importScenario(contents, onConflict);
          applyOutcome(outcome);
          set({ pendingImport: null, selection: null, history: [], versions: [], notice: `${t.imported}: ${outcome.scenario.name}` });
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
