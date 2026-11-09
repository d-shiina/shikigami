import type { Flow, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { placeChange, placeKind, placeName, portable } from "./filePlaces";

const types = [
  { type: "excel.readRows", pathParams: ["path"] },
  { type: "file.writeCsv", pathParams: ["path"] },
  { type: "pdf.merge", pathParams: ["files", "to"] },
  { type: "config.read", pathParams: ["path"] },
] as StepTypeDef[];

const flow = (steps: Flow["steps"], extra: Partial<Flow> = {}) => ({ id: "scn_a", name: "a", steps, ...extra }) as Flow;

describe("placeName", () => {
  it("names the setting after the file, usable as settings.<name>", () => {
    expect(placeName("input/受注.xlsx", "の場所")).toBe("受注の場所");
    expect(placeName("input/2026 受注-一覧.xlsx", "の場所")).toBe("_2026_受注_一覧の場所");
  });
});

describe("portable", () => {
  it("keeps a folder in the user's profile as %USERPROFILE%", () => {
    expect(portable("C:\\Users\\taro\\Box\\経理\\", "C:\\Users\\Taro")).toBe("%USERPROFILE%\\Box\\経理");
    expect(portable("\\\\fs01\\経理", "C:\\Users\\taro")).toBe("\\\\fs01\\経理");
    expect(portable("C:\\Users\\taro2\\x", "C:\\Users\\taro")).toBe("C:\\Users\\taro2\\x");
  });
});

describe("placeKind", () => {
  it("tells file servers and synced folders from local drives", () => {
    expect(placeKind("\\\\fs01\\経理\\a.xlsx")).toBe("fileServer");
    expect(placeKind("C:\\Users\\taro\\OneDrive - 例\\a.xlsx")).toBe("cloud");
    expect(placeKind("D:\\work\\a.xlsx")).toBe("local");
  });
});

describe("placeChange", () => {
  it("adds the folder setting, a node reading it, and points the readers of that one file there", () => {
    const change = placeChange({
      flow: flow([
        { id: "a", type: "excel.readRows", params: { path: "input/受注.xlsx" } },
        { id: "b", type: "excel.readRows", params: { path: "input/別.xlsx" } },
        { id: "c", type: "pdf.merge", params: { files: ["input\\受注.xlsx", "x.pdf"], to: "output/a.pdf" } },
      ]),
      types,
      prefix: "input",
      file: "input/受注.xlsx",
      folder: "%USERPROFILE%\\Box\\経理",
      settings: null,
      name: "受注の場所",
      description: "受注.xlsx を読むフォルダー",
    });
    expect(change?.steps).toBe(2);
    expect(change?.configPath).toBe("config/settings.json");
    expect(JSON.parse(change!.configText).items).toEqual([
      { name: "受注の場所", type: "folder", value: "%USERPROFILE%\\Box\\経理", description: "受注.xlsx を読むフォルダー" },
    ]);
    expect(change?.ops).toEqual([
      { op: "addStep", step: { type: "config.read", params: { path: "config/settings.json" }, saveAs: "settings" }, position: { index: 0 } },
      { op: "updateStep", stepId: "a", patch: { params: { path: "{{ settings.受注の場所 }}/受注.xlsx" } } },
      { op: "updateStep", stepId: "c", patch: { params: { files: ["{{ settings.受注の場所 }}/受注.xlsx", "x.pdf"] } } },
    ]);
  });

  it("moves everything written under output/ and reuses the node that already reads the settings", () => {
    const settings = JSON.stringify({ format: "spellsheet.config", items: [{ name: "締め日", type: "number", value: 25 }] });
    const change = placeChange({
      flow: flow([
        { id: "r", type: "config.read", params: { path: "config/settings.json" }, saveAs: "conf" },
        { id: "w", type: "file.writeCsv", params: { path: "output/{{ formatDate(today(), 'yyyyMMdd') }}.csv" } },
        { id: "p", type: "pdf.merge", params: { files: ["input/a.pdf"], to: "output/まとめ.pdf" } },
      ]),
      types,
      prefix: "output",
      file: null,
      folder: "\\\\fs01\\経理\\出力",
      settings,
      name: "書き出す場所",
      description: "",
    });
    expect(change?.ops).toEqual([
      { op: "updateStep", stepId: "w", patch: { params: { path: "{{ conf.書き出す場所 }}/{{ formatDate(today(), 'yyyyMMdd') }}.csv" } } },
      { op: "updateStep", stepId: "p", patch: { params: { to: "{{ conf.書き出す場所 }}/まとめ.pdf" } } },
    ]);
    expect(JSON.parse(change!.configText).items.map((i: { name: string }) => i.name)).toEqual(["締め日", "書き出す場所"]);
  });

  it("does nothing when no node uses the place", () => {
    expect(
      placeChange({ flow: flow([]), types, prefix: "output", file: null, folder: "D:\\x", settings: null, name: "書き出す場所", description: "" }),
    ).toBeNull();
  });
});
