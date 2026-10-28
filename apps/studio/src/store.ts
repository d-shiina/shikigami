// Studio state. All mutations go through the backend API as EditOps; the
// store only mirrors what Core returns (scenario, validation, undo state).
import type {
  EditOp,
  EditOutcome,
  HistoryEntry,
  LogLevel,
  RunEventEnvelope,
  RunStatus,
  Scenario,
  ScenarioSummary,
  Step,
  StepPatch,
  StepTypeDef,
  ValidationReport,
  VariableDef,
} from "@shikigami/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import { type Api, ApiError, type SecretInfo, type SecretInput } from "./lib/api";
import { t } from "./lib/i18n";

export type Selection =
  | { kind: "step"; stepId: string }
  | { kind: "slot"; parentId: string | null; block: string | null }
  | null;

export type StepRunState = "running" | "succeeded" | "failed" | "skipped";

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
  status: RunStatus;
  steps: Record<string, StepRunState>;
  logs: LogEntry[];
  changes: VariableChange[];
};

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
  paletteOpen: boolean;
  /** Registered secrets (names, user names, sites; never values). */
  secrets: SecretInfo[];
  secretKeyLocation: string;
  /** Secrets are listed by name only: their key is not on this PC / user. */
  secretKeyMissing: boolean;
  secretsOpen: boolean;
  /** A running step waits for the person at the PC (manual login, MFA). */
  human: { stepId: string; message: string } | null;

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
  addStep(type: string): Promise<void>;
  moveSelected(delta: -1 | 1): Promise<void>;
  removeSelected(): Promise<void>;
  updateStep(stepId: string, patch: StepPatch): Promise<void>;
  setVariable(variable: VariableDef): Promise<void>;
  removeVariable(name: string): Promise<void>;
  onExternalChange(scenarioId: string): Promise<void>;
  startRun(): Promise<void>;
  stopRun(): Promise<void>;
  onRunEvent(event: RunEventEnvelope): void;
  clearLog(): void;
  dismiss(): void;
  loadHistory(): Promise<void>;
  approve(revision: number): void;
  approveAll(): void;
  /** Reverts one journal entry by sending its inverse ops to Core as a new edit. */
  revert(entry: HistoryEntry): Promise<void>;
  setPaletteOpen(open: boolean): void;
  loadSecrets(): Promise<void>;
  /** Returns true when saved. */
  saveSecret(input: SecretInput): Promise<boolean>;
  removeSecret(name: string): Promise<void>;
  resetSecrets(): Promise<void>;
  setSecretsOpen(open: boolean): void;
};

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
export function pendingReview(state: Pick<StudioState, "history" | "reviewed" | "scenario">): HistoryEntry[] {
  const seen = new Set(state.reviewed[state.scenario?.id ?? ""] ?? []);
  return state.history.filter((e) => isExternal(e) && isRevertible(e) && !seen.has(e.revision)).reverse();
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
  "control.fail": { message: "エラー" },
  "variable.set": { name: "value", value: "" },
  "log.message": { message: "" },
  "flow.delay": { ms: 1000 },
  "wait.until": { condition: "true" },
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
      await get().loadHistory();
    };

    /** Runs a mutation; on a revision conflict reloads and tells the user. */
    const mutate = async (fn: (id: string, revision: number) => Promise<EditOutcome>): Promise<boolean> => {
      const scenario = get().scenario;
      if (!scenario) return false;
      try {
        applyOutcome(await fn(scenario.id, scenario.revision ?? 0));
        void get().refreshList();
        void get().loadHistory();
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
      paletteOpen: false,
      secrets: [],
      secretKeyLocation: "",
      secretKeyMissing: false,
      secretsOpen: false,
      human: null,

      async init() {
        try {
          const [stepTypes, summaries] = await Promise.all([api.listStepTypes(), api.listScenarios()]);
          set({ stepTypes, summaries });
        } catch (e) {
          set({ error: message(e) });
        }
        await get().loadSecrets();
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
          set({ notice: t.secretSaved(input.name), error: null });
          return true;
        } catch (e) {
          set({ error: message(e) });
          return false;
        }
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
        set({ secretsOpen: open });
        if (open) void get().loadSecrets();
      },

      async refreshList() {
        try {
          set({ summaries: await api.listScenarios() });
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async open(id) {
        try {
          const [scenario, validation, undo] = await Promise.all([api.getScenario(id), api.validate(id), api.undoState(id)]);
          set({ scenario, validation, canUndo: undo.canUndo, canRedo: undo.canRedo, selection: null, error: null, history: [] });
          await get().loadHistory();
        } catch (e) {
          set({ error: message(e) });
        }
      },

      async create(name) {
        try {
          const outcome = await api.createScenario({ name });
          applyOutcome(outcome);
          set({ selection: null, history: [] });
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
          set({ history: [] });
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
          set({ error: message(e) });
        }
      },

      applyOps: (ops) => mutate((id, rev) => api.edit(id, rev, ops)),
      undo: async () => void (await mutate((id, rev) => api.undo(id, rev))),
      redo: async () => void (await mutate((id, rev) => api.redo(id, rev))),

      select(selection) {
        set({ selection });
      },

      async addStep(type) {
        const { scenario, selection } = get();
        if (!scenario) return;
        let position: { parentId?: string | null; block?: string | null; index?: number | null } = {};
        if (selection?.kind === "slot") {
          position = { parentId: selection.parentId, block: selection.block };
        } else if (selection?.kind === "step") {
          const loc = locate(scenario.steps ?? [], selection.stepId);
          if (loc) position = { parentId: loc.parentId, block: loc.block, index: loc.index + 1 };
        }
        const step: Step = { id: newStepId(), type, params: { ...(DEFAULT_PARAMS[type] ?? {}) } };
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

      async onExternalChange(scenarioId) {
        await get().refreshList();
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

      async startRun() {
        const scenario = get().scenario;
        if (!scenario) return;
        try {
          const runId = await api.run(scenario.id);
          set((s) => ({
            // Events may have arrived before the command returned.
            run: s.run?.runId === runId ? s.run : { runId, status: "running", steps: {}, logs: [], changes: [] },
            error: null,
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

      onRunEvent(env) {
        set((s) => {
          let human = s.human;
          const run: RunState =
            s.run && s.run.runId === env.runId
              ? { ...s.run, steps: { ...s.run.steps }, logs: s.run.logs }
              : { runId: env.runId, status: "running", steps: {}, logs: [], changes: [] };
          const push = (level: LogLevel, msg: string, stepId?: string | null) => {
            run.logs = [...run.logs, { seq: env.seq, at: env.at, level, message: msg, stepId }];
          };
          const change = asVariableChange(env);
          if (change) run.changes = [...run.changes, change];
          switch (env.type) {
            case "runStarted":
              run.status = "running";
              push("info", `▶ ${env.scenarioName} (rev ${env.revision})`);
              break;
            case "stepStarted":
              run.steps[env.stepId] = "running";
              break;
            case "humanActionRequired":
              human = { stepId: env.stepId, message: env.message };
              push("warn", `${t.waitingForYou}: ${env.message}`, env.stepId);
              break;
            case "stepFinished":
              if (human?.stepId === env.stepId) human = null;
              run.steps[env.stepId] = env.outcome;
              if (env.error) {
                push("error", `${env.error.code}: ${env.error.message}${env.willRetry ? "（リトライします）" : ""}`, env.stepId);
              }
              break;
            case "log":
              push(env.level, env.message, env.stepId);
              break;
            case "runFinished":
              human = null;
              run.status = env.status;
              push(env.status === "succeeded" ? "info" : "error", `■ ${t.status[env.status]} (${env.durationMs} ms)`);
              break;
          }
          return { run, human };
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
          const history = await api.history(id);
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

      approveAll() {
        const id = get().scenario?.id;
        if (!id) return;
        const revisions = pendingReview(get()).map((e) => e.revision);
        const reviewed = { ...get().reviewed, [id]: [...(get().reviewed[id] ?? []), ...revisions] };
        saveReviewed(reviewed);
        set({ reviewed });
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

      setPaletteOpen(open) {
        set({ paletteOpen: open });
      },
    };
  });
}
