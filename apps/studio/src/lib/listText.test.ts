import { describe, expect, it } from "vitest";
import { listToText, textToList } from "./listText";

describe("case values as a line of text", () => {
  it("reads words, numbers and booleans", () => {
    expect(textToList("A, B、10, -2.5, true")).toEqual(["A", "B", 10, -2.5, true]);
    expect(textToList("  東京 ,大阪 ")).toEqual(["東京", "大阪"]);
    expect(textToList("")).toEqual([]);
  });

  it("keeps quoted text as text", () => {
    expect(textToList('"10", "a, b", "say ""hi"""')).toEqual(["10", "a, b", 'say "hi"']);
  });

  it("writes back what it reads", () => {
    for (const values of [["A", "B"], [1, 2], ["10", "a, b", " x", ""], [true, null], ["{{ code }}"]]) {
      expect(textToList(listToText(values))).toEqual(values);
    }
    expect(listToText(["A", 1, "1"])).toBe('A, 1, "1"');
  });
});
