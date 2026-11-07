import type { FlowSummary, Step, StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { insertPlace } from "../store";
import { setLocale, t } from "./i18n";
import { en } from "./locales/en";
import { bySection, frequent, frequentBySection, groupOf, groups, nextAfter, normalize, paletteItems, search, stepSummary } from "./palette";
import { toKana } from "./romaji";

const def = (type: string, category: string, label: string, description = ""): StepTypeDef =>
  ({ type, category, label, description, params: {}, blocks: [] }) as unknown as StepTypeDef;

const DEFS: StepTypeDef[] = [
  def("control.break", "control", "繰り返しの終了", "Exits the innermost loop."),
  def("control.if", "control", "条件分岐"),
  def("browser.click", "browser", "クリック", "Clicks the element."),
  def("browser.open", "browser", "ページ表示"),
  def("desktop.click", "windows", "クリック"),
  def("excel.readRows", "office", "行の読み取り"),
  def("excel.addSheet", "office", "シート追加", "Adds an empty sheet; does nothing when it already exists."),
  def("word.readText", "office", "Word 読み取り"),
  def("mail.list", "office", "メール検索"),
  def("flow.delay", "flow", "待機（時間指定）"),
  def("acme.stamp", "acme", "はんこを押す", "Stamps a document. Then more."),
  def("browser.attach", "browser", "既存ブラウザへの接続"),
  def("log.message", "log", "ログ出力"),
  def("dialog.input", "system", "入力ダイアログ"),
  def("process.run", "system", "プログラム実行"),
  def("browser.fill", "browser", "文字入力"),
  def("control.group", "control", "グループ"),
  def("control.forEach", "control", "繰り返し（リスト）"),
];

describe("node palette", () => {
  it("lists Office nodes by application, apps before the flow's own nodes", () => {
    expect(groupOf({ type: "excel.readRows", category: "office" })).toBe("excel");
    expect(groupOf({ type: "mail.list", category: "office" })).toBe("outlook");
    const order = groups(paletteItems(DEFS)).map(([g]) => g);
    expect(order.indexOf("browser")).toBeLessThan(order.indexOf("control"));
    expect(order.indexOf("excel")).toBeLessThan(order.indexOf("control"));
    // A plugin's own category goes last.
    expect(order.at(-1)).toBe("acme");
  });

  it("says what a node does in the current language, and falls back to a plugin's description", () => {
    expect(stepSummary("browser.click", "Clicks the element.")).toBe(t.stepHelp["browser.click"]!.summary);
    expect(stepSummary("acme.stamp", "Stamps a document. Then more.")).toBe("Stamps a document.");
  });

  it("forgives katakana / hiragana and full / half width", () => {
    expect(normalize("ＥｘｃｅｌエクセルＡ")).toBe("excelえくせるa");
    const items = paletteItems(DEFS);
    expect(search(items, "えくせる").map((i) => i.key)).toContain("excel.readRows");
    expect(search(items, "まつ").map((i) => i.key)).toContain("flow.delay");
    expect(search(items, "くりっく").map((i) => i.key)).toEqual(expect.arrayContaining(["browser.click", "desktop.click"]));
  });

  it("ranks a match in the name above one in other words, and needs every word", () => {
    const items = paletteItems(DEFS);
    const keys = search(items, "読む").map((i) => i.key);
    expect(keys.slice(0, 2)).toEqual(expect.arrayContaining(["excel.readRows", "word.readText"]));
    expect(search(items, "excel 読む").map((i) => i.key)).toEqual(["excel.readRows"]);
  });

  it("matches latin words only at the start of a word", () => {
    const items = paletteItems(DEFS);
    // "already" in addSheet's description is not "read".
    expect(search(items, "read").map((i) => i.key)).not.toContain("excel.addSheet");
  });

  it("puts recently added nodes first in the frequent view, without repeating them", () => {
    const items = paletteItems(DEFS);
    const view = frequent(items, ["flow.delay", "browser.open", "gone.type"]);
    expect(view.recent.map((i) => i.key)).toEqual(["flow.delay", "browser.open"]);
    expect(view.common.map((i) => i.key)).not.toContain("browser.open");
    expect(view.common.map((i) => i.key)).toContain("browser.click");
  });

  it("lists reusable flows as nodes that call them, found by name", () => {
    const flow = (id: string, name: string, more: Partial<FlowSummary> = {}): FlowSummary =>
      ({ id, name, description: "", revision: 1, stepCount: 3, tags: [], ...more }) as FlowSummary;
    const flows = [
      flow("scn_open", "開いているフロー", { inputs: ["x"] }),
      flow("scn_invoice", "請求書を登録する", { inputs: ["invoice"], outputs: ["no"] }),
      flow("scn_login", "社内システムにログイン", { description: "ID とパスワードで入る。続き。", outputs: ["ok"] }),
      flow("scn_job", "月次の締め処理"),
    ];
    const items = paletteItems(DEFS, flows, "scn_open");
    const listed = items.filter((i) => i.group === "subflow");
    // Not the open flow (it would call itself), not whole jobs with no inputs or outputs.
    expect(listed.map((i) => i.key)).toEqual(["flow:scn_invoice", "flow:scn_login"]);
    expect(listed[0]).toMatchObject({ type: "flow.call", params: { flow: "scn_invoice" }, summary: t.palette.flowShape(["invoice"], ["no"]) });
    expect(listed[1]!.summary).toBe("ID とパスワードで入る。");
    expect(search(items, "せいきゅうしょ").map((i) => i.key)[0]).toBe("flow:scn_invoice");
    // Listed with the flow's own nodes, after control.
    const order = groups(items).map(([g]) => g);
    expect(order.indexOf("subflow")).toBe(order.indexOf("control") + 1);
  });

  it("explains every built-in node that has an English name", () => {
    expect(Object.keys(en.stepHelp).sort()).toEqual(Object.keys(en.stepTypes).sort());
  });

  it.each(["ja", "en"] as const)("has a summary for every built-in node it names (%s)", (locale) => {
    setLocale(locale, false);
    for (const [, help] of Object.entries(t.stepHelp)) {
      expect(help.summary).not.toBe("");
    }
    setLocale("ja", false);
  });
});

describe("node palette, finding by what a node is for", () => {
  it("lists a group's nodes in the order people use them, under headings", () => {
    const browser = paletteItems(DEFS).filter((i) => i.group === "browser");
    expect(browser.map((i) => i.key)).toEqual(["browser.open", "browser.attach", "browser.click", "browser.fill"]);
    expect(browser.map((i) => i.sub)).toEqual(["open", "open", "operate", "operate"]);
  });

  it("does not find a katakana word inside another one", () => {
    const items = paletteItems(DEFS);
    // ログ is not in ダイアログ nor プログラム; ループ is not in グループ.
    expect(search(items, "ログ").map((i) => i.key)[0]).toBe("log.message");
    expect(search(items, "ログ").map((i) => i.key)).not.toEqual(expect.arrayContaining(["dialog.input"]));
    expect(search(items, "ログ").map((i) => i.key)).not.toContain("process.run");
    expect(search(items, "ループ").map((i) => i.key)).not.toContain("control.group");
    expect(search(items, "ループ").map((i) => i.key)).toContain("control.forEach");
  });

  it("finds nodes by romaji and by their English names", () => {
    expect(toKana("kurikaesi")).toBe("くりかえし");
    expect(toKana("kurikaeshi")).toBe("くりかえし");
    expect(toKana("kitte")).toBe("きって");
    expect(toKana("excel")).toBeNull();
    const items = paletteItems(DEFS);
    expect(search(items, "kurikaesi").map((i) => i.key)).toContain("control.forEach");
    expect(search(items, "loop").map((i) => i.key)).toContain("control.forEach");
  });

  it("keeps operations and flow control apart", () => {
    const items = paletteItems(DEFS);
    const view = frequentBySection(items, []);
    expect(view.map(([s]) => s)).toEqual(["apps", "flow"]);
    expect(view[0]![1].every((i) => !i.key.startsWith("control.") && i.group !== "log")).toBe(true);
    expect(view[1]![1].map((i) => i.key)).toContain("control.if");
    // Search results too, the section of the best match first.
    expect(bySection(search(items, "ログ")).map(([s]) => s)[0]).toBe("flow");
  });

  it("offers what usually follows a node", () => {
    const items = paletteItems(DEFS);
    expect(nextAfter(items, "excel.readRows").map((i) => i.key)[0]).toBe("control.forEach");
    expect(nextAfter(items, "unknown.type")).toEqual([]);
  });
});

describe("insertPlace", () => {
  const steps = [
    { id: "a", type: "log.message" },
    { id: "loop", type: "control.forEach", blocks: { body: [{ id: "b", type: "log.message" }] } },
    { id: "c", type: "log.message", name: "最後" },
  ] as Step[];

  it("adds before the step a line leads to", () => {
    const place = insertPlace(steps, { kind: "step", stepId: "a" }, { parentId: null, block: null, index: 2 });
    expect(place.position).toEqual({ parentId: null, block: null, index: 2 });
    expect(place.before?.id).toBe("c");
  });

  it("adds after the selected step, inside its block", () => {
    const place = insertPlace(steps, { kind: "step", stepId: "b" }, null);
    expect(place.position).toEqual({ parentId: "loop", block: "body", index: 1 });
    expect(place.after?.id).toBe("b");
  });

  it("adds into a selected empty block, or at the end", () => {
    expect(insertPlace(steps, { kind: "slot", parentId: "loop", block: "body" }, null).into?.parent.id).toBe("loop");
    expect(insertPlace(steps, null, null)).toEqual({ position: {} });
  });
});
