import { describe, expect, it } from "vitest";
import { stepHelpJa } from "./locales/stepHelp.ja";

// docs/design/wording.md: words the screen does not use. A node's one-line
// summary in the palette follows it; the search words may keep them.
const BANNED = ["入れる", "足す", "飛ば", "止める", "頼む", "やめる", "ループ", "手直し"];

describe("wording", () => {
  it("keeps the palette's summaries to the wording rules", () => {
    const found = Object.entries(stepHelpJa).flatMap(([type, help]) => BANNED.filter((w) => help.summary.includes(w)).map((w) => `${type}: ${w}`));
    expect(found).toEqual([]);
  });
});
