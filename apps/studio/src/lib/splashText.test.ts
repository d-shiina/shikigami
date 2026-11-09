import { describe, expect, it } from "vitest";
import { splashText } from "./splashText";

describe("splashText", () => {
  it("follows the language chosen in Writer", () => {
    expect(splashText("en", "ja-JP", "0.1.16").tagline).toBe("Built by AI. Runs without it.");
    expect(splashText("ja", "en-US", "0.1.16").version).toBe("バージョン 0.1.16");
  });

  it("follows the OS when nothing was chosen", () => {
    expect(splashText(null, "ja-JP", null).lang).toBe("ja");
    expect(splashText("system", "en-GB", null).lang).toBe("en");
    expect(splashText(undefined, undefined, null).lang).toBe("ja");
  });

  it("leaves the version out when it is not known", () => {
    expect(splashText("ja", "ja", "").version).toBe("");
    expect(splashText("en", "en", "1.2.3").version).toBe("Version 1.2.3");
  });
});
