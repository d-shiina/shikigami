import type { EditOp, EditOutcome, HistoryEntry, RunEventEnvelope, Scenario } from "@shikigami/schema";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "./lib/api";
import { t } from "./lib/i18n";
import { createStudioStore, locate, pendingReview, revertBlocker, touchedSteps } from "./store";

const scenario = (revision: number, steps: Scenario["steps"] = []): Scenario => ({
  schemaVersion: 1,
  id: "scn_a",
  name: "A",
  revision,
  steps,
  metadata: {},
});

const outcome = (s: Scenario): EditOutcome => ({
  scenario: s,
  validation: { valid: true, issues: [] },
  canUndo: true,
  canRedo: false,
});

function fakeApi(overrides: Partial<Api> = {}): Api {
  const base: Partial<Api> = {
    listScenarios: vi.fn(async () => []),
    listStepTypes: vi.fn(async () => []),
    getScenario: vi.fn(async () => scenario(1)),
    validate: vi.fn(async () => ({ valid: true, issues: [] })),
    undoState: vi.fn(async () => ({ canUndo: false, canRedo: false })),
    history: vi.fn(async () => []),
  };
  return { ...base, ...overrides } as Api;
}

describe("studio store", () => {
  it("sends edits with the current revision and mirrors Core's result", async () => {
    const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) =>
      outcome(scenario(2, [{ id: "stp_new", type: "log.message" }])),
    );
    const store = createStudioStore(fakeApi({ edit }));
    await store.getState().open("scn_a");
    await store.getState().addStep("log.message");

    expect(edit).toHaveBeenCalledOnce();
    const [, revision, ops] = edit.mock.calls[0]!;
    expect(revision).toBe(1);
    expect(ops[0]).toMatchObject({ op: "addStep", step: { type: "log.message", params: { message: "" } } });
    expect(store.getState().scenario?.revision).toBe(2);
    expect(store.getState().canUndo).toBe(true);
    // the new step becomes the selection, so the next add goes after it
    const added = ops[0] as Extract<EditOp, { op: "addStep" }>;
    expect(store.getState().selection).toEqual({ kind: "step", stepId: added.step.id });
  });

  it("reloads and informs the user on revision conflicts (e.g. an AI edited meanwhile)", async () => {
    let current = scenario(1);
    const api = fakeApi({
      getScenario: vi.fn(async () => current),
      edit: vi.fn(async () => {
        throw new ApiError({ code: "REVISION_CONFLICT", message: "conflict" });
      }),
    });
    const store = createStudioStore(api);
    await store.getState().open("scn_a");
    current = scenario(5, [{ id: "stp_ai", type: "log.message" }]);
    const ok = await store.getState().applyOps([{ op: "removeStep", stepId: "x" }]);

    expect(ok).toBe(false);
    expect(store.getState().scenario?.revision).toBe(5);
    expect(store.getState().notice).toBe(t.reloadedByConflict);
    expect(store.getState().error).toBeNull();
  });

  it("picks up external changes to the open scenario", async () => {
    let current = scenario(1);
    const store = createStudioStore(fakeApi({ getScenario: vi.fn(async () => current) }));
    await store.getState().open("scn_a");
    current = scenario(2, [{ id: "stp_mcp", type: "log.message" }]);
    await store.getState().onExternalChange("scn_a");
    expect(store.getState().scenario?.steps?.[0]?.id).toBe("stp_mcp");
    expect(store.getState().notice).toBe(t.externalChange);
  });

  it("tracks run progress from events", () => {
    const store = createStudioStore(fakeApi());
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    const events: RunEventEnvelope[] = [
      { ...base, seq: 0, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 },
      { ...base, seq: 1, type: "stepStarted", stepId: "s1", stepType: "log.message", attempt: 1 },
      { ...base, seq: 2, type: "log", level: "info", message: "hello", stepId: "s1" },
      { ...base, seq: 3, type: "stepFinished", stepId: "s1", stepType: "log.message", outcome: "succeeded", durationMs: 1 },
      { ...base, seq: 4, type: "runFinished", status: "succeeded", durationMs: 2 },
    ];
    for (const e of events) store.getState().onRunEvent(e);
    const run = store.getState().run!;
    expect(run.status).toBe("succeeded");
    expect(run.steps.s1).toBe("succeeded");
    expect(run.logs.map((l) => l.message)).toContain("hello");
  });

  it("records variable changes the Runtime reports", () => {
    const store = createStudioStore(fakeApi());
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 });
    const changes = [
      { ...base, seq: 1, type: "variableChanged", variable: "total", value: 0 },
      { ...base, seq: 2, type: "variableChanged", variable: "total", value: 12000, stepId: "s_add" },
      { ...base, seq: 3, type: "variableChanged", variable: "password", value: "***", stepId: "s_get", secret: true },
    ];
    // Typed loosely: the schema package gains this event with the Runtime change.
    for (const e of changes) store.getState().onRunEvent(e as unknown as RunEventEnvelope);
    expect(store.getState().run!.changes.map((c) => [c.variable, c.value, c.stepId, c.secret])).toEqual([
      ["total", 0, null, false],
      ["total", 12000, "s_add", false],
      ["password", "***", "s_get", true],
    ]);
  });

  it("locates nested steps for move operations", () => {
    const steps = [
      { id: "a", type: "log.message" },
      { id: "if", type: "control.if", blocks: { then: [{ id: "b", type: "log.message" }] } },
    ];
    expect(locate(steps, "b")).toEqual({ parentId: "if", block: "then", index: 0, siblings: 1 });
    expect(locate(steps, "if")).toEqual({ parentId: null, block: null, index: 1, siblings: 2 });
    expect(locate(steps, "zzz")).toBeNull();
  });

  describe("review of external edits", () => {
    const aiEdit: HistoryEntry = {
      kind: "edit",
      revision: 2,
      actor: { kind: "mcp", name: "Claude" },
      at: "2026-10-28T00:00:00Z",
      label: "update step stp_a",
      ops: [{ op: "updateStep", stepId: "stp_a", patch: { params: { message: "new" } } }],
      inverse: [{ op: "updateStep", stepId: "stp_a", patch: { params: { message: "old" } } }],
    };
    const ownEdit: HistoryEntry = { ...aiEdit, revision: 3, actor: { kind: "studio" } };

    it("lists only unreviewed non-Studio edits", async () => {
      const store = createStudioStore(fakeApi({ history: vi.fn(async () => [aiEdit, ownEdit]) }));
      await store.getState().open("scn_a");
      expect(pendingReview(store.getState()).map((e) => e.revision)).toEqual([2]);
      expect(touchedSteps(aiEdit)).toEqual(["stp_a"]);
      store.getState().approve(2);
      expect(pendingReview(store.getState())).toEqual([]);
    });

    it("reverts by sending Core's recorded inverse ops as a new edit", async () => {
      const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(scenario(4)));
      const store = createStudioStore(fakeApi({ edit, history: vi.fn(async () => [aiEdit]) }));
      await store.getState().open("scn_a");
      await store.getState().revert(aiEdit);
      expect(edit).toHaveBeenCalledWith("scn_a", 1, aiEdit.inverse);
      expect(pendingReview(store.getState())).toEqual([]);
      expect(store.getState().notice).toBe(t.reverted);
    });

    it("refuses to revert when a later edit touched the same step", async () => {
      const edit = vi.fn(async () => outcome(scenario(4)));
      const store = createStudioStore(fakeApi({ edit, history: vi.fn(async () => [aiEdit, ownEdit]) }));
      await store.getState().open("scn_a");
      expect(revertBlocker(aiEdit, [aiEdit, ownEdit])).toBe(t.revertBlocked);
      await store.getState().revert(aiEdit);
      expect(edit).not.toHaveBeenCalled();
      expect(store.getState().error).toBe(t.revertBlocked);
    });
  });
});
