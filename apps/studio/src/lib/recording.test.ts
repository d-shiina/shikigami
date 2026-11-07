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

  it("send keys for a place without a name to its window", () => {
    const place = { window: win, point: { x: 3, y: 4 } };
    const { steps } = recordedSteps(
      [
        { kind: "setValue", target: place, value: "abc" },
        { kind: "press", target: place, key: "Enter" },
      ],
      counter(),
    );
    expect(steps.map((s) => [s.type, s.params])).toEqual([
      ["desktop.mouseClick", { target: place }],
      ["desktop.type", { target: { window: win }, text: "abc" }],
      ["desktop.press", { target: { window: win }, key: "Enter" }],
    ]);
  });

  it("name a target used twice as a part, and keep the order", () => {
    const { steps } = recordedSteps(actions, counter());
    const ops = recordingOps(steps, {}, { parentId: null, block: null, index: 2 });
    const parts = ops.filter((o) => o.op === "setPart");
    expect(parts.map((o) => o.op === "setPart" && [o.name, o.part.label])).toEqual([
      ["件名", "件名"],
      ["btnSave", "btnSave"],
    ]);
    const adds = ops.filter((o) => o.op === "addStep");
    expect(adds.map((o) => o.op === "addStep" && o.position?.index)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(adds[1]?.op === "addStep" && adds[1].step.params?.target).toEqual({ part: "btnSave" });
    // Used once: stays in the node.
    expect(adds[3]?.op === "addStep" && adds[3].step.params?.target).toEqual({ window: win, point: { x: 3, y: 4 } });
  });

  it("reuse a part the flow already has", () => {
    const { steps } = recordedSteps([actions[1]!], counter());
    const ops = recordingOps(steps, { saveButton: { app: "desktop", target: save } }, {});
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op === "addStep" && ops[0].step.params?.target).toEqual({ part: "saveButton" });
    expect(ops[0]?.op === "addStep" && ops[0].position).toEqual({});
  });

  it("are handed to the AI with what to do", () => {
    setLocale("en");
    const text = tidyRequest({ status: "stopped", actions: actions.slice(0, 2) }, "Quotes", "logs/recordings/a.json", "Where: at the end of the flow");
    expect(text).toContain('"Quotes"');
    expect(text).toContain("logs/recordings/a.json");
    expect(text).toContain("desktop.waitFor");
    expect(text).toContain('1. {"kind":"setValue"');
    setLocale("ja");
  });

  it("turn browser actions into browser nodes, sharing a target used twice", () => {
    setLocale("ja");
    const name = { role: "textbox", name: "氏名", exact: true };
    const search = { role: "button", name: "検索", exact: true };
    const browser: RecordedAction[] = [
      { app: "browser", kind: "open", url: "https://example.jp/" },
      { app: "browser", kind: "fill", target: name, value: "山田" },
      { app: "browser", kind: "fill", target: { label: "パスワード", exact: true }, value: "", password: true },
      { app: "browser", kind: "select", target: { role: "combobox", name: "都道府県", exact: true }, value: "東京" },
      { app: "browser", kind: "check", target: { role: "checkbox", name: "同意する", exact: true }, checked: true },
      { app: "browser", kind: "press", target: name, key: "Enter" },
      { app: "browser", kind: "click", target: search, button: "right" },
      { app: "browser", kind: "upload", target: { label: "添付" } },
      { app: "browser", kind: "click", failed: { message: "gone" } },
    ];
    const { steps, skipped } = recordedSteps(browser, counter());
    expect(steps.map((s) => [s.type, s.params])).toEqual([
      ["browser.open", { url: "https://example.jp/" }],
      ["browser.fill", { target: name, value: "山田" }],
      ["browser.fill", { target: { label: "パスワード", exact: true }, value: "" }],
      ["browser.select", { target: { role: "combobox", name: "都道府県", exact: true }, value: "東京" }],
      ["browser.check", { target: { role: "checkbox", name: "同意する", exact: true }, checked: true }],
      ["browser.press", { target: name, key: "Enter" }],
      ["browser.click", { target: search, button: "right" }],
    ]);
    expect(steps[2]?.name).toContain("シークレット");
    expect(skipped).toEqual([
      { index: 7, reason: "upload" },
      { index: 8, reason: "failed" },
    ]);
    // After a 「ページを開く」, the page is not opened again.
    expect(recordedSteps(browser.slice(0, 2), counter(), { pageOpen: true }).steps.map((s) => s.type)).toEqual(["browser.fill"]);
    const ops = recordingOps(steps, {}, { parentId: null, block: null, index: 0 });
    expect(ops[0]).toEqual({ op: "setPart", name: "氏名", part: { app: "browser", target: name, label: "氏名" } });
    expect(ops.filter((o) => o.op === "addStep")).toHaveLength(7);
  });

  it("ask the AI with the browser's rules for a browser recording", () => {
    setLocale("ja");
    const text = tidyRequest({ status: "stopped", actions: [{ app: "browser", kind: "open", url: "https://example.jp/" }] }, "受注", null, "最後");
    expect(text).toContain("ブラウザ");
    expect(text).toContain("browser.waitFor");
  });
});
