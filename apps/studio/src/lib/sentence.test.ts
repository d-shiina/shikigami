import type { StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { plain, readable, sentence, targetText, typeTitle } from "./sentence";

describe("sentence", () => {
  it("reads known step types as Japanese", () => {
    expect(plain(sentence({ type: "control.if", params: { condition: "a > 1" } }, undefined))).toBe("もし a > 1 なら");
    expect(
      plain(sentence({ type: "browser.fill", params: { target: { label: "ユーザー名" }, value: "{{ user }}" } }, undefined)),
    ).toBe("「ユーザー名」欄に user を入れる");
  });

  it("reads a value-handling expression as words, with its form's name", () => {
    const step = { type: "variable.set", params: { name: "total", expression: "sum(map(rows, r => num(r.金額)))" } };
    expect(plain(sentence(step, undefined))).toBe("total に rows の「金額」の合計を入れる");
    expect(sentence(step, undefined)).toContainEqual({ code: "rows" });
    expect(typeTitle(step, undefined)).toBe("表の列を集計");
    expect(plain(sentence({ type: "variable.set", params: { name: "t", expression: "replace(t, '/', '-')" } }, undefined))).toBe("t に t の 「/」 を 「-」 に置き換えた文字を入れる");
    // Other expressions stay as written.
    expect(plain(sentence({ type: "variable.set", params: { name: "x", expression: "a * b + c" } }, undefined))).toBe("x に a * b + c を入れる");
    setLocale("en", false);
    expect(plain(sentence(step, undefined))).toBe("Set total to the sum of “金額” in rows");
    setLocale("ja", false);
  });

  it("turns template holes into chips and keeps the words", () => {
    const parts = sentence({ type: "log.message", params: { message: "合計 {{ total }} 円" } }, undefined);
    expect(parts).toContainEqual({ code: "total" });
    expect(parts).toContainEqual({ text: "合計 " });
  });

  it("falls back to the registry label and param names for unknown types", () => {
    const def: StepTypeDef = { type: "x.y", category: "other", label: "謎の操作", description: "", paramsSchema: {}, risk: "safe" };
    expect(plain(sentence({ type: "x.y", params: { a: 1 } }, def))).toBe("謎の操作 a：1");
  });

  it("describes browser targets by meaning", () => {
    expect(targetText({ role: "button", name: "ログイン" })).toBe("「ログイン」ボタン");
    expect(targetText({ text: "次へ", nth: 1 })).toBe("「次へ」の2番目");
  });

  it("says which frame, tab and dialog a browser step is about", () => {
    expect(targetText({ label: "備考", frame: { name: "main" } })).toBe("「備考」欄（フレーム「main」の中）");
    expect(plain(sentence({ type: "browser.click", params: { target: { role: "button", name: "削除" }, dialog: "accept" } }, undefined))).toBe(
      "「削除」ボタンを押して、確認に OK で答える",
    );
    expect(plain(sentence({ type: "browser.click", params: { target: { role: "button", name: "削除" } } }, undefined))).toBe("「削除」ボタンを押す");
    expect(plain(sentence({ type: "browser.switchTab", params: { title: "受注詳細" } }, undefined))).toBe("「受注詳細」のタブに移る");
    expect(plain(sentence({ type: "browser.scroll", params: { to: "bottom" } }, undefined))).toBe("ページを一番下までスクロールする");
    expect(plain(sentence({ type: "browser.getAttribute", params: { target: { role: "link", name: "請求書" }, name: "href" }, saveAs: "url" }, undefined))).toBe(
      "「請求書」リンクの href 属性を読む（→ url）",
    );
  });

  it("reads downloads and uploads with their files", () => {
    expect(plain(sentence({ type: "browser.download", params: { target: { role: "button", name: "CSV出力" }, path: "input/受注.csv" } }, undefined))).toBe(
      "「CSV出力」ボタンを押してダウンロードし、input/受注.csv に保存する",
    );
    expect(plain(sentence({ type: "browser.upload", params: { target: { label: "添付" }, path: "output/a.pdf" } }, undefined))).toBe(
      "「添付」欄に output/a.pdf を添付する",
    );
  });

  it("describes desktop targets with their window", () => {
    const win = { title: "Citrix" };
    expect(targetText({ window: win })).toBe("「Citrix」ウィンドウ");
    expect(targetText({ window: { process: "billing.exe" }, element: { id: "btnSave" } })).toBe("「billing.exe」の [btnSave]");
    expect(targetText({ window: win, element: { role: "button", name: "保存" } })).toBe("「Citrix」の「保存」ボタン");
    expect(targetText({ window: win, image: { path: "C:\\RPA\\images\\保存.png", nth: 0 } })).toBe("「Citrix」の画像 保存.pngの1番目");
    expect(targetText({ window: win, ocr: { text: "検索" } })).toBe("「Citrix」の文字「検索」");
    expect(targetText({ window: win, region: { x: 1, y: 2, width: 30, height: 40 } })).toBe("「Citrix」の範囲 (1, 2, 30×40)");
    expect(targetText({ window: win, element: { role: "button", name: "検索", within: { role: "group", name: "送り先" } } })).toBe(
      "「Citrix」の「送り先」グループの中の「検索」ボタン",
    );
    expect(targetText({ window: win, element: { role: "textbox", after: { role: "text", name: "氏名" } } })).toBe("「Citrix」の「氏名」ラベルの後の欄");
  });

  it("names the image a desktop OCR step reads from a file", () => {
    expect(plain(sentence({ type: "desktop.readText", params: { file: "{{ scan }}" } }, undefined))).toContain("scan の画像の文字を OCR で読む");
  });
});

describe("readable", () => {
  it("puts built-in functions and operators into words", () => {
    expect(readable("len(invoices)")).toBe("invoicesの件数");
    expect(readable("invoice.amount >= threshold && invoice.status != 'paid'")).toBe("invoice.amount ≥ threshold かつ invoice.status ≠ 'paid'");
    expect(readable("!isEmpty(flagged)")).toBe("flaggedが空でない");
    expect(readable("len(受注一覧)")).toBe("受注一覧の件数");
    expect(readable("isEmpty(受注.備考)")).toBe("受注.備考が空");
  });
});

describe("referencedVariables", () => {
  it("counts only the {{ }} holes inside a target, not words of its literal text", async () => {
    const { referencedVariables } = await import("./nodeRows");
    const known = new Set(["billing", "user"]);
    expect(referencedVariables({ window: { process: "billing.exe" } }, known)).toEqual([]);
    expect(referencedVariables({ name: "{{ user }}" }, known)).toEqual(["user"]);
    expect(referencedVariables("billing.total > 1", known)).toEqual(["billing"]);
    const ja = new Set(["請求金額", "宛名"]);
    expect(referencedVariables("請求金額 * 1.1", ja)).toEqual(["請求金額"]);
    expect(referencedVariables("{{ 宛名 }} 様", ja)).toEqual(["宛名"]);
  });
});
