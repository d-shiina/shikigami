import type { Step, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { searchFlow } from "./flowSearch";

const defs = new Map<string, StepTypeDef>([
  ["control.if", { type: "control.if", label: "条件分岐", blocks: [{ name: "then", label: "真" }, { name: "else", label: "偽" }] } as unknown as StepTypeDef],
  ["browser.fill", { type: "browser.fill", label: "文字入力" } as unknown as StepTypeDef],
  ["log.message", { type: "log.message", label: "ログ出力" } as unknown as StepTypeDef],
]);

const steps: Step[] = [
  { id: "a", type: "log.message", params: { message: "開始" } },
  {
    id: "b",
    type: "control.if",
    params: { condition: "顧客名 != ''" },
    blocks: {
      then: [{ id: "c", type: "browser.fill", name: "氏名の入力", params: { value: "{{ 顧客名 }}", target: { css: "#name" } } }],
    },
  },
  { id: "d", type: "log.message", description: "ＡＢＣ社の締め日に注意", params: { message: "終了" }, saveAs: "done" },
];

describe("searchFlow", () => {
  it("finds every node that uses a variable, inside blocks too", () => {
    const hits = searchFlow(steps, defs, "顧客名");
    expect(hits.map((h) => [h.id, h.depth])).toEqual([
      ["b", 0],
      ["c", 1],
    ]);
  });

  it("matches names, nested settings and memos, ignoring width and case", () => {
    expect(searchFlow(steps, defs, "氏名").map((h) => [h.id, h.field])).toEqual([["c", "名前"]]);
    expect(searchFlow(steps, defs, "#NAME").map((h) => h.id)).toEqual(["c"]);
    const memo = searchFlow(steps, defs, "abc");
    expect(memo.map((h) => [h.id, h.field])).toEqual([["d", "メモ"]]);
    expect(memo[0]!.text.slice(memo[0]!.start, memo[0]!.start + memo[0]!.length)).toBe("ＡＢＣ");
    expect(searchFlow(steps, defs, "done").map((h) => h.id)).toEqual(["d"]);
  });

  it("marks exactly the matched text, after folded white space and half-width kana", () => {
    const marked = (memo: string, query: string) => {
      const [hit] = searchFlow([{ id: "m", type: "log.message", description: memo, params: {} }], defs, query);
      return hit && hit.text.slice(hit.start, hit.start + hit.length);
    };
    expect(marked("start\n        target", "target")).toBe("target");
    expect(marked("ｶﾞｲﾄﾞ を 読む", "ガイド")).toBe("ｶﾞｲﾄﾞ");
    expect(marked("ﾃｽﾄ".repeat(30) + "\n\n   終わりの印", "終わり")).toBe("終わり");
  });

  it("finds nothing for an empty query", () => {
    expect(searchFlow(steps, defs, "  ")).toEqual([]);
  });
});
