import type { StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { plain, sentence, targetText } from "./sentence";

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
});
