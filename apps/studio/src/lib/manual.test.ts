import { readFileSync } from "node:fs";
import type { Flow, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { buildManual, type Chapter, cropOf, humanize, type ManualItem, type ManualManifest, maskStale, pagesOf, type Scene } from "./manual";

const flow = JSON.parse(readFileSync(new URL("../../../../examples/browser-demo.json", import.meta.url), "utf8")) as Flow;
const contract = JSON.parse(readFileSync(new URL("../../../../schemas/contract/step-types.json", import.meta.url), "utf8")) as {
  stepTypes: { type: string; blocks?: StepTypeDef["blocks"] }[];
};
const defs = new Map(contract.stepTypes.map((d) => [d.type, { ...d, label: "", description: "", category: "core", paramsSchema: {}, risk: "low" } as unknown as StepTypeDef]));

/** The ID of the step named `name` in the demo flow. */
function idOf(name: string): string {
  const walk = (steps: Flow["steps"]): string | undefined => {
    for (const s of steps ?? []) {
      if (s.name === name) return s.id ?? undefined;
      for (const b of Object.values(s.blocks ?? {})) {
        const found = walk(b);
        if (found) return found;
      }
    }
    return undefined;
  };
  const id = walk(flow.steps);
  if (!id) throw new Error(`no step ${name}`);
  return id;
}

const scenes = (items: ManualItem[]): Scene[] =>
  items.flatMap((i) => (i.kind === "scene" ? [i] : "items" in i ? scenes(i.items) : []));
const find = <K extends ManualItem["kind"]>(items: ManualItem[], kind: K): Extract<ManualItem, { kind: K }>[] =>
  items.flatMap((i) => [...(i.kind === kind ? [i as Extract<ManualItem, { kind: K }>] : []), ...("items" in i ? find(i.items, kind) : [])]);

describe("the 手順書 of a flow", () => {
  const login = idOf("ログイン");
  const user = idOf("ユーザー名を入力");
  const manifest: ManualManifest = {
    runId: "run_1",
    revision: 1,
    startedAt: "2026-11-08T09:00:00Z",
    durationMs: 72_000,
    shots: [
      { key: user, stepId: user, file: "001.jpg", width: 1100, height: 620, title: "ログイン", mark: { x: 120, y: 245, width: 280, height: 34 } },
      { key: login, stepId: login, file: "003.jpg", width: 1100, height: 620, title: "ログイン", mark: { x: 120, y: 363, width: 93, height: 35 } },
    ],
    counts: { [user]: 1, [login]: 1, [idOf("出荷ボタンを押す")]: 3, [idOf("未処理か")]: 5, [idOf("在庫切れを記録")]: 1 },
  };
  const doc = buildManual(flow, defs, manifest);
  const titles = doc.chapters.map((c: Chapter) => c.title);

  it("reads the top level as chapters, parallel work side by side", () => {
    expect(titles).toEqual([
      "受注係：ログインして受注一覧を読む",
      "在庫係：在庫一覧を読む",
      "未処理の注文を 1 件ずつ出荷",
      "在庫切れを確認",
      "出荷後の一覧で未処理が消えたことを確認",
    ]);
    expect(doc.chapters[0]?.alongside).toEqual([2]);
    expect(doc.chapters[1]?.alongside).toEqual([1]);
    expect(doc.chapters[2]?.loops).toBe(true);
  });

  it("puts operations on one screen together, with their marks and numbers", () => {
    const branch = find(doc.chapters[0]?.items ?? [], "branch")[0];
    expect(branch?.label).toBe("未ログインのときだけログイン");
    expect(branch?.taken).toBe(true);
    const [scene] = scenes(branch?.items ?? []);
    expect(scene?.shot?.file).toBe("001.jpg");
    expect(scene?.steps.map((s) => s.text)).toEqual(["ユーザー名を入力", "パスワードを入力", "ログイン"]);
    expect(scene?.steps.map((s) => s.mark?.y ?? null)).toEqual([245, null, 363]);
    // Numbered through the chapter.
    expect(scene?.steps[0]?.number).toBeGreaterThan(1);
    const otherwise = find(doc.chapters[0]?.items ?? [], "branch")[1];
    expect(otherwise?.taken).toBe(false);
  });

  it("says waits in place without numbering them", () => {
    const all = doc.chapters.flatMap((c) => scenes(c.items));
    const waiting = all.find((s) => s.waits.some((w) => w.text.includes("受注一覧の表示を待つ")));
    expect(waiting).toBeDefined();
    expect(all.flatMap((s) => s.steps.map((x) => x.text))).not.toContain("受注一覧の表示を待つ");
    for (const s of all) for (const w of s.waits) expect(w.at).toBeLessThanOrEqual(s.steps.length);
  });

  it("says how often loops ran and folds work without a screen", () => {
    const loop = find(doc.chapters[2]?.items ?? [], "loop")[0];
    expect(loop?.times).toBe(5);
    const quiet = find(loop?.items ?? [], "quiet")[0];
    expect(quiet?.texts).toEqual(["出荷した注文を記録", "金額を合計", "出荷を報告"]);
    // The opening and summary logs join the chapters beside them.
    expect(find(doc.chapters[0]?.items ?? [], "quiet")[0]?.texts).toEqual(["開始"]);
  });

  it("lists what the flow uses, takes and produces in words", () => {
    expect(doc.uses).toEqual(["ブラウザ", "ログイン情報「デモ受注システム」"]);
    expect(doc.inputs).toEqual(["デモサイトの URL"]);
    expect(doc.outputs).toEqual(["出荷した注文番号", "出荷した金額の合計（円）", "在庫切れの商品"]);
    expect(doc.pictures).toBe(1);
  });

  it("has no picture and no counts without a run", () => {
    const bare = buildManual(flow, defs, null);
    expect(bare.pictures).toBe(0);
    expect(find(bare.chapters[0]?.items ?? [], "branch")[0]?.taken).toBeNull();
    expect(bare.missing).toBeGreaterThan(0);
  });

  it("starts a new picture when the view changed under the same title", () => {
    const moved: ManualManifest = { ...manifest, shots: manifest.shots.map((s, i) => ({ ...s, view: `v${i}` })) };
    const split = scenes(find(buildManual(flow, defs, moved).chapters[0]?.items ?? [], "branch")[0]?.items ?? []);
    expect(split.map((s) => s.shot?.file ?? null)).toEqual(["001.jpg", "003.jpg"]);
    expect(split[1]?.steps.at(-1)?.mark?.y).toBe(363);
  });

  it("shows the screen a node met when it was tried alone, until a run takes one", () => {
    const pass = idOf("パスワードを入力");
    const drafts = { [flow.id ?? ""]: { [pass]: { file: "drafts/f/abc.jpg", width: 1100, height: 620, title: "ログイン", source: "ai" as const, takenAt: 1 } } };
    const before = buildManual(flow, defs, null, new Map(), {}, drafts);
    const [scene] = scenes(find(before.chapters[0]?.items ?? [], "branch")[0]?.items ?? []);
    expect(scene?.shot?.draft).toBe("ai");
    expect(scene?.shot?.key).toBe(pass);
    expect(before.drafts).toBe(1);
    // A run's own picture wins.
    const after = buildManual(flow, defs, manifest, new Map(), {}, drafts);
    const [first] = scenes(find(after.chapters[0]?.items ?? [], "branch")[0]?.items ?? []);
    expect(first?.shot?.file).toBe("001.jpg");
    // Hidden by the person: left out too.
    const hidden = buildManual(flow, defs, null, new Map(), { [pass]: { hidden: true, boxes: [], width: 0, height: 0 } }, drafts);
    expect(hidden.drafts).toBe(0);
  });

  it("lays the manual out as sheets: a cover, then one screen per page", () => {
    const moved: ManualManifest = { ...manifest, shots: manifest.shots.map((s, i) => ({ ...s, view: `v${i}` })) };
    const pages = pagesOf(buildManual(flow, defs, moved));
    expect(pages[0]?.kind).toBe("cover");
    expect(pages.map((p) => p.number)).toEqual(pages.map((_, i) => i + 1));
    const body = pages.flatMap((p) => (p.kind === "body" ? [p] : []));
    // Each chapter starts on its own sheet, and no sheet holds two pictures.
    expect(body.filter((p) => p.first).map((p) => p.chapter.number)).toEqual([1, 2, 3, 4, 5]);
    for (const p of body) expect(p.blocks.filter((b) => b.kind === "item" && b.item.kind === "scene" && b.item.shot).length).toBeLessThanOrEqual(1);
    // The second login screen goes on the next sheet, under the branch it belongs to.
    const second = body.find((p) => p.shot?.file === "003.jpg");
    expect(second?.first).toBe(false);
    expect(second?.blocks[0]).toMatchObject({ kind: "label", continued: true, item: { kind: "branch" } });
    // Words only: one run of pages per chapter.
    expect(pagesOf(buildManual(flow, defs, moved), false).length).toBe(1 + doc.chapters.length);
  });

  it("leaves out screens the person hid", () => {
    const hidden = buildManual(flow, defs, manifest, new Map(), { [user]: { hidden: true, boxes: [], width: 0, height: 0 } });
    const [scene] = scenes(find(hidden.chapters[0]?.items ?? [], "branch")[0]?.items ?? []);
    expect(scene?.shot?.file).toBe("003.jpg");
  });
});

describe("words in the 手順書", () => {
  it("uses variable descriptions and column names", () => {
    const words = new Map([["siteUrl", "デモサイトの URL"]]);
    expect(humanize([{ text: "開く " }, { code: "siteUrl" }], words)).toEqual([{ text: "開く " }, { code: "デモサイトの URL" }]);
    expect(humanize([{ code: "order['注文番号']" }], words)).toEqual([{ code: "orderの「注文番号」" }]);
  });
});

describe("pictures in the 手順書", () => {
  it("shows the part around the marks, the whole picture without marks", () => {
    expect(cropOf(1100, 620, [])).toEqual({ x: 0, y: 0, width: 1100, height: 620 });
    const crop = cropOf(1100, 620, [{ x: 816, y: 334, width: 93, height: 35 }]);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1100);
    expect(crop.x).toBeLessThanOrEqual(816);
    expect(crop.width).toBeGreaterThanOrEqual(640);
    expect(crop.y).toBeLessThanOrEqual(334);
  });

  it("asks to check hidden areas when the picture changed size", () => {
    const shot = { key: "a", stepId: "a", file: "1.jpg", width: 800, height: 600 };
    expect(maskStale({ hidden: false, boxes: [{ x: 0, y: 0, width: 5, height: 5, kind: "blur" }], width: 800, height: 600 }, shot)).toBe(false);
    expect(maskStale({ hidden: false, boxes: [{ x: 0, y: 0, width: 5, height: 5, kind: "blur" }], width: 1024, height: 600 }, shot)).toBe(true);
    expect(maskStale(undefined, shot)).toBe(false);
  });
});
