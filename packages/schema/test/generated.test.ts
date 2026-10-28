import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { generate } from "../scripts/generate.mjs";
import type { EditOp, Scenario } from "../src";
import { isErrorPayload } from "../src";

describe("@shikigami/schema", () => {
  it("generated types match the committed Rust schemas", async () => {
    const committed = await readFile(new URL("../src/generated.ts", import.meta.url), "utf8");
    expect(await generate()).toBe(committed);
  });

  it("example scenarios type-check against the generated types", async () => {
    const raw = await readFile(new URL("../../../examples/invoice-summary.json", import.meta.url), "utf8");
    const scenario = JSON.parse(raw) as Scenario;
    expect(scenario.schemaVersion).toBe(1);
    const op: EditOp = { op: "removeStep", stepId: scenario.steps?.[0]?.id ?? "" };
    expect(op.op).toBe("removeStep");
  });

  it("recognises error payloads", () => {
    expect(isErrorPayload({ code: "REVISION_CONFLICT", message: "x" })).toBe(true);
    expect(isErrorPayload("nope")).toBe(false);
  });
});
