import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { type RecordedAction, recordedSteps, recordingOps, tidyRequest } from "./recording";

const win = { process: "billing.exe" };
const save = { window: win, element: { id: "btnSave" } };
const subject = { window: win, element: { role: "textbox", name: "件名" } };

const actions: RecordedAction[] = [
  { kind: "setValue", target: subject, value: "見積もり" },
  { kind: "click", target: save, how: "id", button: "left", double: false },
  { kind: "drag", button: "left" },
  { kind: "press", target: subject, key: "Control+S" },
  { kind: "click", target: { window: win, point: { x: 3, y: 4 } }, how: "point", button: "left", double: false },
  { kind: "click", target: save, how: "id", button: "right", double: false },
  { kind: "setValue", target: { window: win, element: { id: "pw" } }, password: true },
  { kind: "click", failed: { code: "WINDOW_NOT_FOUND" }, button: "left" },
];

const counter = () => {
  let n = 0;
  return () => `s${++n}`;
};

describe("recordings", () => {
  it("become one node per action, skipping what cannot be a node", () => {
    setLocale("ja");
    const { steps, skipped } = recordedSteps(actions, counter());
    expect(steps.map((s) => s.type)).toEqual([
      "desktop.setValue",
      "desktop.click",
      "desktop.press",
      "desktop.mouseClick",
      "desktop.mouseClick",
      "desktop.setValue",
    ]);
    expect(steps[0]?.params).toEqual({ target: subject, value: "見積もり" });
    expect(steps[2]?.params).toEqual({ target: subject, key: "Control+S" });
    expect(steps[4]?.params).toEqual({ target: save, button: "right" });
    // A password is never recorded: the node asks for a secret.
    expect(steps[5]?.params?.value).toBe("");
    expect(steps[5]?.name).toContain("シークレット");
    expect(skipped).toEqual([
      { index: 2, reason: "drag" },
      { index: 7, reason: "failed" },
    ]);
  });

  it("name a target used twice as a part, and keep the order", () => {
    const { steps } = recordedSteps(actions, counter());
    const ops = recordingOps(steps, {}, { parentId: null, block: null, index: 2 });
    const parts = ops.filter((o) => o.op === "setPart");
    expect(parts.map((o) => o.op === "setPart" && [o.name, o.part.label])).toEqual([
      ["part1", "件名"],
      ["btnSave", "btnSave"],
    ]);
    const adds = ops.filter((o) => o.op === "addStep");
    expect(adds.map((o) => o.op === "addStep" && o.position?.index)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(adds[1]?.op === "addStep" && adds[1].step.params?.target).toEqual({ part: "btnSave" });
    // Used once: stays in the node.
    expect(adds[3]?.op === "addStep" && adds[3].step.params?.target).toEqual({ window: win, point: { x: 3, y: 4 } });
  });

  it("reuse a part the scenario already has", () => {
    const { steps } = recordedSteps([actions[1]!], counter());
    const ops = recordingOps(steps, { saveButton: { app: "desktop", target: save } }, {});
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op === "addStep" && ops[0].step.params?.target).toEqual({ part: "saveButton" });
    expect(ops[0]?.op === "addStep" && ops[0].position).toEqual({});
  });

  it("are handed to the AI with what to do", () => {
    setLocale("en");
    const text = tidyRequest({ status: "stopped", actions: actions.slice(0, 2) }, "Quotes", "logs/recordings/a.json", "Where: at the end of the scenario");
    expect(text).toContain('"Quotes"');
    expect(text).toContain("logs/recordings/a.json");
    expect(text).toContain("desktop.waitFor");
    expect(text).toContain('1. {"kind":"setValue"');
    setLocale("ja");
  });
});
