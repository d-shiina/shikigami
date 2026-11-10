import { describe, expect, it } from "vitest";
import type { Effect } from "./effects";
import { isQuestion, readCheck, usedRows } from "./reviewFiles";

const effect = (over: Partial<Effect>): Effect => ({ stepId: "s", action: "読み取り", target: "", risk: "safe", reads: true, status: "added", ...over });

describe("usedRows", () => {
  it("says each target as a kind, with starting values filled in", () => {
    const rows = usedRows(
      [
        effect({ stepId: "a", action: "CSV 読み取り", target: "input/{{ branch }}.csv" }),
        effect({ stepId: "b", action: "Excel 書き込み", target: "output/売上まとめ.xlsx", risk: "interactive", reads: false }),
        effect({ stepId: "c", action: "ページを開く", target: "https://example.com/orders", risk: "interactive", reads: false }),
      ],
      [{ name: "branch", label: null, value: "大阪", given: false }],
    );
    expect(rows.map((r) => [r.kind, r.target, r.reads])).toEqual([
      ["inputFile", "input/大阪.csv", true],
      ["outputFile", "output/売上まとめ.xlsx", false],
      ["site", "https://example.com/orders", false],
    ]);
    expect(rows[0]?.preview).toBe("input/大阪.csv");
  });

  it("joins the nodes on one file: read and written is an output file, opened at the node that writes", () => {
    const rows = usedRows(
      [
        effect({ stepId: "r", action: "Excel 読み取り", target: "book.xlsx" }),
        effect({ stepId: "w", action: "Excel 書き込み", target: "book.xlsx", risk: "dangerous", reads: false, status: "same" }),
      ],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "outputFile", actions: ["Excel 読み取り", "Excel 書き込み"], reads: false, danger: true, status: "added", stepId: "w" });
  });
});

describe("readCheck", () => {
  it("takes the rule from the first line and the example from the rest", () => {
    expect(readCheck("金額のカンマは外して足す\n今回の例：\"6,000\" を 6,000 円として足した")).toEqual({
      rule: "金額のカンマは外して足す",
      example: "今回の例：\"6,000\" を 6,000 円として足した",
    });
    expect(readCheck("CSV はすべて読む")).toEqual({ rule: "CSV はすべて読む", example: null });
  });
});

describe("isQuestion", () => {
  it("tells a question the AI asked from a decision it stated", () => {
    expect(isQuestion("ニュースの取得元はどこにしますか？（Google ニュースなど）")).toBe(true);
    expect(isQuestion("Is it the order number?")).toBe(true);
    expect(isQuestion("ニュースは NHK NEWS WEB から取ります\n今回の例：10 件")).toBe(false);
    expect(isQuestion("ニュースは NHK から取ります\n今回の例：どれ？")).toBe(false);
  });
});
