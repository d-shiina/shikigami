// The screens use lucide icons, never emoji or picture-like symbols
// (docs/design/ui-principles.md §12). Arrows and × inside text (「A → B」,
// "Alt+↑", "640 × 480") are words, not icons, and stay allowed, and so does
// a line marked "plain text" (what is copied out to paste elsewhere).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

/**
 * Emoji (U+1F000–), the dingbats and miscellaneous symbols (✓ ✕ ✋ ✦ ⚠ ❚),
 * the geometric shapes used as marks (■ ▶ ● ○ ▾ ▸), the arrows that stand in
 * for an icon (↶ ↷ ↗ ⇥), and the emoji variation selector.
 */
const PICTURE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2190}-\u{21FF}\u{FE0F}]/u;
const TEXT_ARROWS = /[←↑→↓⇧]/gu;

describe("icons", () => {
  it("leaves emoji and symbol marks out of the screens", () => {
    const offenders = files(root).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: i + 1 }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && !line.includes("// plain text") && PICTURE.test(line.replace(TEXT_ARROWS, "")))
        .map(({ line, at }) => `${path.slice(root.length + 1)}:${at}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
