import { describe, expect, it } from "vitest";
import { blankWhen, describeWhen, isTime, normalizeDays, shortTime, whenProblem } from "./schedule";

describe("schedule", () => {
  it("says when a schedule fires", () => {
    expect(describeWhen({ kind: "daily", at: "08:00" })).toBe("毎日 08:00");
    expect(describeWhen({ kind: "daily", at: "08:00", days: ["wed", "mon"] })).toBe("毎週 月・水 の 08:00");
    expect(describeWhen({ kind: "monthly", day: -1, at: "18:00" })).toBe("毎月 月末 の 18:00");
    expect(describeWhen({ kind: "monthly", day: 25, at: "09:00" })).toBe("毎月 25 日 の 09:00");
    expect(describeWhen({ kind: "every", minutes: 30, from: "09:00", to: "18:00" })).toBe("09:00〜18:00 に 30 分ごと");
    expect(describeWhen({ kind: "once", at: "2026-11-07T08:00" })).toBe("2026-11-07 08:00 に 1 回");
    expect(describeWhen({ kind: "fileAdded", folder: "input", pattern: "*.xlsx" })).toBe("input に *.xlsx が届いたら");
  });

  it("says how holidays are treated", () => {
    expect(describeWhen({ kind: "daily", at: "08:00", days: ["mon", "fri"], skipHolidays: true })).toBe(
      "毎週 月・金 の 08:00（祝日・会社の休日を除く）",
    );
    expect(describeWhen({ kind: "monthly", day: 3, at: "09:00", businessDay: true })).toBe("毎月 第 3 営業日 の 09:00");
    expect(describeWhen({ kind: "monthly", day: -1, at: "18:00", businessDay: true })).toBe("毎月 最終営業日 の 18:00");
    expect(describeWhen({ kind: "monthly", day: 25, at: "09:00", onHoliday: "before" })).toBe("毎月 25 日 の 09:00（休日なら前の営業日）");
  });

  it("checks what the agent would refuse", () => {
    expect(isTime("8:00")).toBe(true);
    expect(isTime("24:00")).toBe(false);
    expect(isTime("8")).toBe(false);
    expect(whenProblem({ kind: "every", minutes: 0 })).not.toBeNull();
    expect(whenProblem({ kind: "fileAdded", folder: " ", pattern: "*" })).not.toBeNull();
    for (const kind of ["daily", "monthly", "every", "once", "fileAdded"] as const) {
      expect(whenProblem(blankWhen(kind))).toBeNull();
    }
  });

  it("shortens the agent's times", () => {
    expect(shortTime("2026-11-07T08:00:00+09:00")).toBe("11/7 08:00");
  });
});

describe("normalizeDays", () => {
  it("reads the spellings the agent accepts", () => {
    expect(normalizeDays(["月", "Wed", " fri ", "x", "mon"])).toEqual(["mon", "wed", "fri"]);
    expect(describeWhen({ kind: "daily", at: "08:00", days: ["月"] })).toBe(describeWhen({ kind: "daily", at: "08:00", days: ["mon"] }));
  });
});
