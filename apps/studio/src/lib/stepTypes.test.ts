import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BINDS } from "./stepTypes";

// The built-in nodes as the CLI and MCP describe them (kept current by a Rust test).
const contract = JSON.parse(readFileSync(new URL("../../../../schemas/contract/step-types.json", import.meta.url), "utf8")) as {
  stepTypes: { type: string; bindsVariables?: string[] }[];
};

describe("BINDS", () => {
  it("is the registry's bindsVariables", () => {
    const fromRegistry = Object.fromEntries(contract.stepTypes.filter((d) => d.bindsVariables?.length).map((d) => [d.type, d.bindsVariables]));
    expect(BINDS).toEqual(fromRegistry);
  });
});
