import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { SAMPLES, tutorialUrl } from "./samples";

afterEach(() => setLocale("ja", false));

describe("samples", () => {
  it("open bundles Writer can import", async () => {
    for (const sample of SAMPLES.filter((s) => s.bundle)) {
      const bundle = JSON.parse(await sample.bundle!());
      expect(bundle.format, sample.id).toBe("shikigami.flowBundle");
      expect(bundle.flow.id, sample.id).toMatch(/^scn_tutorial_/);
    }
  });

  it("link the tutorial in Writer's language", () => {
    expect(tutorialUrl("invoices")).toBe("https://github.com/d-shiina/shikigami/blob/main/docs/ja/tutorials/invoices.md");
    setLocale("en", false);
    expect(tutorialUrl()).toBe("https://github.com/d-shiina/shikigami/blob/main/docs/tutorials/README.md");
  });
});
