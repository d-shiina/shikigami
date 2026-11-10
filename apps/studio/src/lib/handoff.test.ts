import type { Flow } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { composeRequest, INTERVIEW_HEAD, isOwnRequest, joinParts, looksLikeAnswer } from "./handoff";

const flow = { schemaVersion: 1, id: "scn_a", name: "集計", revision: 3, steps: [{ id: "s1", type: "log.message", name: "記録", params: { message: "a" } }] } as unknown as Flow;

describe("the request for an AI chat", () => {
  it("carries the instructions, the flow as it is now and the request", () => {
    const text = composeRequest("件名も書いて", "INSTRUCTIONS", flow, "s1");
    expect(isOwnRequest(text)).toBe(true);
    expect(text).toContain("INSTRUCTIONS");
    expect(text).toContain("```json");
    expect(text).toContain('"log.message"');
    expect(text).toContain("件名も書いて");
    expect(text).toContain("s1");
  });

  it("asks for a new flow when there is none", () => {
    const text = composeRequest("作って", "INSTRUCTIONS", null);
    expect(text).not.toContain("```json\n");
    expect(text).toContain("新しいフローを作ります");
  });
});

describe("what comes back", () => {
  it("tells an AI's answer from Writer's own request and from other text", () => {
    expect(looksLikeAnswer('はい。\n```json\n{"format":"spellsheet.answer","flow":{}}\n```')).toBe(true);
    expect(looksLikeAnswer('{"name":"x","steps":[]}')).toBe(true);
    expect(looksLikeAnswer(composeRequest('"steps": [', "", null))).toBe(false);
    expect(looksLikeAnswer("こんにちは")).toBe(false);
  });

  it("puts the rest of a cut answer after what came before", () => {
    const before = '```json\n{"steps": [{"type": "log.mes';
    const more = 'つづきです。\n```json\nsage"}]}\n```\n以上です。';
    expect(joinParts(before, more)).toBe('```json\n{"steps": [{"type": "log.message"}]}\n\n```\n');
    // Cut short again: still open, so a third part joins it too.
    const second = joinParts(before, '```json\nsage"}, {"type": "log.');
    expect(second).toBe('```json\n{"steps": [{"type": "log.message"}, {"type": "log.');
    expect(joinParts(second, '```json\nmessage"}]}\n```')).toBe('```json\n{"steps": [{"type": "log.message"}, {"type": "log.message"}]}\n\n```\n');
  });
});

describe("the interview Writer copies (業務の棚卸し)", () => {
  // The guide holds an example record in the answer's format; copied by Writer, it is not the AI's answer.
  const source = readFileSync(new URL("../../../../crates/spellsheet-core/src/inventory.rs", import.meta.url), "utf8");
  const guide = /pub const CHAT_GUIDE: &str = r#"([\s\S]*?)"#;/.exec(source)?.[1] ?? "";

  it("is not offered for taking in", () => {
    expect(guide.startsWith(INTERVIEW_HEAD)).toBe(true);
    expect(guide).toContain("spellsheet.inventory");
    expect(looksLikeAnswer(guide)).toBe(false);
    expect(looksLikeAnswer(`${guide}\n## The record so far\n{"format":"spellsheet.inventory"}`)).toBe(false);
  });

  it("still offers the record the AI writes", () => {
    expect(looksLikeAnswer('Here it is:\n```json\n{"format":"spellsheet.inventory","tasks":[]}\n```')).toBe(true);
  });
});
