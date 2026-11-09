import type {
  ApprovalRequest,
  EditOp,
  EditOutcome,
  Evidence,
  HistoryEntry,
  PublishedState,
  ReviewTimeline,
  RunEventEnvelope,
  Flow,
} from "@shikigami/schema";
import { describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "./lib/api";
import { t } from "./lib/i18n";
import { draftFor } from "./components/SecretsPage";
import { calledIds, createStudioStore, errorPlace, extractChoices, diveChain, locate, pendingReview, revertBlocker, secretFixOf, touchedSteps, trailOf } from "./store";

const flow = (revision: number, steps: Flow["steps"] = []): Flow => ({
  schemaVersion: 1,
  id: "scn_a",
  name: "A",
  revision,
  steps,
  metadata: {},
});

const outcome = (s: Flow): EditOutcome => ({
  flow: s,
  validation: { valid: true, issues: [] },
  canUndo: true,
  canRedo: false,
});

function fakeApi(overrides: Partial<Api> = {}): Api {
  const base: Partial<Api> = {
    listFlows: vi.fn(async () => []),
    listStepTypes: vi.fn(async () => []),
    getFlow: vi.fn(async () => flow(1)),
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
  it("keeps the right pane for a picked node, or for the flow's settings only while kept open", () => {
    const store = createStudioStore(fakeApi({}));
    expect(store.getState().inspectorOpen).toBe(false);
    store.getState().select({ kind: "step", stepId: "a" });
    store.getState().setInspectorOpen(false);
    // Closing the pane puts the node down too, or it would stay open for it.
    expect(store.getState().selection).toBeNull();
    store.getState().select({ kind: "step", stepId: "a" });
    store.getState().showFlowProps();
    expect(store.getState().selection).toBeNull();
    expect(store.getState().inspectorOpen).toBe(true);
  });

  it("moves the selection through the steps and asks the view to follow", async () => {
    const steps = [
      { id: "s1", type: "log.message" },
      { id: "s2", type: "log.message" },
      { id: "s3", type: "log.message" },
    ];
    const history: HistoryEntry[] = [
      { kind: "edit", revision: 2, actor: { kind: "mcp", name: "AI" }, at: "2026-10-28T00:00:00Z", label: "update", ops: [{ op: "updateStep", stepId: "s3", patch: { name: "x" } }], inverse: [{ op: "updateStep", stepId: "s3", patch: { name: "" } }] },
    ];
    const store = createStudioStore(fakeApi({ getFlow: vi.fn(async () => flow(2, steps)), history: vi.fn(async () => history) }));
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
      outcome(flow(2, [{ id: "stp_new", type: "log.message" }])),
    );
    const store = createStudioStore(fakeApi({ edit }));
    await store.getState().open("scn_a");
    await store.getState().addStep("log.message");

    expect(edit).toHaveBeenCalledOnce();
    const [, revision, ops] = edit.mock.calls[0]!;
    expect(revision).toBe(1);
    expect(ops[0]).toMatchObject({ op: "addStep", step: { type: "log.message", params: { message: "" } } });
    expect(store.getState().flow?.revision).toBe(2);
    expect(store.getState().canUndo).toBe(true);
    // the new step becomes the selection, so the next add goes after it
    const added = ops[0] as Extract<EditOp, { op: "addStep" }>;
    expect(store.getState().selection).toEqual({ kind: "step", stepId: added.step.id });
  });

  it("starts a switch with a case, and turns a node added among its cases into a case", async () => {
    const sw = { id: "sw", type: "control.switch", params: { value: "kind" }, blocks: { cases: [] } };
    const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(flow(2, [sw])));
    const store = createStudioStore(fakeApi({ edit, getFlow: vi.fn(async () => flow(1, [sw])) }));
    await store.getState().open("scn_a");

    store.getState().select(null);
    await store.getState().addStep("control.switch");
    const first = edit.mock.calls[0]![2][0] as Extract<EditOp, { op: "addStep" }>;
    expect(first.step).toMatchObject({ type: "control.switch", blocks: { cases: [{ type: "control.case", params: { values: [""] } }] } });

    store.getState().select({ kind: "slot", parentId: "sw", block: "cases" });
    await store.getState().addStep("log.message");
    const second = edit.mock.calls[1]![2][0] as Extract<EditOp, { op: "addStep" }>;
    expect(second.position).toMatchObject({ parentId: "sw", block: "cases" });
    expect(second.step).toMatchObject({ type: "control.case", blocks: { body: [{ type: "log.message" }] } });
  });

  it("adds at the plus button the palette was opened from, even though the palette closes as it adds", async () => {
    const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(flow(2)));
    const store = createStudioStore(fakeApi({ edit }));
    await store.getState().open("scn_a");
    store.getState().setPaletteOpen(true, { parentId: null, block: null, index: 0 });
    // As the palette does: add, then close.
    const adding = store.getState().addStep("log.message");
    store.getState().setPaletteOpen(false);
    await adding;
    expect(edit.mock.calls[0]![2][0]).toMatchObject({ op: "addStep", position: { parentId: null, block: null, index: 0 } });
    expect(store.getState().paletteAt).toBeNull();
  });

  it("reloads and informs the user on revision conflicts (e.g. an AI edited meanwhile)", async () => {
    let current = flow(1);
    const api = fakeApi({
      getFlow: vi.fn(async () => current),
      edit: vi.fn(async () => {
        throw new ApiError({ code: "REVISION_CONFLICT", message: "conflict" });
      }),
    });
    const store = createStudioStore(api);
    await store.getState().open("scn_a");
    current = flow(5, [{ id: "stp_ai", type: "log.message" }]);
    const ok = await store.getState().applyOps([{ op: "removeStep", stepId: "x" }]);

    expect(ok).toBe(false);
    expect(store.getState().flow?.revision).toBe(5);
    expect(store.getState().notice).toBe(t.reloadedByConflict);
    expect(store.getState().error).toBeNull();
  });

  it("picks up external changes to the open flow", async () => {
    let current = flow(1);
    const store = createStudioStore(fakeApi({ getFlow: vi.fn(async () => current) }));
    await store.getState().open("scn_a");
    current = flow(2, [{ id: "stp_mcp", type: "log.message" }]);
    await store.getState().onExternalChange("scn_a");
    expect(store.getState().flow?.steps?.[0]?.id).toBe("stp_mcp");
    expect(store.getState().notice).toBe(t.externalChange);
  });

  it("opens the folded frames around a step it goes to, and only those", () => {
    const steps: Flow["steps"] = [
      { id: "g", type: "control.group", blocks: { body: [{ id: "l", type: "control.repeat", blocks: { body: [{ id: "x", type: "log.message" }] } }] } },
      { id: "h", type: "control.group", blocks: { body: [] } },
    ];
    const store = createStudioStore(fakeApi());
    store.setState({ flow: flow(1, steps) });
    for (const id of ["g", "l", "h"]) store.getState().toggleFold(id);
    store.getState().goTo("x");
    expect(store.getState().folded.scn_a).toEqual(["h"]);
    expect(store.getState().selection).toEqual({ kind: "step", stepId: "x" });
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

  it("keeps how far each loop got, in the open flow and in a called one", () => {
    const store = createStudioStore(fakeApi({}));
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    store.getState().onRunEvent({ ...base, seq: 1, type: "loopRound", stepId: "each", round: 3, total: 12 });
    expect(store.getState().run?.loops["|each"]).toEqual({ round: 3, total: 12, ended: false, leftEarly: false });
    store.getState().onRunEvent({ ...base, seq: 2, type: "loopEnded", stepId: "each", rounds: 7, total: 12, leftEarly: true });
    store.getState().onRunEvent({ ...base, seq: 3, callPath: ["call"], type: "loopRound", stepId: "w", round: 2 });
    expect(store.getState().run?.loops).toEqual({
      "|each": { round: 7, total: 12, ended: true, leftEarly: true },
      "call|w": { round: 2, total: null, ended: false, leftEarly: false },
    });
    // Started again (the next pass of a loop around it): the last pass's count does not carry over.
    store.getState().onRunEvent({ ...base, seq: 4, type: "stepStarted", stepId: "each", stepType: "control.forEach", attempt: 1 });
    expect(store.getState().run?.loops["|each"]).toBeUndefined();
  });

  it("shows a stop in progress and ends a run whose last event never came", async () => {
    const stopRun = vi.fn(async () => {});
    const store = createStudioStore(fakeApi({ stopRun }));
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    await store.getState().stopRun();
    expect(stopRun).toHaveBeenCalledWith("run_1");
    expect(store.getState().run?.stopping).toBe(true);
    store.getState().onRunEvent({ ...base, seq: 1, type: "runFinished", status: "cancelled", durationMs: 5 });
    expect(store.getState().run).toMatchObject({ status: "cancelled", stopping: false });

    const gone = createStudioStore(
      fakeApi({
        stopRun: vi.fn(async () => {
          throw new ApiError({ code: "RUN_NOT_FOUND", message: "no active run" });
        }),
      }),
    );
    gone.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    await gone.getState().stopRun();
    expect(gone.getState().run).toMatchObject({ status: "cancelled", stopping: false });
    expect(gone.getState().error).toBeNull();
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
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
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
    store.getState().onRunEvent({ ...base, seq: 2, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    expect(store.getState().secretFix).toBeNull();

    expect(
      secretFixOf({ code: "SECRET_SITE_MISMATCH", details: { secret: "G", page: "https://evil.example" } }),
    ).toEqual({ name: "G", code: "SECRET_SITE_MISMATCH", site: "https://evil.example" });
    expect(secretFixOf({ code: "ELEMENT_NOT_FOUND", details: { secret: "G" } })).toBeNull();
    expect(secretFixOf({ code: "SECRET_NOT_FOUND" })).toBeNull();
  });

  it("fills the secret form from a request, flagging sites added to a saved secret", () => {
    const saved = { name: "Google", kind: "login" as const, username: "me", sites: ["https://accounts.google.com"], fields: ["username", "password"] as never, updatedAt: "" };
    const fresh = draftFor([], { name: "社内", sites: ["https://intra.example"] });
    expect(fresh.isNew).toBe(true);
    expect(fresh.draft).toMatchObject({ name: "社内", kind: "login", sites: "https://intra.example", password: "" });
    const key = draftFor([], { name: "受注 API", sites: ["https://api.example.com"], kind: "apiKey" });
    expect(key.draft.kind).toBe("apiKey");

    const more = draftFor([saved], { name: "Google", sites: ["https://accounts.google.com", "https://mail.google.com"] });
    expect(more.isNew).toBe(false);
    expect(more.added).toEqual(["https://mail.google.com"]);
    expect(more.draft.sites).toBe("https://accounts.google.com\nhttps://mail.google.com");
  });

  it("adds requested sites to the sites a secret has now, not to a stale list", async () => {
    const setSecret = vi.fn(async () => ({}) as never);
    // The CLI added a site after Studio last listed the secret.
    const listSecrets = vi.fn(async () => ({
      secrets: [{ name: "G", username: "me", sites: ["https://a.example", "https://cli.example"], fields: ["username", "password"], updatedAt: "" }] as never,
      keyLocation: "test",
      keyMissing: false,
    }));
    const store = createStudioStore(fakeApi({ setSecret, listSecrets }));
    await store.getState().saveSecretAdding({ name: "G", totp: "JBSWY3DPEHPK3PXP" }, ["https://b.example", "https://a.example"]);
    expect(setSecret).toHaveBeenCalledWith({
      name: "G",
      totp: "JBSWY3DPEHPK3PXP",
      sites: ["https://a.example", "https://cli.example", "https://b.example"],
    });
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
      { ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 },
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

  it("keeps the run's way on the chart after it ends, until the flow is edited", () => {
    const store = createStudioStore(fakeApi());
    store.setState({ flow: flow(1, [{ id: "s1", type: "log.message" }]) });
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    const events: RunEventEnvelope[] = [
      { ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 },
      { ...base, seq: 1, type: "stepStarted", stepId: "s1", stepType: "log.message", attempt: 1 },
      { ...base, seq: 2, type: "stepFinished", stepId: "s1", stepType: "log.message", outcome: "succeeded", durationMs: 1 },
      { ...base, seq: 3, type: "runFinished", status: "succeeded", durationMs: 2 },
    ];
    for (const e of events) store.getState().onRunEvent(e);
    expect(trailOf(store.getState())?.steps.s1).toBe("succeeded");
    // Another flow open: its chart is not the run's.
    store.setState({ flow: { ...flow(1), id: "scn_b" } });
    expect(trailOf(store.getState())).toBeNull();
    // Edited since: the marks would point at steps that changed.
    store.setState({ flow: flow(2, [{ id: "s1", type: "log.message" }]) });
    expect(trailOf(store.getState())).toBeNull();
    // Cleared by the person.
    store.setState({ flow: flow(1, [{ id: "s1", type: "log.message" }]) });
    store.getState().hideTrail();
    expect(trailOf(store.getState())).toBeNull();
    // A new run starts afresh.
    store.getState().onRunEvent({ ...base, runId: "run_2", seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    expect(trailOf(store.getState())?.runId).toBe("run_2");
  });

  it("pauses on an error, keeps the evidence and resumes", async () => {
    const debugRun = vi.fn(async () => ({ revision: 2, updated: true }));
    const store = createStudioStore(fakeApi({ debugRun }));
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
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
    expect(store.getState().notice).toContain("2 回目の変更");
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

  it("「ここまで実行」 runs up to the node, steps over it and pauses after", async () => {
    const run = vi.fn(async () => "run_1");
    const debugRun = vi.fn(async () => ({ revision: 1, updated: false }));
    const store = createStudioStore(fakeApi({ run, debugRun, getFlow: vi.fn(async () => flow(1, [{ id: "s1", type: "log.message" }, { id: "s2", type: "log.message" }])) }));
    await store.getState().open("scn_a");
    store.getState().openEditor("s2");
    expect(store.getState().editing).toBe("s2");
    await store.getState().runTo("s2");
    expect(store.getState().trying).toBe("s2");
    // The node itself is a breakpoint, on top of the ones the person set.
    expect(run).toHaveBeenCalledWith("scn_a", undefined, { breakpoints: ["s2"], step: false });
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    store.getState().onRunEvent({ ...base, seq: 1, type: "paused", stepId: "s2", stepType: "log.message", reason: "breakpoint", variables: {}, revision: 1 });
    // The pause before the node is only a way to get there: it runs on and stops after.
    expect(debugRun).toHaveBeenCalledWith("run_1", { action: "stepOver" });
    expect(store.getState().trying).toBeNull();
    // A second try while it runs does nothing.
    await store.getState().runTo("s2");
    expect(run).toHaveBeenCalledTimes(1);
    // Closing the flow closes the editor.
    store.getState().closeEditor();
    expect(store.getState().editing).toBeNull();
  });

  it("「ノードの単体実行」 runs only the node, with the values given, and keeps the last run", async () => {
    const run = vi.fn(async () => "run_1");
    const result = { status: "succeeded", output: 42, logs: [{ level: "info", message: "ok" }] };
    const testStep = vi.fn(async () => result);
    const store = createStudioStore(fakeApi({ run, testStep, getFlow: vi.fn(async () => flow(1, [{ id: "s1", type: "log.message" }, { id: "s2", type: "log.message" }])) } as never));
    await store.getState().open("scn_a");
    const pending = store.getState().testStep("s2", { price: 21 });
    expect(store.getState().stepTest).toMatchObject({ stepId: "s2", running: true });
    await pending;
    expect(testStep).toHaveBeenCalledWith("scn_a", "s2", { price: 21 });
    expect(run).not.toHaveBeenCalled();
    expect(store.getState().stepTest).toMatchObject({ stepId: "s2", running: false, result });
    expect(store.getState().run).toBeNull();
    // While it runs, 「中止」 stops it by its run id.
    let finish: (v: unknown) => void = () => {};
    const stopRun = vi.fn(async () => undefined);
    const slow = createStudioStore(fakeApi({ stopRun, testStep: vi.fn(() => new Promise((r) => (finish = r))), getFlow: vi.fn(async () => flow(1, [{ id: "s2", type: "log.message" }])) } as never));
    await slow.getState().open("scn_a");
    const running = slow.getState().testStep("s2", {});
    await slow.getState().stopStepTest();
    expect(stopRun).toHaveBeenCalledWith("studio-pick");
    finish({ status: "cancelled", output: null, logs: [] });
    await running;
    expect(slow.getState().stepTest).toMatchObject({ running: false });
  });

  it("does not resume onto AI edits nobody has reviewed", async () => {
    const debugRun = vi.fn(async () => ({ revision: 2, updated: true }));
    const history: HistoryEntry[] = [
      { kind: "edit", revision: 2, actor: { kind: "mcp", name: "AI" }, at: "2026-10-28T00:00:00Z", label: "update", ops: [{ op: "updateStep", stepId: "s1", patch: { name: "x" } }], inverse: [{ op: "updateStep", stepId: "s1", patch: { name: "" } }] },
    ];
    const store = createStudioStore(fakeApi({ debugRun, getFlow: vi.fn(async () => flow(2)), history: vi.fn(async () => history) }));
    await store.getState().open("scn_a");
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
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
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    store.getState().onRunEvent({ ...base, seq: 1, type: "paused", stepId: "s1", stepType: "log.message", reason: "step", variables: {}, revision: 1 });
    expect(store.getState().run!.steps.s1).toBe("paused");
    expect(await store.getState().debug({ action: "continue" })).toBe(false);
    expect(store.getState().error).toContain("最初から");
  });

  it("keeps breakpoints per flow and passes them to runs", async () => {
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
    // A running run of this flow picks up changes at once.
    store.getState().toggleBreakpoint("s3");
    expect(debugRun).toHaveBeenCalledWith("run_1", { action: "setBreakpoints", stepIds: ["s2", "s3"] });
  });

  it("asks for inputs with no default before it runs, and runs with the values entered", async () => {
    const run = vi.fn(async () => "run_1");
    const withInputs: Flow = {
      ...flow(1),
      variables: [
        { name: "company", type: "string", direction: "input" },
        { name: "dept", type: "string", direction: "input", default: "営業" },
      ],
    };
    const store = createStudioStore(fakeApi({ run, getFlow: vi.fn(async () => withInputs) }));
    await store.getState().open("scn_a");
    await store.getState().runTo("s1");
    expect(run).not.toHaveBeenCalled();
    expect(store.getState().askInputs).toEqual({ flowId: "scn_a", options: { stopAt: "s1" } });
    expect(store.getState().trying).toBe("s1");
    await store.getState().answerInputs({ company: "株式会社まるちゃ" });
    expect(run).toHaveBeenCalledWith("scn_a", { company: "株式会社まるちゃ" }, { breakpoints: ["s1"], step: false });
    expect(store.getState().askInputs).toBeNull();
    // 「ここから実行」 starts with the earlier run's values: nothing to ask.
    run.mockClear();
    await store.getState().startRun({ startAt: "s1", startValues: { company: "前回" } });
    expect(run).toHaveBeenCalledTimes(1);
    // Closing the ask runs nothing.
    await store.getState().startRun();
    store.getState().cancelInputs();
    expect(store.getState().askInputs).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shows steps inside a call apart from the caller's", () => {
    const store = createStudioStore(fakeApi());
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    const events = [
      { ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 },
      { ...base, seq: 1, type: "stepStarted", stepId: "c1", stepType: "flow.call", attempt: 1 },
      { ...base, seq: 2, type: "stepStarted", stepId: "t1", stepType: "variable.set", attempt: 1, callPath: ["c1"] },
      { ...base, seq: 3, type: "variableChanged", variable: "scratch", value: 2, stepId: "t1", callPath: ["c1"] },
      { ...base, seq: 4, type: "stepFinished", stepId: "t1", stepType: "variable.set", outcome: "succeeded", durationMs: 1, callPath: ["c1"] },
      { ...base, seq: 5, type: "stepStarted", stepId: "u1", stepType: "log.message", attempt: 1, callPath: ["c1", "t9"] },
    ] as unknown as RunEventEnvelope[];
    for (const e of events) store.getState().onRunEvent(e);
    const run = store.getState().run!;
    expect(run.steps).toEqual({ c1: "running" });
    expect(run.inner.c1).toEqual({ t1: "succeeded" });
    // A call inside the call keeps its own steps, for when the chart enters it.
    expect(run.inner["c1/t9"]).toEqual({ u1: "running" });
    // What an entered call follows: the step started last, not an enclosing loop still running.
    expect(run.innerLatest).toEqual({ c1: "t1", "c1/t9": "u1" });
    // The callee's variables are not the caller's.
    expect(run.changes.map((c) => c.variable)).not.toContain("scratch");
  });

  it("follows a run into called flows and back out", async () => {
    const flows: Record<string, Flow> = {
      scn_a: { ...flow(1, [{ id: "c1", type: "flow.call", params: { flow: "scn_b" } }, { id: "s2", type: "log.message" }]) },
      scn_b: { ...flow(1, [{ id: "c2", type: "flow.call", params: { flow: "scn_c" } }]), id: "scn_b", name: "B" },
      scn_c: { ...flow(1, [{ id: "x", type: "log.message" }]), id: "scn_c", name: "C" },
    };
    const getFlow = vi.fn(async (id: string) => flows[id]!);
    const store = createStudioStore(fakeApi({ getFlow, listVersions: vi.fn(async () => []) }));
    await store.getState().open("scn_a");
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z", stepType: "log.message", attempt: 1 };
    const start = (seq: number, stepId: string, callPath?: string[]) =>
      store.getState().onRunEvent({ ...base, seq, type: "stepStarted", stepId, ...(callPath ? { callPath } : {}) } as unknown as RunEventEnvelope);
    store.getState().onRunEvent({ runId: "run_1", at: base.at, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 } as unknown as RunEventEnvelope);
    start(1, "c1");
    expect(store.getState().dive).toEqual([]);
    start(2, "c2", ["c1"]);
    expect(store.getState().dive).toEqual(["c1"]);
    start(3, "x", ["c1", "c2"]);
    expect(store.getState().dive).toEqual(["c1", "c2"]);
    start(4, "s2");
    expect(store.getState().dive).toEqual([]);
    // Not followed, the chart stays where the person put it.
    store.getState().setFollowRun(false);
    start(5, "x", ["c1", "c2"]);
    expect(store.getState().dive).toEqual([]);
  });

  it("shows a pause inside a call there, and passes the called flows' breakpoints", async () => {
    const flows: Record<string, Flow> = {
      scn_a: { ...flow(1, [{ id: "c1", type: "flow.call", params: { flow: "scn_b" } }]) },
      scn_b: { ...flow(1, [{ id: "x", type: "log.message" }]), id: "scn_b", name: "B" },
    };
    const run = vi.fn(async () => "run_1");
    const getFlow = vi.fn(async (id: string) => flows[id]!);
    const store = createStudioStore(fakeApi({ run, getFlow, listVersions: vi.fn(async () => []) }));
    await store.getState().open("scn_a");
    store.getState().toggleBreakpoint("x", "scn_b");
    await store.getState().startRun();
    expect(run).toHaveBeenCalledWith("scn_a", undefined, { breakpoints: ["scn_b/x"], step: false });
    store.getState().setFollowRun(false);
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 1, type: "paused", stepId: "x", stepType: "log.message", reason: "breakpoint", variables: {}, revision: 1, callPath: ["c1"] } as unknown as RunEventEnvelope);
    const paused = store.getState().run!;
    expect(paused.status).toBe("paused");
    expect(paused.pause).toMatchObject({ stepId: "x", callPath: ["c1"] });
    expect(paused.inner.c1).toEqual({ x: "paused" });
    expect(paused.steps).toEqual({});
    expect(store.getState().dive).toEqual(["c1"]);
    store.getState().onRunEvent({ ...base, seq: 2, type: "resumed", action: "continue", callPath: ["c1"] } as unknown as RunEventEnvelope);
    expect(store.getState().run!.status).toBe("running");
    expect(store.getState().run!.inner.c1).toEqual({});
    // Paused back in the open flow, the chart comes back out.
    store.getState().onRunEvent({ ...base, seq: 3, type: "paused", stepId: "c1", stepType: "flow.call", reason: "error", variables: {}, revision: 1 } as unknown as RunEventEnvelope);
    expect(store.getState().dive).toEqual([]);
  });

  it("enters calls on the chart, nested ones too, and goes back up", async () => {
    const flows: Record<string, Flow> = {
      scn_a: { ...flow(1, [{ id: "c1", type: "flow.call", params: { flow: "scn_b" } }]) },
      scn_b: { ...flow(1, [{ id: "c2", type: "flow.call", params: { flow: "scn_c" } }]), id: "scn_b", name: "B" },
      scn_c: { ...flow(1, [{ id: "x", type: "log.message" }]), id: "scn_c", name: "C" },
    };
    const getFlow = vi.fn(async (id: string) => flows[id]!);
    const store = createStudioStore(fakeApi({ getFlow, listVersions: vi.fn(async () => []) }));
    await store.getState().open("scn_a");
    // Called flows are loaded however deep they are called.
    expect(Object.keys(store.getState().called).sort()).toEqual(["scn_b", "scn_c"]);
    store.getState().select({ kind: "step", stepId: "c1" });
    store.getState().enterCall("c1");
    expect(store.getState().dive).toEqual(["c1"]);
    expect(store.getState().selection).toBeNull();
    store.getState().enterCall("c2");
    expect(store.getState().dive).toEqual(["c1", "c2"]);
    expect(diveChain(store.getState().flow, store.getState().called, store.getState().dive).map((l) => l.flow.name)).toEqual(["B", "C"]);
    // Not a call of the shown level: nothing happens.
    store.getState().enterCall("x");
    expect(store.getState().dive).toEqual(["c1", "c2"]);
    store.getState().leaveCalls(1);
    expect(store.getState().dive).toEqual(["c1"]);
    // Picking a step of the open flow (outline, palette) comes back up.
    store.getState().goTo("c1");
    expect(store.getState().dive).toEqual([]);
  });

  it("leads a failure inside only when one route leads there", async () => {
    const flows: Record<string, Flow> = {
      scn_a: { ...flow(1, [{ id: "c1", type: "flow.call", params: { flow: "scn_b" } }]) },
      scn_b: { ...flow(1, [{ id: "c2", type: "flow.call", params: { flow: "scn_c" } }, { id: "c3", type: "flow.call", params: { flow: "scn_c" } }]), id: "scn_b", name: "B" },
      scn_c: { ...flow(1, [{ id: "x", type: "log.message" }]), id: "scn_c", name: "C" },
    };
    const store = createStudioStore(fakeApi({ getFlow: vi.fn(async (id: string) => flows[id]!), listVersions: vi.fn(async () => []) }));
    await store.getState().open("scn_a");
    const { flow: root, called } = store.getState();
    expect(errorPlace(root, called, "c1", { subFlow: { flowId: "scn_c", stepId: "x" } })).toEqual({ path: [], stepId: "c1" });
    expect(errorPlace(root, called, "c1", { subFlow: { flowId: "scn_c", stepId: "x", callPath: ["c3"] } })).toEqual({ path: ["c1", "c3"], stepId: "x" });
  });

  it("leads log lines and failures to the node, inside called flows too", async () => {
    const flows: Record<string, Flow> = {
      scn_a: { ...flow(1, [{ id: "c1", type: "flow.call", params: { flow: "scn_b" } }]) },
      scn_b: { ...flow(1, [{ id: "c2", type: "flow.call", params: { flow: "scn_c" } }]), id: "scn_b", name: "B" },
      scn_c: { ...flow(1, [{ id: "g", type: "control.group", blocks: { body: [{ id: "x", type: "log.message", name: "送信" }] } }]), id: "scn_c", name: "C" },
    };
    const store = createStudioStore(fakeApi({ getFlow: vi.fn(async (id: string) => flows[id]!), listVersions: vi.fn(async () => []) }));
    await store.getState().open("scn_a");
    const { flow: root, called } = store.getState();
    // details.subFlow names only the innermost flow: the calls to it are found.
    expect(errorPlace(root, called, "c1", { subFlow: { flowId: "scn_c", stepId: "x" } })).toEqual({ path: ["c1", "c2"], stepId: "x" });
    expect(errorPlace(root, called, "c1", { subFlow: { flowId: "scn_c", stepId: "gone" } })).toEqual({ path: [], stepId: "c1" });
    expect(errorPlace(root, called, "c1", undefined)).toEqual({ path: [], stepId: "c1" });
    // The calls the run reports are followed as they are.
    expect(errorPlace(root, called, "c1", { subFlow: { flowId: "scn_c", stepId: "x", callPath: ["c2"] } })).toEqual({ path: ["c1", "c2"], stepId: "x" });
    expect(errorPlace(root, called, "c1", { subFlow: { flowId: "scn_c", stepId: "x", callPath: ["nope"] } })).toEqual({ path: [], stepId: "c1" });

    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
    store.getState().onRunEvent({ ...base, seq: 1, type: "log", level: "info", message: "inside", stepId: "x", callPath: ["c1", "c2"] } as unknown as RunEventEnvelope);
    store.getState().onRunEvent({
      ...base,
      seq: 2,
      type: "stepFinished",
      stepId: "c1",
      stepType: "flow.call",
      outcome: "failed",
      durationMs: 1,
      error: { code: "X", message: "no button", stepId: "c1", details: { subFlow: { flowId: "scn_c", stepId: "x" } } },
    });
    const logs = store.getState().run!.logs;
    expect(logs.at(-2)).toMatchObject({ message: "inside", stepId: "x", callPath: ["c1", "c2"] });
    expect(logs.at(-1)).toMatchObject({ level: "error", message: "no button", stepId: "x", callPath: ["c1", "c2"] });

    store.getState().toggleFold("g", "scn_c");
    store.getState().goToPlace({ path: ["c1", "c2"], stepId: "x" });
    expect(store.getState().dive).toEqual(["c1", "c2"]);
    // The frame around it in the called flow opens.
    expect(store.getState().folded.scn_c).toBeUndefined();
    expect(store.getState().reveal).toMatchObject({ stepId: "x", inside: "c1/c2" });
    // A call the chart cannot open any more: the call step instead.
    store.getState().goToPlace({ path: ["nope"], stepId: "x" });
    expect(store.getState().dive).toEqual([]);
    expect(store.getState().selection).toEqual({ kind: "step", stepId: "nope" });
  });

  it("finds the flows a flow calls, nested ones included", () => {
    const steps: Flow["steps"] = [
      { id: "c1", type: "flow.call", params: { flow: "scn_b" } },
      { id: "i1", type: "control.if", params: { condition: "true" }, blocks: { then: [{ id: "c2", type: "flow.call", params: { flow: "scn_c" } }] } },
      { id: "c3", type: "flow.call", params: { flow: "scn_b" } },
      { id: "c4", type: "flow.call", params: { flow: "" } },
    ];
    expect([...calledIds(steps)].sort()).toEqual(["scn_b", "scn_c"]);
  });

  it("records variable changes the Runtime reports", () => {
    const store = createStudioStore(fakeApi());
    const base = { runId: "run_1", at: "2026-10-28T00:00:00Z" };
    store.getState().onRunEvent({ ...base, seq: 0, type: "runStarted", flowId: "scn_a", flowName: "A", revision: 1 });
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

    it("lists only unreviewed non-Writer edits", async () => {
      const store = createStudioStore(fakeApi({ history: vi.fn(async () => [aiEdit, ownEdit]) }));
      await store.getState().open("scn_a");
      expect(pendingReview(store.getState()).map((e) => e.revision)).toEqual([2]);
      expect(touchedSteps(aiEdit)).toEqual(["stp_a"]);
      store.getState().approve(2);
      expect(pendingReview(store.getState())).toEqual([]);
    });

    it("treats edits up to Core's last approval as reviewed", async () => {
      const timeline = {
        flowId: "scn_a",
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

    it("approves and publishes in one step, and keeps the review open when publishing fails", async () => {
      const published = {
        version: 3,
        name: "v3",
        revision: 1,
        publishedAt: aiEdit.at,
        publishedBy: { kind: "studio" },
        matchesCurrent: true,
      } as PublishedState;
      const approveAndPublish = vi
        .fn()
        .mockRejectedValueOnce(new ApiError({ code: "SUBFLOW_NOT_PUBLISHED", message: "x" }))
        .mockResolvedValueOnce(published);
      const store = createStudioStore(
        fakeApi({
          history: vi.fn(async () => [aiEdit]),
          approveAndPublish,
          listVersions: vi.fn(async () => []),
          publishedState: vi.fn(async () => null),
        }),
      );
      await store.getState().open("scn_a");
      await store.getState().approveAndPublish();
      expect(approveAndPublish).toHaveBeenLastCalledWith("scn_a", 1);
      expect(store.getState().error).toBe(t.publishError("SUBFLOW_NOT_PUBLISHED", "x"));
      expect(pendingReview(store.getState()).map((e) => e.revision)).toEqual([2]);
      await store.getState().approveAndPublish();
      expect(store.getState().notice).toBe(t.approvedPublished(3));
      expect(pendingReview(store.getState())).toEqual([]);
    });

    it("answers an AI's approval request and re-reads the list", async () => {
      const decideApproval = vi.fn(async () => ({}) as ApprovalRequest);
      const listApprovals = vi.fn(async () => [] as ApprovalRequest[]);
      const store = createStudioStore(fakeApi({ decideApproval, listApprovals }));
      await store.getState().decideApproval("apr_1", false);
      expect(decideApproval).toHaveBeenCalledWith("apr_1", false);
      expect(listApprovals).toHaveBeenCalled();
      expect(store.getState().notice).toBe(t.approvalDenied);
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
      const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(flow(4)));
      const store = createStudioStore(fakeApi({ edit, history: vi.fn(async () => [aiEdit]) }));
      await store.getState().open("scn_a");
      await store.getState().revert(aiEdit);
      expect(edit).toHaveBeenCalledWith("scn_a", 1, aiEdit.inverse);
      expect(pendingReview(store.getState())).toEqual([]);
      expect(store.getState().notice).toBe(t.reverted);
    });

    it("refuses to revert when a later edit touched the same step", async () => {
      const edit = vi.fn(async () => outcome(flow(4)));
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
      const restoreVersion = vi.fn(async () => outcome(flow(3)));
      const listVersions = vi.fn(async () => []);
      const store = createStudioStore(fakeApi({ createVersion, restoreVersion, listVersions }));
      await store.getState().open("scn_a");
      expect(await store.getState().createVersion("v1", "")).toBe(true);
      expect(createVersion).toHaveBeenCalledWith("scn_a", 1, { name: "v1", note: "" });
      await store.getState().restoreVersion(1);
      expect(restoreVersion).toHaveBeenCalledWith("scn_a", 1, 1);
      expect(store.getState().flow?.revision).toBe(3);
      expect(store.getState().notice).toBe(t.restored);
    });

    it("keeps a conflicting import until the user chooses update or copy", async () => {
      const importFlow = vi.fn(async (_contents: string, onConflict?: string) => {
        if (!onConflict) {
          throw new ApiError({ code: "IMPORT_CONFLICT", message: "exists", details: { name: "A" } });
        }
        return { ...outcome(flow(2)), mode: "updated" as const, versionsAdded: 1 };
      });
      const store = createStudioStore(fakeApi({ importFlow, listVersions: vi.fn(async () => []) }));
      await store.getState().importFile("{}");
      expect(store.getState().pendingImport).toEqual({ contents: "{}", name: "A" });
      expect(store.getState().error).toBeNull();
      await store.getState().importFile("{}", "update");
      expect(importFlow).toHaveBeenLastCalledWith("{}", "update");
      expect(store.getState().pendingImport).toBeNull();
      expect(store.getState().flow?.revision).toBe(2);
    });
  });
});

describe("copying nodes", () => {
  const steps = [
    { id: "s1", type: "log.message", params: { message: "1" } },
    { id: "s2", type: "log.message", params: { message: "2" } },
    { id: "s3", type: "log.message", params: { message: "3" } },
  ];

  function withClipboard() {
    let text = "";
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: vi.fn(async (v: string) => void (text = v)), readText: vi.fn(async () => text) } },
    });
    return { get: () => text, set: (v: string) => void (text = v) };
  }

  it("copies a Shift+click range and pastes it after the selection under new IDs", async () => {
    const clip = withClipboard();
    const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(flow(2, steps)));
    const store = createStudioStore(fakeApi({ edit, getFlow: vi.fn(async () => flow(1, steps)) }));
    await store.getState().open("scn_a");
    store.getState().select({ kind: "step", stepId: "s2" });
    store.getState().selectTo("s1");
    await store.getState().copySelected();
    expect(JSON.parse(clip.get()).steps.map((s: { id: string }) => s.id)).toEqual(["s1", "s2"]);

    store.getState().select({ kind: "step", stepId: "s3" });
    await store.getState().paste();
    const ops = edit.mock.calls[0]![2] as Extract<EditOp, { op: "addStep" }>[];
    expect(ops.map((o) => o.position)).toEqual([
      { parentId: null, block: null, index: 3 },
      { parentId: null, block: null, index: 4 },
    ]);
    expect(ops.map((o) => o.step.params)).toEqual([{ message: "1" }, { message: "2" }]);
    expect(ops.every((o) => o.step.id?.startsWith("stp_"))).toBe(true);
    expect(store.getState().range?.ids).toEqual(ops.map((o) => o.step.id));
  });

  it("removes every picked node at once, as one change", async () => {
    withClipboard();
    const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(flow(2, [steps[0]!])));
    const store = createStudioStore(fakeApi({ edit, getFlow: vi.fn(async () => flow(1, steps)) }));
    await store.getState().open("scn_a");
    store.getState().select({ kind: "step", stepId: "s2" });
    store.getState().selectTo("s3");
    await store.getState().copySelected(true);
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]![2]).toEqual([
      { op: "removeStep", stepId: "s2" },
      { op: "removeStep", stepId: "s3" },
    ]);
    expect(store.getState().selection).toBeNull();
  });

  it("says so when the clipboard holds no nodes", async () => {
    const clip = withClipboard();
    clip.set("ただの文字");
    const edit = vi.fn();
    const store = createStudioStore(fakeApi({ edit, getFlow: vi.fn(async () => flow(1, steps)) }));
    await store.getState().open("scn_a");
    await store.getState().paste();
    expect(edit).not.toHaveBeenCalled();
    expect(store.getState().notice).toBe(t.nothingToPaste);
  });

  it("duplicates right after the node", async () => {
    withClipboard();
    const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(flow(2, steps)));
    const store = createStudioStore(fakeApi({ edit, getFlow: vi.fn(async () => flow(1, steps)) }));
    await store.getState().open("scn_a");
    store.getState().select({ kind: "step", stepId: "s1" });
    await store.getState().duplicateSelected();
    const op = edit.mock.calls[0]![2][0] as Extract<EditOp, { op: "addStep" }>;
    expect(op.position).toEqual({ parentId: null, block: null, index: 1 });
    expect(op.step.params).toEqual({ message: "1" });
    expect(op.step.id).not.toBe("s1");
  });

  it("puts the picked nodes inside a new loop where they were, as one change", async () => {
    const edit = vi.fn(async (_id: string, _rev: number, _ops: EditOp[]) => outcome(flow(2, steps)));
    const store = createStudioStore(fakeApi({ edit, getFlow: vi.fn(async () => flow(1, steps)) }));
    await store.getState().open("scn_a");
    store.getState().select({ kind: "step", stepId: "s2" });
    store.getState().selectTo("s3");
    await store.getState().wrapSelected("control.repeat");
    expect(edit).toHaveBeenCalledOnce();
    const [add, ...moves] = edit.mock.calls[0]![2];
    const wrapper = (add as Extract<EditOp, { op: "addStep" }>).step;
    expect(add).toMatchObject({ op: "addStep", step: { type: "control.repeat" }, position: { parentId: null, block: null, index: 1 } });
    expect(moves).toEqual([
      { op: "moveStep", stepId: "s2", position: { parentId: wrapper.id, block: "body", index: 0 } },
      { op: "moveStep", stepId: "s3", position: { parentId: wrapper.id, block: "body", index: 1 } },
    ]);
    expect(store.getState().selection).toEqual({ kind: "step", stepId: wrapper.id });
  });

  it("extracts the Shift+click range as it is, and offers the nodes after a single one", async () => {
    const store = createStudioStore(fakeApi({ getFlow: vi.fn(async () => flow(1, steps)) }));
    await store.getState().open("scn_a");
    store.getState().select({ kind: "step", stepId: "s2" });
    const one = extractChoices(store.getState().flow!.steps ?? [], store.getState());
    expect(one && "from" in one && one.from.map((s) => s.id)).toEqual(steps.slice(1).map((s) => s.id));
    // Picking upwards still gives the nodes in flow order.
    store.getState().select({ kind: "step", stepId: "s3" });
    store.getState().setExtractOpen(true);
    store.getState().setExtractName("請求書の登録");
    store.getState().selectTo("s2");
    expect(store.getState().extractOpen).toBe(true);
    expect(store.getState().extractName).toBe("請求書の登録");
    const picked = extractChoices(store.getState().flow!.steps ?? [], store.getState());
    expect(picked && "picked" in picked && picked.picked.map((s) => s.id)).toEqual(["s2", "s3"]);
    // Picking another node closes the form.
    store.getState().select({ kind: "step", stepId: "s1" });
    expect(store.getState().extractOpen).toBe(false);
    expect(store.getState().extractName).toBe("");
  });
});
