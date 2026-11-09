import { describe, expect, it } from "vitest";
import type { Part, Step } from "@spellsheet/schema";
import { alignOps, droppedDate, othersOnApp, pickedWindow, sameWindow, windowChips } from "./windowFinder";

const picked = pickedWindow({
  app: "Excel",
  window: { title: "請求書_2026年11月.xlsx - Excel", process: "EXCEL.EXE" },
  windowChoices: [
    { kind: "any", window: { process: "EXCEL.EXE" }, finds: 2 },
    { kind: "steady", title: "請求書", window: { process: "EXCEL.EXE", title: "請求書", match: "contains" }, finds: 1 },
    { kind: "contains", title: "請求書_2026年11月.xlsx - Excel", window: { process: "EXCEL.EXE", title: "請求書_2026年11月.xlsx - Excel", match: "contains" }, finds: 1 },
    { kind: "exact", title: "請求書_2026年11月.xlsx - Excel", window: { process: "EXCEL.EXE", title: "請求書_2026年11月.xlsx - Excel", match: "exact" }, finds: 1 },
  ],
});

describe("windowFinder", () => {
  it("treats the old exact: true and the default contains as the same ways", () => {
    expect(sameWindow({ process: "a.exe", title: "x", exact: true }, { process: "a.exe", title: "x", match: "exact" })).toBe(true);
    expect(sameWindow({ process: "a.exe", title: "x" }, { process: "a.exe", title: "x", match: "contains" })).toBe(true);
    expect(sameWindow({ process: "a.exe" }, { process: "a.exe", title: "x" })).toBe(false);
  });

  it("offers the picker's ways and marks the one in use", () => {
    const chips = windowChips({ process: "EXCEL.EXE", title: "請求書", match: "contains" }, picked);
    expect(chips.map((c) => [c.choice.kind, c.on])).toEqual([
      ["any", false],
      ["steady", true],
      ["contains", false],
      ["exact", false],
    ]);
    expect(droppedDate({ process: "EXCEL.EXE", title: "請求書", match: "contains" }, picked)).toBe("請求書");
  });

  it("without a pick, offers any window and the way in use", () => {
    const chips = windowChips({ process: "billing.exe", title: "請求", match: "prefix" }, undefined);
    expect(chips.map((c) => [c.choice.kind, c.on])).toEqual([
      ["any", false],
      ["contains", true],
    ]);
    // Another app's pick is not offered.
    expect(windowChips({ process: "billing.exe" }, picked).map((c) => c.choice.window)).toEqual([{ process: "billing.exe" }]);
  });

  it("finds the other nodes and parts on the same app and aligns them", () => {
    const steps: Step[] = [
      { id: "a", type: "desktop.click", params: { target: { window: { process: "EXCEL.EXE", title: "請求書_2026年11月.xlsx - Excel" }, element: { name: "保存" } } } },
      { id: "b", type: "desktop.setValue", params: { target: { window: { process: "excel.exe", title: "請求書_2026年11月.xlsx - Excel" }, element: { id: "C5" } }, value: "1" } },
      { id: "c", type: "desktop.click", params: { target: { window: { process: "EXCEL.EXE", title: "請求書", match: "contains" } } } },
      { id: "d", type: "desktop.click", params: { target: { window: { process: "notepad.exe" } } } },
    ] as Step[];
    const parts: Record<string, Part> = {
      save: { app: "desktop", target: { window: { process: "EXCEL.EXE" }, element: { name: "保存" } } } as Part,
    };
    const window = { process: "EXCEL.EXE", title: "請求書", match: "contains" };
    const others = othersOnApp(steps, parts, steps[0]!, window);
    expect(others.map((o) => o.step?.id ?? o.part)).toEqual(["b", "save"]);
    const ops = alignOps(others, parts, window);
    expect(ops[0]).toEqual({
      op: "updateStep",
      stepId: "b",
      patch: { replaceParams: { target: { window, element: { id: "C5" } }, value: "1" } },
    });
    expect(ops[1]).toMatchObject({ op: "setPart", name: "save", part: { target: { window, element: { name: "保存" } } } });
  });
});
