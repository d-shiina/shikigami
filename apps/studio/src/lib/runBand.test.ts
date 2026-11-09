import type { RunEventEnvelope, RunReport, Step, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { bandEnded, bandItems, bandStep, type BandState, emptyBand, focusStep } from "./runBand";

const steps: Step[] = [
  { id: "open", type: "excel.open", params: {} },
  {
    id: "rows",
    type: "control.forEach",
    params: {},
    blocks: {
      body: [
        { id: "type", type: "desktop.type", params: {} },
        { id: "click", type: "desktop.click", params: {} },
      ],
    },
  },
  {
    id: "check",
    type: "control.if",
    params: {},
    blocks: { then: [{ id: "mail", type: "mail.send", params: {} }], else: [{ id: "log", type: "flow.log", params: {} }] },
  },
] as Step[];

const defs = new Map<string, StepTypeDef>([
  ["control.forEach", { type: "control.forEach", blocks: [{ name: "body" }] } as unknown as StepTypeDef],
  ["control.if", { type: "control.if", blocks: [{ name: "then" }, { name: "else" }] } as unknown as StepTypeDef],
]);

let seq = 0;
const ev = (event: Record<string, unknown>, callPath: string[] = []): RunEventEnvelope =>
  ({ runId: "run_1", seq: seq++, at: "2026-11-09T05:00:00Z", callPath, ...event }) as unknown as RunEventEnvelope;

function play(events: RunEventEnvelope[]): BandState {
  return events.reduce((s, e) => bandStep(s, e, steps), emptyBand());
}

const started = (id: string, type = "desktop.click") => ev({ type: "stepStarted", stepId: id, stepType: type, attempt: 1 });
const finished = (id: string, outcome = "succeeded") =>
  ev({ type: "stepFinished", stepId: id, stepType: "x", outcome, durationMs: 10 });

describe("the run band", () => {
  it("checks the nodes passed and lights the one running", () => {
    const state = play([started("open"), finished("open"), started("rows"), ev({ type: "loopRound", stepId: "rows", round: 3, total: 12 }), started("type")]);
    const items = bandItems(steps, state, defs);
    expect(items[0]).toMatchObject({ kind: "node", state: "done" });
    expect(items[1]).toMatchObject({ kind: "frame", state: "now", round: { round: 3, total: 12 } });
    const body = items[1]?.kind === "frame" ? items[1].items : [];
    expect(body.map((i) => i.state)).toEqual(["now", "ahead"]);
    expect(focusStep(state)).toBe("type");
  });

  it("starts a loop's body over each round", () => {
    const state = play([
      started("rows"),
      ev({ type: "loopRound", stepId: "rows", round: 1, total: 2 }),
      started("type"),
      finished("type"),
      started("click"),
      finished("click"),
      ev({ type: "loopRound", stepId: "rows", round: 2, total: 2 }),
    ]);
    const frame = bandItems(steps, state, defs)[1];
    expect(frame?.kind === "frame" && frame.items.map((i) => i.state)).toEqual(["ahead", "ahead"]);
  });

  it("shows a branch only once the run took it", () => {
    expect(bandItems(steps, emptyBand(), defs)[2]).toMatchObject({ kind: "node", state: "ahead" });
    const state = play([started("check", "control.if"), started("log", "flow.log")]);
    const frame = bandItems(steps, state, defs)[2];
    expect(frame).toMatchObject({ kind: "frame", block: "else" });
    expect(frame?.kind === "frame" && frame.items.map((i) => i.step.id)).toEqual(["log"]);
  });

  it("forgets the branch taken when a loop starts its next round", () => {
    const looped: Step[] = [
      {
        id: "rows",
        type: "control.forEach",
        params: {},
        blocks: { body: [{ id: "ok", type: "control.if", params: {}, blocks: { then: [{ id: "a", type: "flow.log", params: {} }], else: [] } }] },
      },
    ] as Step[];
    const run = (events: RunEventEnvelope[]) => events.reduce((s, e) => bandStep(s, e, looped), emptyBand());
    const state = run([
      started("rows", "control.forEach"),
      ev({ type: "loopRound", stepId: "rows", round: 1, total: 2 }),
      started("ok", "control.if"),
      started("a", "flow.log"),
      finished("a"),
      finished("ok"),
      ev({ type: "loopRound", stepId: "rows", round: 2, total: 2 }),
      started("ok", "control.if"),
      finished("ok"),
    ]);
    const frame = bandItems(looped, state, defs)[0];
    expect(frame?.kind === "frame" && frame.items[0]).toMatchObject({ kind: "node", state: "done" });
  });

  it("counts a called flow's nodes for its call node only", () => {
    const state = play([started("open", "flow.call"), ev({ type: "stepStarted", stepId: "inner", stepType: "desktop.click", attempt: 1 }, ["open"])]);
    expect(state.running).toEqual(["open"]);
  });

  it("shows what a person is asked to do until the step goes on", () => {
    let state = play([started("type"), ev({ type: "humanActionRequired", stepId: "type", message: "スマートフォンで承認してください" })]);
    expect(state.human).toBe("スマートフォンで承認してください");
    state = bandStep(state, finished("type"), steps);
    expect(state.human).toBeNull();
  });

  it("ends the wait when the step asked about finishes, inside a loop or a call", () => {
    let state = play([started("rows", "control.forEach"), started("type"), ev({ type: "humanActionRequired", stepId: "type", message: "承認してください" })]);
    state = bandStep(state, finished("type"), steps);
    expect(state.human).toBeNull();
    expect(state.running).toEqual(["rows"]);
    state = play([
      started("open", "flow.call"),
      ev({ type: "humanActionRequired", stepId: "login", message: "ログインしてください" }, ["open"]),
    ]);
    expect(state.human).toBe("ログインしてください");
    state = bandStep(state, ev({ type: "stepFinished", stepId: "other", stepType: "x", outcome: "succeeded", durationMs: 1 }, ["open"]), steps);
    expect(state.human).toBe("ログインしてください");
    state = bandStep(state, ev({ type: "stepFinished", stepId: "login", stepType: "x", outcome: "succeeded", durationMs: 1 }, ["open"]), steps);
    expect(state.human).toBeNull();
  });

  it("shows a node that failed and then went through on a retry as passed", () => {
    const state = play([started("open"), finished("open", "failed"), started("open"), finished("open")]);
    expect(bandItems(steps, state, defs)[0]).toMatchObject({ kind: "node", state: "done" });
  });

  it("does not count an event twice when the replay and the live ones overlap", () => {
    const once = started("open");
    const state = bandStep(bandStep(emptyBand(), once, steps), finished("open"), steps);
    expect(bandStep(state, once, steps)).toBe(state);
  });

  it("takes the end from the report when the replay was cut short", () => {
    const state = bandEnded(play([started("open")]), {
      status: "failed",
      startedAt: "2026-11-09T05:00:00Z",
      finishedAt: "2026-11-09T05:10:00Z",
    } as unknown as RunReport);
    expect(state).toMatchObject({ status: "failed", running: [] });
    expect(state.finishedAt).toBe(Date.parse("2026-11-09T05:10:00Z"));
  });

  it("keeps the result when the run ends", () => {
    const state = play([started("open"), ev({ type: "runFinished", status: "succeeded", durationMs: 5 })]);
    expect(state.status).toBe("succeeded");
    expect(state.running).toEqual([]);
    expect(state.finishedAt).not.toBeNull();
  });
});
