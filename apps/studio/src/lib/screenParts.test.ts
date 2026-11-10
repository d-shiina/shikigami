import { describe, expect, it } from "vitest";
import { composeRequest } from "./handoff";
import { cleanTree } from "./screenParts";

const web = `- heading "受注入力" [level=1]
- navigation:
  - list:
    - listitem:
      - link "ホーム":
        - /url: /
- paragraph: 山田太郎さん、こんにちは
- text: 氏名
- textbox "氏名": 山田太郎
- combobox "区分":
  - option "通常" [selected]
- checkbox "同意" [checked]
- button "保存"
- table:
  - rowgroup:
    - row "番号 顧客":
      - columnheader "番号"
      - columnheader "顧客"
  - rowgroup:
    - row "1 佐藤":
      - cell "1"
      - cell "佐藤"
    - row "2 鈴木":
      - cell "2"
      - cell "鈴木"`;

const app = `- window "請求システム"
  - pane
    - button "保存" id=btnSave
    - textbox "パスワード" id=txtPassword [password]
    - textbox "合計" id=txtTotal value="1,200"
    - list "明細" id=lstItems
      - listitem "A-001 山田"
        - text "A-001"
      - listitem "A-002 佐藤"
    - text "ようこそ 山田さん"
… (3 more elements: pass \`element\` to inspect one part of the window)`;

describe("a screen for the AI", () => {
  it("keeps the parts of a page and leaves out what is typed, the text and the data rows", () => {
    const { tree, parts } = cleanTree(web, "web");
    expect(tree).toContain('- textbox "氏名"');
    expect(tree).toContain('- link "ホーム"');
    expect(tree).toContain('- button "保存"');
    expect(tree).toContain('- columnheader "顧客"');
    expect(tree).toContain('- option "通常" [selected]');
    for (const gone of ["山田太郎", "佐藤", "鈴木", "/url"]) expect(tree).not.toContain(gone);
    expect(tree).toContain("2 件");
    expect(parts).toBeGreaterThan(5);
  });

  it("keeps the ids of an app's parts and leaves out values and rows", () => {
    const { tree } = cleanTree(app, "app");
    expect(tree).toContain('- button "保存" id=btnSave');
    expect(tree).toContain('- textbox "合計" id=txtTotal');
    expect(tree).toContain('- list "明細" id=lstItems');
    for (const gone of ["1,200", "山田", "佐藤", "more elements"]) expect(tree).not.toContain(gone);
  });

  it("goes into the request before the person's words", () => {
    const { tree, parts } = cleanTree(app, "app");
    const text = composeRequest("保存して", "INSTRUCTIONS", null, null, [{ kind: "app", title: "請求システム", where: "billing.exe", window: { process: "billing.exe", title: "請求", nth: 2 }, tree, parts }]);
    expect(text.indexOf("画面の部品")).toBeGreaterThan(text.indexOf("INSTRUCTIONS"));
    expect(text.indexOf("画面の部品")).toBeLessThan(text.indexOf("保存して"));
    expect(text).toContain("process: billing.exe");
    expect(text).toContain('{"process":"billing.exe","title":"請求","nth":2}');
    expect(composeRequest("保存して", "I", null)).not.toContain("画面の部品");
  });
});
