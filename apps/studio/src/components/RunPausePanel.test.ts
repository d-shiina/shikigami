import { describe, expect, it } from "vitest";
import { editedValue } from "./RunPausePanel";

describe("editedValue", () => {
  it("keeps text as text for a text variable", () => {
    expect(editedValue("123", "abc")).toBe("123");
    expect(editedValue("", "abc")).toBe("");
  });
  it("reads other values as JSON", () => {
    expect(editedValue("42", 1)).toBe(42);
    expect(editedValue("false", true)).toBe(false);
    expect(editedValue("[1, 2]", [])).toEqual([1, 2]);
    expect(editedValue('{"a": 1}', {})).toEqual({ a: 1 });
  });
  it("refuses what is not a value of that kind", () => {
    expect(editedValue("abc", 1)).toBeUndefined();
  });
  it("takes plain text for a variable with no value yet", () => {
    expect(editedValue("abc", null)).toBe("abc");
    expect(editedValue("7", null)).toBe(7);
  });
});
