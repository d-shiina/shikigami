import { describe, expect, it } from "vitest";
import { buildRequest, chartPoint, hours, type InventoryView, oftenText, ordered, plain, WORTH_MINUTES } from "./inventory";

const view: InventoryView = {
  inventory: {
    id: "inv_1",
    title: "経理課",
    status: "interviewing",
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    tasks: [
      { id: "t1", name: "週報" },
      {
        id: "t2",
        name: "受注入力",
        description: "受注メールの Excel を販売管理に入れる",
        frequency: { times: 1, per: "day" },
        systems: ["販売管理", "Excel"],
        steps: ["メールを開く", "1 行ずつ入力"],
        ease: "high",
      },
    ],
  },
  assessment: {
    tasks: [
      { taskId: "t2", group: "first", rank: 1, priority: 16, monthlyMinutes: 1200, savableMinutes: 960, missing: [] },
      { taskId: "t1", group: "unknown", priority: 0, missing: ["frequency"] },
    ],
    monthlyMinutes: 1200,
    savableMinutes: 960,
    first: "t2",
    next: "t1",
    built: 0,
    incomplete: 1,
  },
};

describe("inventory sheet", () => {
  it("writes hours and counts as people do", () => {
    expect(hours(960)).toBe("16");
    expect(hours(43.3)).toBe("0.7");
    expect(plain(2.5)).toBe("2.5");
    expect(oftenText({ times: 1, per: "day" })).toBe("毎日 1 回");
    expect(oftenText({ times: 3, per: "week" })).toBe("週 3 回");
    expect(oftenText({ times: 1, per: "quarter" })).toBe("四半期に 1 回");
  });

  it("keeps Flow Core's order", () => {
    expect(ordered(view).map((r) => r.task.id)).toEqual(["t2", "t1"]);
  });

  it("hands the AI what was heard about the task", () => {
    const task = view.inventory.tasks?.[1];
    if (!task) throw new Error("no task");
    const text = buildRequest(view.inventory, task);
    expect(text).toContain("「受注入力」をフローに");
    expect(text).toContain("受注メールの Excel を販売管理に入れる");
    expect(text).toContain("毎日 1 回");
    expect(text).toContain("販売管理、Excel");
    expect(text).toContain("inv_1 の t2");
  });

  it("places tasks above the middle line when they save 5 hours or more", () => {
    const task = { id: "t", name: "x", ease: "high" as const };
    const above = chartPoint(task, { taskId: "t", group: "first", priority: 1, savableMinutes: WORTH_MINUTES, missing: [] }, 900);
    const below = chartPoint(task, { taskId: "t", group: "later", priority: 1, savableMinutes: 60, missing: [] }, 900);
    expect(above && above.y >= 0.5).toBe(true);
    expect(below && below.y < 0.5).toBe(true);
    expect(chartPoint({ id: "t", name: "x" }, { taskId: "t", group: "unknown", priority: 0, missing: [] }, 900)).toBeNull();
  });
});
