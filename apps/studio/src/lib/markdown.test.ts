import { describe, expect, it } from "vitest";
import { type Block, parseInline, parseMarkdown, plainLine, safeHref } from "./markdown";

const kinds = (blocks: Block[]) => blocks.map((b) => b.kind);

describe("parseMarkdown", () => {
  it("reads what an agent usually writes", () => {
    const blocks = parseMarkdown(
      [
        "## 変更内容",
        "",
        "フロー **受注取り込み** を直しました。",
        "",
        "- Excel を読む",
        "- 1 行ずつ入力",
        "  - 入力欄は `#order` です",
        "",
        "1. 公開",
        "2. 実行",
        "",
        "```json",
        '{ "a": 1 }',
        "```",
        "",
        "> 注意：本番の画面ではありません",
        "",
        "| 列 | 値 |",
        "|:--|--:|",
        "| a | 1 |",
        "",
        "---",
      ].join("\n"),
    );
    expect(kinds(blocks)).toEqual(["heading", "paragraph", "list", "list", "code", "quote", "table", "rule"]);
    const bullets = blocks[2] as Extract<Block, { kind: "list" }>;
    expect(bullets.items).toHaveLength(2);
    expect(kinds(bullets.items[1]!.children)).toEqual(["paragraph", "list"]);
    const numbers = blocks[3] as Extract<Block, { kind: "list" }>;
    expect(numbers.ordered).toBe(true);
    expect(blocks[4]).toEqual({ kind: "code", lang: "json", text: '{ "a": 1 }', open: false });
    const table = blocks[6] as Extract<Block, { kind: "table" }>;
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows).toHaveLength(1);
  });

  it("keeps every prefix of a streaming reply readable", () => {
    const reply = "## 手順\n\n- **Excel** を読む\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n終わり";
    for (let n = 0; n <= reply.length; n++) expect(() => parseMarkdown(reply.slice(0, n))).not.toThrow();
    // An unclosed fence is code up to the end, not paragraphs.
    expect(parseMarkdown("説明\n\n```ts\nconst a = 1;\n\nconst b")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "説明" }] },
      { kind: "code", lang: "ts", text: "const a = 1;\n\nconst b", open: true },
    ]);
    for (const end of ["https://", "http://", "https://.", "[a](https://"]) expect(() => parseMarkdown(`See ${end}`)).not.toThrow();
    expect(parseInline("See https://")).toEqual([{ kind: "text", text: "See https://" }]);
    // An unclosed `**` is shown as written.
    expect(parseInline("これは **重要")).toEqual([{ kind: "text", text: "これは **重要" }]);
  });

  it("keeps tabs inside code as written", () => {
    expect(parseMarkdown("```make\nall:\n\techo ok\n```")).toEqual([{ kind: "code", lang: "make", text: "all:\n\techo ok", open: false }]);
    const [list] = parseMarkdown("- a\n\t- b") as [Extract<Block, { kind: "list" }>];
    expect(list.items[0]!.children.map((b) => b.kind)).toEqual(["paragraph", "list"]);
  });

  it("keeps a raw HTML tag as text", () => {
    expect(parseMarkdown('<img src=x onerror="alert(1)">')).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: '<img src=x onerror="alert(1)">' }] },
    ]);
  });

  it("reads task lists and lines run on from an item", () => {
    const [list] = parseMarkdown("- [x] 済み\n- [ ] まだ\n  続き") as [Extract<Block, { kind: "list" }>];
    expect(list.items.map((i) => i.task)).toEqual([true, false]);
    expect(list.items[1]!.children).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "まだ" }, { kind: "break" }, { kind: "text", text: "続き" }] },
    ]);
  });

  it("keeps lines of a paragraph apart, as in a chat", () => {
    expect(parseMarkdown("一行目\n二行目")).toEqual([
      { kind: "paragraph", children: [{ kind: "text", text: "一行目" }, { kind: "break" }, { kind: "text", text: "二行目" }] },
    ]);
  });
});

describe("parseInline", () => {
  it("reads code, emphasis and strikethrough", () => {
    expect(parseInline("**太字**と*斜体*と`code`と~~取消~~")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "太字" }] },
      { kind: "text", text: "と" },
      { kind: "em", children: [{ kind: "text", text: "斜体" }] },
      { kind: "text", text: "と" },
      { kind: "code", text: "code" },
      { kind: "text", text: "と" },
      { kind: "del", children: [{ kind: "text", text: "取消" }] },
    ]);
  });

  it("leaves snake_case, arithmetic and code contents alone", () => {
    expect(parseInline("file_name_here")).toEqual([{ kind: "text", text: "file_name_here" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
    expect(parseInline("`**x**`")).toEqual([{ kind: "code", text: "**x**" }]);
    expect(parseInline("\\*そのまま\\*")).toEqual([{ kind: "text", text: "*そのまま*" }]);
  });

  it("links only http(s) addresses", () => {
    expect(parseInline("[手順](https://example.com/a)")).toEqual([
      { kind: "link", href: "https://example.com/a", children: [{ kind: "text", text: "手順" }] },
    ]);
    expect(parseInline("[押して](javascript:alert(1))")).toEqual([{ kind: "text", text: "押して" }]);
    expect(parseInline("[開く](file:///C:/x.exe)")).toEqual([{ kind: "text", text: "開く" }]);
  });

  it("finds bare addresses without sentence punctuation", () => {
    expect(parseInline("詳しくは https://example.com/docs。")).toEqual([
      { kind: "text", text: "詳しくは " },
      { kind: "link", href: "https://example.com/docs", children: [{ kind: "text", text: "https://example.com/docs" }] },
      { kind: "text", text: "。" },
    ]);
    expect(parseInline("(see https://example.com/a).")[1]).toMatchObject({ href: "https://example.com/a" });
  });
});

describe("safeHref", () => {
  it("refuses anything but a plain web address", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("<https://example.com>")).toBe("https://example.com");
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("https://example.com/\"onclick")).toBeNull();
    expect(safeHref("//example.com")).toBeNull();
  });
});

describe("plainLine", () => {
  it("drops the marks for the chat list", () => {
    expect(plainLine("\n## **変更**しました\n\n詳細")).toBe("変更しました");
    expect(plainLine("- `a` を直す")).toBe("a を直す");
  });
});
