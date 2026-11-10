import type { ValidationIssue } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../agent";
import { answersText, stuckIssues } from "./handoffFollow";

const issue = (code: string, stepId: string): ValidationIssue => ({ severity: "error", code, message: code, path: `/steps/${stepId}`, stepId });
const taken = (id: string, flowId: string, forAi: ValidationIssue[]): ChatItem =>
  ({
    role: "ai",
    id,
    turnId: id,
    parts: [],
    status: "done",
    preparing: null,
    message: null,
    needsLogin: false,
    handoff: { prompt: "p", result: { kind: "taken", flowId, name: "n", isNew: false, revision: 1, changes: [], forAi, checks: 0 } },
  }) as ChatItem;

describe("answers to the AI's questions", () => {
  it("sends only what was answered, with what is right for a no", () => {
    const text = answersText(["締め日は月末\n例：10/31", "宛先は経理", "件名に日付"], { "締め日は月末\n例：10/31": "ok", 宛先は経理: "no" }, { 宛先は経理: " 総務 " });
    expect(text).toContain("「締め日は月末」→ そのとおりです");
    expect(text).toContain("「宛先は経理」→ 違います。正しくは：総務");
    expect(text).not.toContain("件名に日付");
  });

  it("is nothing until one is answered", () => {
    expect(answersText(["a"], {}, {})).toBeNull();
  });
});

describe("the same problem coming back", () => {
  it("is offered for a hand fix after three take-ins in a row", () => {
    const a = issue("MISSING_PARAM", "s1");
    const b = issue("BAD_EXPR", "s2");
    const items = [taken("1", "f", [a]), taken("2", "f", [a, b]), taken("3", "g", [b]), taken("4", "f", [a, b])];
    expect(stuckIssues(items, "f")).toEqual([{ issue: a, times: 3 }]);
    expect(stuckIssues(items.slice(0, 3), "f")).toEqual([]);
  });

  it("starts again when a take-in did not have it", () => {
    const a = issue("MISSING_PARAM", "s1");
    const items = [taken("1", "f", [a]), taken("2", "f", [a]), taken("3", "f", []), taken("4", "f", [a])];
    expect(stuckIssues(items, "f")).toEqual([]);
  });
});
