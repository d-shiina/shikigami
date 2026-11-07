import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { badName, freeName, mismatchText, shortValue } from "./testCases";

describe("test case words", () => {
  it("names where a run differed without paths or codes", () => {
    setLocale("ja", false);
    expect(mismatchText({ at: "outputs.rows[2].金額", expected: 100, actual: 90 })).toEqual({
      where: "出力「rows」の 3 件目の「金額」",
      expected: "100",
      actual: "90",
    });
    expect(mismatchText({ at: "status", expected: "succeeded", actual: "failed" })).toEqual({
      where: "終わり方",
      expected: "完了",
      actual: "エラーで中断",
    });
    expect(mismatchText({ at: "outputs.total", expected: 3, actual: null }).actual).toBe("（なし）");
    expect(mismatchText({ at: "errorCode", expected: "FILE_NOT_FOUND", actual: "X_UNKNOWN" }).actual).toBe("X_UNKNOWN");
  });

  it("cuts long values and finds a free name", () => {
    expect(shortValue("a".repeat(100), 10)).toHaveLength(10);
    expect(freeName(["ケース 1"])).toBe("ケース 2");
    expect(freeName(["ケース 2"])).toBe("ケース 3");
    expect(badName("a/b")).toBe(true);
    expect(badName("3支店の合計")).toBe(false);
  });
});
