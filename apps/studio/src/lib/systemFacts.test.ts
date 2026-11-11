import type { Flow, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import { systemFacts } from "./systemFacts";

const defs = new Map<string, StepTypeDef>([
  ["excel.readRange", { type: "excel.readRange", risk: "safe" } as unknown as StepTypeDef],
  ["excel.writeRange", { type: "excel.writeRange", risk: "caution" } as unknown as StepTypeDef],
]);

const flow: Flow = {
  schemaVersion: 1,
  id: "scn_a",
  name: "a",
  variables: [
    { name: "day", type: "string", direction: "input" },
    { name: "total", type: "number", direction: "output" },
  ],
  steps: [
    { id: "s1", type: "browser.open", params: { url: "https://orders.example.co.jp/login" }, timeoutMs: 30000, retry: { maxAttempts: 3 } },
    { id: "s2", type: "browser.fill", params: { target: { label: "パスワード" }, value: { secret: "受注システム", field: "password" } } },
    { id: "s3", type: "excel.readRange", params: { path: "input/in.xlsx", sheet: "{{ day }}" }, saveAs: "rows" },
    { id: "s4", type: "excel.writeRange", params: { path: "output/out.xlsx", values: "{{ rows }}" }, saveAs: "total" },
  ],
} as Flow;

describe("systemFacts", () => {
  const facts = systemFacts(flow, defs);
  it("says where a step connects, how long it waits and how often it tries", () => {
    expect(facts.get("s1")).toEqual([
      { kind: "connect", host: "orders.example.co.jp" },
      { kind: "wait", seconds: 30 },
      { kind: "retry", attempts: 3 },
    ]);
  });
  it("names the secret a step uses, never its value", () => {
    expect(facts.get("s2")).toEqual([{ kind: "secret", name: "受注システム" }]);
  });
  it("tells a file read from one written, and follows a value from step to step", () => {
    expect(facts.get("s3")).toEqual([
      { kind: "read", path: "input/in.xlsx" },
      { kind: "take", variable: "day", from: null },
      { kind: "give", variable: "rows", to: ["s4"], out: false },
    ]);
    expect(facts.get("s4")).toEqual([
      { kind: "write", path: "output/out.xlsx" },
      { kind: "give", variable: "total", to: [], out: true },
      { kind: "take", variable: "rows", from: "s3" },
    ]);
  });
});
