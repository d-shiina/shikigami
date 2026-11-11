import { readFileSync } from "node:fs";
import type { Flow, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { operated } from "./manualExport";
import { blurRegions, buildManual, type Chapter, frameTree, cropOf, humanize, overviewRows, type ManualItem, type ManualManifest, maskStale, pagesOf, type Scene } from "./manual";

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
    expect(doc.uses).toEqual({ apps: ["ブラウザ"], logins: ["デモ受注システム"], inputFiles: [], outputFiles: [] });
    expect(overviewRows(doc, []).map((r) => r.label)).toEqual(["利用アプリケーション", "ログイン情報", "入力項目", "出力項目", "実行方法"]);
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

  it("lays the manual out as sheets: a cover, then chapters, screens together while they fit", () => {
    const moved: ManualManifest = { ...manifest, shots: manifest.shots.map((s, i) => ({ ...s, view: `v${i}` })) };
    const pages = pagesOf(buildManual(flow, defs, moved));
    expect(pages[0]?.kind).toBe("cover");
    expect(pages.map((p) => p.number)).toEqual(pages.map((_, i) => i + 1));
    const body = pages.flatMap((p) => (p.kind === "body" ? [p] : []));
    // Each chapter starts on its own sheet.
    expect(body.filter((p) => p.first).map((p) => p.chapter.number)).toEqual([1, 2, 3, 4, 5]);
    // Low screens share a sheet.
    const low: ManualManifest = { ...moved, shots: moved.shots.map((s) => ({ ...s, width: 1100, height: 100, mark: undefined })) };
    const shared = pagesOf(buildManual(flow, defs, low)).flatMap((p) => (p.kind === "body" ? [p] : []));
    const pictured = (p: (typeof shared)[number]) => p.blocks.filter((b) => b.kind === "item" && b.item.kind === "scene" && b.item.shot).length;
    expect(shared.map(pictured)).toContain(2);
    // Tall screens do not fit together: the second goes on the next sheet, under the branch it belongs to.
    const tall: ManualManifest = { ...moved, shots: moved.shots.map((s) => ({ ...s, width: 400, height: 2000, mark: undefined })) };
    const sheets = pagesOf(buildManual(flow, defs, tall)).flatMap((p) => (p.kind === "body" ? [p] : []));
    const second = sheets.find((p) => p.shot?.file === "003.jpg");
    expect(second?.first).toBe(false);
    expect(second?.blocks[0]).toMatchObject({ kind: "label", continued: true, item: { kind: "branch" } });
    // Words only: no more sheets than with the screens.
    expect(pagesOf(buildManual(flow, defs, moved), false).length).toBeLessThanOrEqual(pages.length);
  });

  it("puts a page's blocks in frames by depth", () => {
    const pages = pagesOf(buildManual(flow, defs, manifest)).flatMap((p) => (p.kind === "body" ? [p] : []));
    const withBranch = pages.find((p) => p.blocks.some((b) => b.kind === "label"));
    const branch = frameTree(withBranch?.blocks ?? []).find((n) => n.kind === "frame");
    expect(branch).toMatchObject({ kind: "frame", label: { item: { kind: "branch" } } });
    expect(branch?.kind === "frame" && branch.children.length).toBeGreaterThan(0);
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

describe("what the 手順書 blurs", () => {
  it("keeps the operated button clear inside a blurred table cell", () => {
    const cell = { x: 808, y: 313, width: 172, height: 64 };
    const button = { x: 816, y: 334, width: 93, height: 35 };
    const parts = blurRegions([cell], [button]);
    expect(parts.length).toBeGreaterThan(0);
    const overlaps = (a: { x: number; y: number; width: number; height: number }) =>
      a.x < button.x + button.width && button.x < a.x + a.width && a.y < button.y + button.height && button.y < a.y + a.height;
    expect(parts.some(overlaps)).toBe(false);
    expect(parts.reduce((n, p) => n + p.width * p.height, 0)).toBe(cell.width * cell.height - button.width * button.height);
  });

  it("still blurs a field that is the operated element itself", () => {
    const field = { x: 120, y: 245, width: 280, height: 34 };
    expect(blurRegions([field], [field])).toEqual([field]);
  });

  it("keeps a value a node only reads under the blur", () => {
    const cell = { x: 100, y: 200, width: 300, height: 40 };
    const name = { x: 110, y: 208, width: 80, height: 24 };
    const marks = operated([
      { number: 1, rect: name, operates: false },
      { number: null, rect: name },
    ]);
    expect(blurRegions([cell], marks)).toEqual([cell]);
    expect(operated([{ number: 2, rect: name, operates: true }])).toEqual([name]);
  });
});

describe("words with holes", () => {
  it("turns {{ }} in a name into a chip", () => {
    const parts = humanize([{ text: "「{{ order['注文番号'] }} を出荷」ボタンを押す" }], new Map([["order", "注文"]]));
    expect(parts).toEqual([{ text: "「" }, { code: "注文の「注文番号」" }, { text: " を出荷」ボタンを押す" }]);
  });

  it("reads a flow that is one try as its work, with what it does on failure and at the end after it", () => {
    const step = (id: string, type: string, name: string, blocks?: Record<string, unknown[]>) => ({ id, type, name, params: {}, ...(blocks ? { blocks } : {}) });
    const guarded = {
      ...flow,
      steps: [
        step("t", "control.try", "", {
          try: [step("a", "browser.click", "検索する"), step("l", "control.repeat", "3 回繰り返す", { body: [step("b", "browser.click", "次へ")] })],
          catch: [step("c", "control.fail", "失敗として終える")],
          finally: [step("d", "browser.close", "ブラウザを閉じる")],
        }),
      ],
    } as unknown as Flow;
    const doc = buildManual(guarded, defs, null);
    expect(doc.chapters.map((c) => [c.title, c.role])).toEqual([
      ["検索する", undefined],
      ["3 回繰り返す", undefined],
      [doc.chapters[2]?.title, "failure"],
      [doc.chapters[3]?.title, "end"],
    ]);
    // Numbered through the sheet, not from 1 in each chapter.
    const numbers = (items: ManualItem[]): number[] =>
      items.flatMap((i) => (i.kind === "scene" ? i.steps.map((s) => s.number) : i.kind === "action" ? [i.step.number] : "items" in i ? numbers(i.items) : []));
    expect(doc.chapters.flatMap((c) => numbers(c.items))).toEqual([1, 2, 3, 4]);
  });
});
