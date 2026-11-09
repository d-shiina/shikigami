import type { Flow, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { BOX, boxTarget, cloudChange } from "./cloudPlaces";

const types = [
  { type: "excel.readRows", pathParams: ["path"] },
  { type: "excel.writeCell", pathParams: ["path"] },
  { type: "file.writeCsv", pathParams: ["path"] },
  { type: "pdf.merge", pathParams: ["files", "to"] },
  { type: "config.read", pathParams: ["path"] },
] as StepTypeDef[];

const box = BOX;
const labels = { signIn: "Box にサインイン", download: (f: string) => `${f} をダウンロード`, upload: (f: string) => `${f} をアップロード` };
const flow = (steps: Flow["steps"]) => ({ id: "scn_a", name: "a", steps }) as Flow;
const account = { secret: "Box", field: "accessToken" };
const signIn = {
  type: "oauth.signIn",
  name: "Box にサインイン",
  params: { secret: "Box", authorizeUrl: box.authorizeUrl, tokenUrl: box.tokenUrl, redirectUrl: "https://www.example.com/" },
};

describe("boxTarget", () => {
  it("takes the ID from a Box link and keeps a path", () => {
    expect(boxTarget("https://app.box.com/file/1234567?s=abc")).toBe("1234567");
    expect(boxTarget("https://example.app.box.com/folder/987")).toBe("987");
    expect(boxTarget(" /経理\\受注/受注.xlsx ")).toBe("経理/受注/受注.xlsx");
  });
});

describe("cloudChange", () => {
  const base = {
    types,
    service: box,
    secret: "Box",
    redirectUrl: "https://www.example.com/",
    settings: null,
    description: "",
    labels,
  };

  it("reads the settings, signs in, downloads the file to work/ and points the readers there", () => {
    const change = cloudChange({
      ...base,
      flow: flow([
        { id: "a", type: "excel.readRows", params: { path: "input/受注.xlsx" } },
        { id: "b", type: "excel.readRows", params: { path: "input/別.xlsx" } },
      ]),
      file: "input/受注.xlsx",
      target: "経理/受注/受注.xlsx",
      name: "受注のBox",
    });
    expect(change?.count).toBe(1);
    expect(JSON.parse(change!.configText).items).toEqual([{ name: "受注のBox", type: "text", value: "経理/受注/受注.xlsx", description: "" }]);
    expect(change?.ops).toEqual([
      { op: "addStep", step: { type: "config.read", params: { path: "config/settings.json" }, saveAs: "settings" }, position: { index: 0 } },
      { op: "addStep", step: signIn, position: { index: 1 } },
      { op: "updateStep", stepId: "a", patch: { params: { path: "work/受注.xlsx" } } },
      {
        op: "addStep",
        step: {
          type: "box.download",
          name: "受注.xlsx をダウンロード",
          params: { account, file: "{{ settings.受注のBox }}", to: "work/受注.xlsx", overwrite: true },
        },
        position: { index: 2 },
      },
    ]);
  });

  it("reuses the settings node and the sign-in, and puts a second download after the first", () => {
    const change = cloudChange({
      ...base,
      flow: flow([
        { id: "r", type: "config.read", params: { path: "config/settings.json" }, saveAs: "conf" },
        { id: "s", type: "oauth.signIn", params: { secret: "Box" } },
        { id: "d", type: "box.download", params: { to: "work/a.xlsx" } },
        { id: "a", type: "excel.readRows", params: { path: "input/b.xlsx" } },
      ]),
      file: "input/b.xlsx",
      target: "123",
      name: "bのBox",
    });
    expect(change?.ops.map((o) => [o.op, o.op === "addStep" ? o.position : o.op === "updateStep" ? o.stepId : null])).toEqual([
      ["updateStep", "a"],
      ["addStep", { index: 3 }],
    ]);
  });

  it("uploads each file under output/ once, after the top-level node that holds its last writer", () => {
    const change = cloudChange({
      ...base,
      flow: flow([
        {
          id: "loop",
          type: "control.forEach",
          params: { items: "{{ rows }}" },
          blocks: {
            body: [
              { id: "w", type: "excel.writeCell", params: { path: "output/集計.xlsx" } },
              { id: "c", type: "file.writeCsv", params: { path: "output/{{ item.name }}.csv" } },
            ],
          },
        },
        { id: "end", type: "log.message", params: {} },
      ]),
      file: null,
      target: "経理/出力",
      name: "書き出すBoxフォルダー",
    });
    expect(change?.count).toBe(2);
    const adds = change!.ops.filter((o) => o.op === "addStep");
    expect(adds.map((o) => [o.step.type, o.position])).toEqual([
      ["config.read", { index: 0 }],
      ["oauth.signIn", { index: 1 }],
      ["box.upload", { index: 3 }],
      ["box.upload", { parentId: "loop", block: "body", index: 2 }],
    ]);
    expect(adds[2]?.step.params).toEqual({ account, path: "output/集計.xlsx", folder: "{{ settings.書き出すBoxフォルダー }}", overwrite: true });
    expect(adds[3]?.step.name).toBe("….csv をアップロード");
  });

  it("keeps the folders under input/, so two files of the same name do not share work/", () => {
    const change = cloudChange({
      ...base,
      flow: flow([
        { id: "e", type: "excel.readRows", params: { path: "input/east/orders.csv" } },
        { id: "w", type: "excel.readRows", params: { path: "input/west/orders.csv" } },
      ]),
      file: "input/east/orders.csv",
      target: "1",
      name: "east",
    });
    expect(change?.ops).toContainEqual({ op: "updateStep", stepId: "e", patch: { params: { path: "work/east/orders.csv" } } });
    expect(change?.ops.find((o) => o.op === "addStep" && o.step.type === "box.download")).toMatchObject({ step: { params: { to: "work/east/orders.csv" } } });
  });

  it("does not reuse a sign-in or settings node that runs after the first reader", () => {
    const change = cloudChange({
      ...base,
      flow: flow([
        { id: "a", type: "excel.readRows", params: { path: "input/b.xlsx" } },
        { id: "r", type: "config.read", params: { path: "config/settings.json" }, saveAs: "conf" },
        { id: "s", type: "oauth.signIn", params: { secret: "Box" } },
      ]),
      file: "input/b.xlsx",
      target: "1",
      name: "bのBox",
    });
    const adds = change!.ops.filter((o) => o.op === "addStep");
    expect(adds.map((o) => [o.step.type, o.position])).toEqual([
      ["config.read", { index: 0 }],
      ["oauth.signIn", { index: 1 }],
      ["box.download", { index: 2 }],
    ]);
  });

  it("keeps the upload inside an if, where the file is written only sometimes", () => {
    const change = cloudChange({
      ...base,
      flow: flow([
        {
          id: "if",
          type: "control.if",
          params: { condition: "{{ true }}" },
          blocks: { then: [{ id: "w", type: "file.writeCsv", params: { path: "output/a.csv" } }] },
        },
      ]),
      file: null,
      target: "1",
      name: "out",
    });
    const upload = change!.ops.find((o) => o.op === "addStep" && o.step.type === "box.upload");
    expect(upload).toMatchObject({ position: { parentId: "if", block: "then", index: 1 } });
  });

  it("does nothing when no node uses the file", () => {
    expect(cloudChange({ ...base, flow: flow([]), file: null, target: "x", name: "n" })).toBeNull();
  });
});
