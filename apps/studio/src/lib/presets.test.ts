import { describe, expect, it } from "vitest";
import { PRESETS } from "./presets";

describe("PRESETS", () => {
  it("have unique keys and an expression that uses their function", () => {
    expect(new Set(PRESETS.map((p) => p.key)).size).toBe(PRESETS.length);
    for (const p of PRESETS) {
      expect(p.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(p.expression).toContain(p.keyword);
    }
  });
});
