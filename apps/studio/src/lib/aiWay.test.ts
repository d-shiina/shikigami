import { describe, expect, it } from "vitest";
import { BRANDS, FOLLOW_UPS, guess, pickFor } from "./aiWay";

describe("which AI the person uses", () => {
  it("leads every name somewhere", () => {
    for (const brand of BRANDS) expect(pickFor(brand).kind).toMatch(/agent|paste|ask|unknown/);
  });

  it("uses Microsoft Copilot through its chat, and asks where for names that are both", () => {
    expect(pickFor("msCopilot")).toEqual({ kind: "ask", question: "copilot" });
    expect(FOLLOW_UPS.copilot.every((p) => p.kind === "paste")).toBe(true);
    expect(FOLLOW_UPS.claude[1]).toEqual({ kind: "agent", agent: "claudeCode" });
    expect(pickFor("githubCopilot")).toEqual({ kind: "agent", agent: "copilot" });
  });

  it("not sure: an AI already on this PC, else the chat", () => {
    expect(guess(["codex"])).toEqual({ kind: "agent", agent: "codex" });
    expect(guess([])).toEqual({ kind: "paste", chat: "other" });
  });
});
