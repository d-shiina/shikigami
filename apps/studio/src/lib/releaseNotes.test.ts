import { describe, expect, it } from "vitest";
import { releaseNotes } from "./releaseNotes";

describe("releaseNotes", () => {
  it("drops the installer footer the release workflow adds", () => {
    const body = [
      "## 0.1.10（2026-11-07）",
      "",
      "### 主な変更",
      "",
      "- **Word** のノード",
      "",
      "---",
      "",
      "Install: download `SpellSheet Studio_0.1.10_x64-setup.exe` below (per user, no administrator rights).",
      "Installed copies of Studio update themselves on their next launch.",
    ].join("\r\n");
    expect(releaseNotes(body)).toBe("## 0.1.10（2026-11-07）\n\n### 主な変更\n\n- **Word** のノード");
  });

  it("keeps notes without the footer as they are", () => {
    expect(releaseNotes("### 主な変更\n\n- a\n\n---\n\n- b\n")).toBe("### 主な変更\n\n- a\n\n---\n\n- b");
  });
});
