import { describe, expect, it } from "vitest";
import { LEGACY_NAME, LEGACY_PREFIX, PREFIX, isFormat, moveLegacyStorage } from "./legacyStorage";

function memory(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("moveLegacyStorage", () => {
  it("moves the old keys to the new ones once, keeping newer values", () => {
    const storage = memory({
      [`${LEGACY_PREFIX}theme`]: "dark",
      [`${LEGACY_PREFIX}locale`]: "en",
      [`${PREFIX}locale`]: "ja",
      other: "x",
    });
    moveLegacyStorage(storage);
    expect(storage.getItem(`${PREFIX}theme`)).toBe("dark");
    expect(storage.getItem(`${PREFIX}locale`)).toBe("ja");
    expect(storage.getItem(`${LEGACY_PREFIX}theme`)).toBeNull();
    expect(storage.getItem(`${LEGACY_PREFIX}locale`)).toBeNull();
    expect(storage.getItem("other")).toBe("x");
  });
});

describe("isFormat", () => {
  it("reads formats written under the old name", () => {
    expect(isFormat("spellsheet.config", "spellsheet.config")).toBe(true);
    expect(isFormat(`${LEGACY_NAME}.config`, "spellsheet.config")).toBe(true);
    expect(isFormat("other.config", "spellsheet.config")).toBe(false);
  });
});
