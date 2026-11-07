import type { Step } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { makePartOps, newPartName, partRef, partUses } from "./parts";
import { setPartLookup, targetText } from "./sentence";

const save = { window: { process: "billing.exe" }, element: { id: "btnSave" } };
const steps = [
  { id: "a", type: "desktop.click", params: { target: save } },
  { id: "loop", type: "control.forEach", blocks: { body: [{ id: "b", type: "desktop.click", params: { target: { element: { id: "btnSave" }, window: { process: "billing.exe" } } } }] } },
  { id: "c", type: "desktop.click", params: { target: { window: { process: "other.exe" } } } },
  { id: "d", type: "browser.click", params: { target: save } },
] as Step[];

describe("parts", () => {
  it("reads only a bare reference as a part", () => {
    expect(partRef({ part: "save" })).toBe("save");
    expect(partRef({ part: "save", nth: 1 })).toBeUndefined();
    expect(partRef("save")).toBeUndefined();
  });

  it("names a new part from an ASCII id, else part1, part2…", () => {
    expect(newPartName(save, [])).toBe("btnSave");
    expect(newPartName(save, ["btnSave"])).toBe("btnSave1");
    expect(newPartName({ role: "button", name: "保存" }, ["part1"])).toBe("保存");
    expect(newPartName({ label: "お客様 番号（必須）" }, ["お客様番号必須"])).toBe("お客様番号必須1");
    expect(newPartName({ role: "button", name: "…" }, ["part1"])).toBe("part2");
    expect(newPartName({ label: "User name" }, [])).toBe("userName");
  });

  it("makes a part and points every node of the app with the same target at it, in one batch", () => {
    const made = makePartOps(steps, steps[0]!, "btnSave", "保存ボタン")!;
    expect(made.others).toBe(1);
    expect(made.ops[0]).toEqual({ op: "setPart", name: "btnSave", part: { app: "desktop", target: save, label: "保存ボタン" } });
    expect(made.ops.slice(1).map((op) => (op.op === "updateStep" ? op.stepId : ""))).toEqual(["a", "b"]);
    // The whole params are replaced, so no old target field survives a merge.
    expect(made.ops[1]).toMatchObject({ patch: { replaceParams: { target: { part: "btnSave" } } } });
  });

  it("finds the nodes that use a part and says the part's name in sentences", () => {
    const using = [{ id: "x", type: "desktop.click", params: { target: { part: "btnSave" } } }] as Step[];
    expect(partUses(using, "btnSave").map((s) => s.id)).toEqual(["x"]);
    setPartLookup((name) => (name === "btnSave" ? { label: "保存ボタン" } : undefined));
    setLocale("ja", false);
    expect(targetText({ part: "btnSave" })).toBe("部品「保存ボタン」");
    expect(targetText({ part: "gone" })).toBe("部品「gone」");
    setPartLookup(() => undefined);
  });
});
