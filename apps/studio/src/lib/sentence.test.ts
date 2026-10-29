import type { StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { plain, readable, sentence, targetText } from "./sentence";

describe("sentence", () => {
  it("reads known step types as Japanese", () => {
    expect(plain(sentence({ type: "control.if", params: { condition: "a > 1" } }, undefined))).toBe("もし a > 1 なら");
    expect(
      plain(sentence({ type: "browser.fill", params: { target: { label: "ユーザー名" }, value: "{{ user }}" } }, undefined)),
    ).toBe("「ユーザー名」欄に user を入れる");
  });

  it("turns template holes into chips and keeps the words", () => {
    const parts = sentence({ type: "log.message", params: { message: "合計 {{ total }} 円" } }, undefined);
    expect(parts).toContainEqual({ code: "total" });
    expect(parts).toContainEqual({ text: "合計 " });
  });

  it("falls back to the registry label for unknown types", () => {
    const def: StepTypeDef = { type: "x.y", category: "other", label: "謎の操作", description: "", paramsSchema: {}, risk: "safe" };
    expect(plain(sentence({ type: "x.y", params: { a: 1 } }, def))).toBe("謎の操作 a 1");
  });

  it("describes browser targets by meaning", () => {
    expect(targetText({ role: "button", name: "ログイン" })).toBe("「ログイン」ボタン");
    expect(targetText({ text: "次へ", nth: 1 })).toBe("「次へ」の2番目");
  });

  it("describes desktop targets with their window", () => {
    const win = { title: "Citrix" };
    expect(targetText({ window: win })).toBe("「Citrix」ウィンドウ");
    expect(targetText({ window: { process: "billing.exe" }, element: { id: "btnSave" } })).toBe("「billing.exe」の [btnSave]");
    expect(targetText({ window: win, element: { role: "button", name: "保存" } })).toBe("「Citrix」の「保存」ボタン");
    expect(targetText({ window: win, image: { path: "C:\\RPA\\images\\保存.png", nth: 0 } })).toBe("「Citrix」の画像 保存.pngの1番目");
    expect(targetText({ window: win, ocr: { text: "検索" } })).toBe("「Citrix」の文字「検索」");
    expect(targetText({ window: win, region: { x: 1, y: 2, width: 30, height: 40 } })).toBe("「Citrix」の範囲 (1, 2, 30×40)");
  });
});

describe("readable", () => {
  it("puts built-in functions and operators into words", () => {
    expect(readable("len(invoices)")).toBe("invoicesの件数");
    expect(readable("invoice.amount >= threshold && invoice.status != 'paid'")).toBe("invoice.amount ≥ threshold かつ invoice.status ≠ 'paid'");
    expect(readable("!isEmpty(flagged)")).toBe("flaggedが空でない");
  });
});
