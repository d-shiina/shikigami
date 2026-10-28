import type { EditOp, EditOutcome, Evidence, HistoryEntry, ReviewTimeline, RunEventEnvelope, Scenario } from "@shikigami/schema";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "./lib/api";
import { t } from "./lib/i18n";
import { draftFor } from "./components/SecretsDialog";
import { createStudioStore, locate, pendingReview, revertBlocker, secretFixOf, touchedSteps } from "./store";

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
    listSecrets: vi.fn(async () => ({ secrets: [], keyLocation: "test", keyMissing: false })),
    listSecretRequests: vi.fn(async () => []),
    dismissSecretRequest: vi.fn(async () => true),
  };
  return { ...base, ...overrides } as Api;
}

describe("studio store", () => {
  it("moves the selection through the steps and asks the view to follow", async () => {
    const steps = [
      { id: "s1", type: "log.message" },
      { id: "s2", type: "log.message" },
      { id: "s3", type: "log.message" },
    ];
    const history: HistoryEntry[] = [
      { kind: "edit", revision: 2, actor: { kind: "mcp", name: "AI" }, at: "2026-10-28T00:00:00Z", label: "update", ops: [{ op: "updateStep", stepId: "s3", patch: { name: "x" } }], inverse: [{ op: "updateStep", stepId: "s3", patch: { name: "" } }] },
    ];
    const store = createStudioStore(fakeApi({ getScenario: vi.fn(async () => scenario(2, steps)), history: vi.fn(async () => history) }));
    await store.getState().open("scn_a");
    store.getState().stepBy(1);
    expect(store.getState().selection).toEqual({ kind: "step", stepId: "s1" });
    store.getState().stepBy(1);
    expect(store.getState().reveal).toEqual({ stepId: "s2", seq: 2 });
    store.getState().stepBy(Infinity);
    expect(store.getState().selection).toEqual({ kind: "step", stepId: "s3" });
    store.getState().select({ kind: "step", stepId: "s1" });
    store.getState().changeBy(1);
    expect(store.getState().selection).toEqual({ kind: "step", stepId: "s3" });
    store.getState().changeBy(1);
    expect(store.getState().selection).toEqual({ kind: "step", stepId: "s3" });
  });

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

  it("shows that a run waits for the person until the step ends", () => {
    const store = createStudioStore(fakeApi());
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "humanActionRequired", stepId: "s1", message: "スマホで承認してください" });
    expect(store.getState().human).toEqual({ stepId: "s1", message: "スマホで承認してください" });
    store.getState().onRunEvent({
      ...base,
      seq: 1,
      type: "stepFinished",
      stepId: "s1",
      stepType: "browser.waitForHuman",
      outcome: "succeeded",
      durationMs: 1,
    });
    expect(store.getState().human).toBeNull();
  });

  it("registers secrets without keeping their values", async () => {
    const listed = { name: "受注", username: "tanaka", sites: ["https://x.example"], fields: ["username", "password"], updatedAt: "" };
    const setSecret = vi.fn(async () => listed as never);
    const store = createStudioStore(
      fakeApi({ setSecret, listSecrets: vi.fn(async () => ({ secrets: [listed as never], keyLocation: "test", keyMissing: false })) }),
    );
    const ok = await store.getState().saveSecret({ name: "受注", username: "tanaka", password: "hunter2", sites: ["https://x.example"] });
    expect(ok).toBe(true);
    expect(setSecret).toHaveBeenCalledOnce();
    expect(JSON.stringify(store.getState())).not.toContain("hunter2");
    expect(store.getState().secrets.map((s) => s.name)).toEqual(["受注"]);
  });

  it("shows an AI's login request until the user registers or dismisses it", async () => {
    const request = {
      name: "Google",
      sites: ["https://accounts.google.com"],
      fields: ["username", "password"] as const,
      reason: "Google にログインするため",
      requestedAt: "",
      missing: { registered: false, fields: ["username", "password"] as const, sites: ["https://accounts.google.com"] },
    };
    let pending: unknown[] = [request];
    const listSecretRequests = vi.fn(async () => pending as never);
    const dismissSecretRequest = vi.fn(async () => {
      pending = [];
      return true;
    });
    const store = createStudioStore(fakeApi({ listSecretRequests, dismissSecretRequest }));
    await store.getState().init();
    expect(store.getState().secretRequests.map((r) => r.name)).toEqual(["Google"]);

    store.getState().openSecretForm({ name: "Google", sites: request.sites, fields: [...request.fields] });
    expect(store.getState().secretsOpen).toBe(true);
    await vi.waitFor(() => expect(store.getState().secretPrefill?.name).toBe("Google"));

    await store.getState().dismissSecretRequest("Google");
    expect(dismissSecretRequest).toHaveBeenCalledWith("Google");
    expect(store.getState().secretRequests).toEqual([]);
  });

  it("offers to register the secret a run stopped on", () => {
    const store = createStudioStore(fakeApi());
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 });
    store.getState().onRunEvent({
      ...base,
      seq: 1,
      type: "stepFinished",
      stepId: "s1",
      stepType: "browser.fill",
      outcome: "failed",
      durationMs: 1,
      error: { code: "SECRET_NOT_FOUND", message: "no secret named 'Google'", details: { secret: "Google", hint: "…" } },
    });
    expect(store.getState().secretFix).toEqual({ name: "Google", code: "SECRET_NOT_FOUND", site: undefined });
    store.getState().onRunEvent({ ...base, seq: 2, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 });
    expect(store.getState().secretFix).toBeNull();

    expect(
      secretFixOf({ code: "SECRET_SITE_MISMATCH", details: { secret: "G", page: "https://evil.example" } }),
    ).toEqual({ name: "G", code: "SECRET_SITE_MISMATCH", site: "https://evil.example" });
    expect(secretFixOf({ code: "ELEMENT_NOT_FOUND", details: { secret: "G" } })).toBeNull();
    expect(secretFixOf({ code: "SECRET_NOT_FOUND" })).toBeNull();
  });

  it("fills the secret form from a request, flagging sites added to a saved secret", () => {
    const saved = { name: "Google", username: "me", sites: ["https://accounts.google.com"], fields: ["username", "password"] as never, updatedAt: "" };
    const fresh = draftFor([], { name: "社内", sites: ["https://intra.example"] });
    expect(fresh.isNew).toBe(true);
    expect(fresh.draft).toMatchObject({ name: "社内", sites: "https://intra.example", password: "" });

    const more = draftFor([saved], { name: "Google", sites: ["https://accounts.google.com", "https://mail.google.com"] });
    expect(more.isNew).toBe(false);
    expect(more.added).toEqual(["https://mail.google.com"]);
    expect(more.draft.sites).toBe("https://accounts.google.com\nhttps://mail.google.com");
  });

  it("offers a reset when the secrets' key is not on this PC", async () => {
    let missing = true;
    const resetSecrets = vi.fn(async () => {
      missing = false;
      return 1;
    });
    const listSecrets = vi.fn(async () => ({ secrets: [], keyLocation: "test", keyMissing: missing }));
    const store = createStudioStore(fakeApi({ listSecrets, resetSecrets }));
    await store.getState().loadSecrets();
    expect(store.getState().secretKeyMissing).toBe(true);
    await store.getState().resetSecrets();
    expect(resetSecrets).toHaveBeenCalledOnce();
    expect(store.getState().secretKeyMissing).toBe(false);
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

  it("pauses on an error, keeps the evidence and resumes", async () => {
    const debugRun = vi.fn(async () => ({ revision: 2, updated: true }));
    const store = createStudioStore(fakeApi({ debugRun }));
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 });
    store.getState().onRunEvent({
      ...base,
      seq: 3,
      type: "paused",
      stepId: "s2",
      stepType: "browser.click",
      reason: "error",
      error: { code: "ELEMENT_NOT_FOUND", message: "no button", stepId: "s2" },
      variables: { n: 41 },
      revision: 1,
    });
    let run = store.getState().run!;
    expect(run.status).toBe("paused");
    expect(run.steps.s2).toBe("failed");
    expect(run.pause).toMatchObject({ stepId: "s2", reason: "error", variables: { n: 41 } });
    expect(store.getState().reveal?.stepId).toBe("s2");
    // Evidence for an older pause is dropped.
    store.getState().onRunEvidence({ runId: "run_1", seq: 1, stepId: "s2", problem: "x" });
    expect(store.getState().run!.evidence).toBeNull();
    store.getState().onRunEvidence({ runId: "run_1", seq: 3, stepId: "s2", problem: "no page" });
    expect(store.getState().run!.evidence?.problem).toBe("no page");

    expect(await store.getState().debug({ action: "retry" })).toBe(true);
    expect(debugRun).toHaveBeenCalledWith("run_1", { action: "retry" });
    expect(store.getState().notice).toContain("リビジョン 2");
    store.getState().onRunEvent({ ...base, seq: 4, type: "resumed", action: "retry", revision: 2 });
    run = store.getState().run!;
    expect(run.status).toBe("running");
    expect(run.pause).toBeNull();
    expect(run.evidence).toBeNull();
    store.getState().onRunEvent({ ...base, seq: 5, type: "runFinished", status: "failed", error: { code: "X", message: "gave up" }, durationMs: 3 });
    expect(store.getState().run!.failure?.message).toBe("gave up");
    store.getState().dismissFailure();
    expect(store.getState().run!.failure).toBeNull();
  });

  it("does not resume onto AI edits nobody has reviewed", async () => {
    const debugRun = vi.fn(async () => ({ revision: 2, updated: true }));
    const history: HistoryEntry[] = [
      { kind: "edit", revision: 2, actor: { kind: "mcp", name: "AI" }, at: "2026-10-28T00:00:00Z", label: "update", ops: [{ op: "updateStep", stepId: "s1", patch: { name: "x" } }], inverse: [{ op: "updateStep", stepId: "s1", patch: { name: "" } }] },
    ];
    const store = createStudioStore(fakeApi({ debugRun, getScenario: vi.fn(async () => scenario(2)), history: vi.fn(async () => history) }));
    await store.getState().open("scn_a");
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 });
    store.getState().onRunEvent({ ...base, seq: 1, type: "paused", stepId: "s1", stepType: "log.message", reason: "error", variables: {}, revision: 1 });
    expect(await store.getState().debug({ action: "retry" })).toBe(false);
    expect(debugRun).not.toHaveBeenCalled();
    // Ending the run needs no review.
    expect(await store.getState().debug({ action: "abort" })).toBe(true);
  });

  it("explains a resume that the fix made impossible", async () => {
    const debugRun = vi.fn(async () => {
      throw new ApiError({ code: "RESUME_INCOMPATIBLE", message: "moved" });
    });
    const store = createStudioStore(fakeApi({ debugRun }));
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", scenarioId: "scn_a", scenarioName: "A", revision: 1 });
    store.getState().onRunEvent({ ...base, seq: 1, type: "paused", stepId: "s1", stepType: "log.message", reason: "step", variables: {}, revision: 1 });
    expect(store.getState().run!.steps.s1).toBe("paused");
    expect(await store.getState().debug({ action: "continue" })).toBe(false);
    expect(store.getState().error).toContain("最初から");
  });

  it("keeps breakpoints per scenario and passes them to runs", async () => {
    const run = vi.fn(async () => "run_1");
    const debugRun = vi.fn(async () => ({ revision: 1, updated: false }));
    const store = createStudioStore(fakeApi({ run, debugRun }));
    await store.getState().open("scn_a");
    store.getState().toggleBreakpoint("s1");
    store.getState().toggleBreakpoint("s2");
    store.getState().toggleBreakpoint("s1");
    expect(store.getState().breakpoints).toEqual({ scn_a: ["s2"] });
    await store.getState().startRun({ step: true });
    expect(run).toHaveBeenCalledWith("scn_a", undefined, { breakpoints: ["s2"], step: true });
    // A running run of this scenario picks up changes at once.
    store.getState().toggleBreakpoint("s3");
    expect(debugRun).toHaveBeenCalledWith("run_1", { action: "setBreakpoints", stepIds: ["s2", "s3"] });
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

    it("treats edits up to Core's last approval as reviewed", async () => {
      const timeline = {
        scenarioId: "scn_a",
        revision: 2,
        sinceRevision: 2,
        lastApproval: { revision: 2, at: aiEdit.at, actor: { kind: "studio" }, kind: "review", verdict: "approved" },
        changes: [],
        evidence: [],
      } as ReviewTimeline;
      const store = createStudioStore(
        fakeApi({ history: vi.fn(async () => [aiEdit]), reviewTimeline: vi.fn(async () => timeline) }),
      );
      await store.getState().open("scn_a");
      expect(pendingReview(store.getState())).toEqual([]);
    });

    it("records approval and sending back in Core for the current revision", async () => {
      const submitReview = vi.fn(async () => ({}) as Evidence);
      const store = createStudioStore(fakeApi({ history: vi.fn(async () => [aiEdit]), submitReview }));
      await store.getState().open("scn_a");
      expect(await store.getState().sendBack("  表の名前が違う ", [{ stepId: "stp_a", note: " 受注一覧 " }, { stepId: "stp_b", note: " " }])).toBe(true);
      expect(submitReview).toHaveBeenLastCalledWith("scn_a", {
        revision: 1,
        verdict: "rejected",
        reason: "表の名前が違う",
        steps: [{ stepId: "stp_a", note: "受注一覧" }],
      });
      expect(pendingReview(store.getState()).map((e) => e.revision)).toEqual([2]);
      await store.getState().approveAll();
      expect(submitReview).toHaveBeenLastCalledWith("scn_a", { revision: 1, verdict: "approved" });
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

  describe("versions and sharing", () => {
    it("saves a version at the current revision and restores through Core", async () => {
      const createVersion = vi.fn(async () => ({
        number: 1,
        name: "v1",
        createdAt: "2026-10-28T00:00:00Z",
        createdBy: { kind: "studio" as const },
        revision: 1,
        stepCount: 0,
      }));
      const restoreVersion = vi.fn(async () => outcome(scenario(3)));
      const listVersions = vi.fn(async () => []);
      const store = createStudioStore(fakeApi({ createVersion, restoreVersion, listVersions }));
      await store.getState().open("scn_a");
      expect(await store.getState().createVersion("v1", "")).toBe(true);
      expect(createVersion).toHaveBeenCalledWith("scn_a", 1, { name: "v1", note: "" });
      await store.getState().restoreVersion(1);
      expect(restoreVersion).toHaveBeenCalledWith("scn_a", 1, 1);
      expect(store.getState().scenario?.revision).toBe(3);
      expect(store.getState().notice).toBe(t.restored);
    });

    it("keeps a conflicting import until the user chooses update or copy", async () => {
      const importScenario = vi.fn(async (_contents: string, onConflict?: string) => {
        if (!onConflict) {
          throw new ApiError({ code: "IMPORT_CONFLICT", message: "exists", details: { name: "A" } });
        }
        return { ...outcome(scenario(2)), mode: "updated" as const, versionsAdded: 1 };
      });
      const store = createStudioStore(fakeApi({ importScenario, listVersions: vi.fn(async () => []) }));
      await store.getState().importFile("{}");
      expect(store.getState().pendingImport).toEqual({ contents: "{}", name: "A" });
      expect(store.getState().error).toBeNull();
      await store.getState().importFile("{}", "update");
      expect(importScenario).toHaveBeenLastCalledWith("{}", "update");
      expect(store.getState().pendingImport).toBeNull();
      expect(store.getState().scenario?.revision).toBe(2);
    });
  });
});
