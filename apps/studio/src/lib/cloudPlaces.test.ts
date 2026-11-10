import { describe, expect, it } from "vitest";
import { BOX, GOOGLE_DRIVE, ONE_DRIVE, boxTarget, cloudPlace, googleTarget, serviceOf, withCloudPlace } from "./cloudPlaces";

describe("boxTarget", () => {
  it("takes the ID from a Box link and keeps a path", () => {
    expect(boxTarget("https://app.box.com/folder/1234567?s=abc")).toBe("1234567");
    expect(boxTarget("https://example.app.box.com/folder/987")).toBe("987");
    expect(boxTarget(" /経理\\受注/ ")).toBe("経理/受注");
  });
});

describe("googleTarget", () => {
  it("takes the ID from a Drive address and keeps a path", () => {
    expect(googleTarget("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing")).toBe("1AbCdEfGhIjKlMnOp");
    expect(googleTarget("経理\\受注")).toBe("経理/受注");
  });
});

describe("OneDrive targets", () => {
  it("keeps a SharePoint link whole", () => {
    const link = "https://contoso.sharepoint.com/sites/keiri/Shared Documents/受注";
    expect(ONE_DRIVE.target(` ${link} `)).toBe(link);
    expect(ONE_DRIVE.target("/経理/受注/")).toBe("経理/受注");
  });
});

describe("cloudPlace", () => {
  it("keeps how the run signs in with the folder", () => {
    const place = cloudPlace(GOOGLE_DRIVE, {
      label: "Google ドライブ",
      secret: "Google",
      redirectUrl: "https://www.example.com/",
      folder: "経理/受注",
      pattern: " *.xlsx ",
    });
    expect(place).toEqual({
      service: "googledrive",
      label: "Google ドライブ",
      secret: "Google",
      signIn: {
        authorizeUrl: GOOGLE_DRIVE.authorizeUrl,
        tokenUrl: GOOGLE_DRIVE.tokenUrl,
        redirectUrl: "https://www.example.com/",
        scope: GOOGLE_DRIVE.scope,
        authorizeParams: { access_type: "offline", prompt: "consent" },
      },
      folder: "経理/受注",
      pattern: "*.xlsx",
    });
    expect(serviceOf(place)).toBe(GOOGLE_DRIVE);
    expect(cloudPlace(BOX, { label: "Box", secret: "Box", redirectUrl: "u", folder: "0", pattern: "" })).not.toHaveProperty("pattern");
    // Files picked in the folder take the place of a name pattern; an ID keeps the folder's name for people.
    const picked = cloudPlace(BOX, {
      label: "Box",
      secret: "Box",
      redirectUrl: "u",
      folder: "123",
      folderName: "経理/受注",
      pattern: "*.xlsx",
      files: ["受注.xlsx"],
    });
    expect(picked).toMatchObject({ folder: "123", folderName: "経理/受注", files: ["受注.xlsx"] });
    expect(picked).not.toHaveProperty("pattern");
    expect(cloudPlace(BOX, { label: "Box", secret: "Box", redirectUrl: "u", folder: "経理", folderName: "経理" })).not.toHaveProperty("folderName");
  });
});

describe("withCloudPlace", () => {
  const input = cloudPlace(BOX, { label: "Box", secret: "Box 経理", redirectUrl: "u", folder: "経理/受注" });
  const output = cloudPlace(ONE_DRIVE, { label: "OneDrive", secret: "M365", redirectUrl: "u", folder: "結果" });
  it("sets one side and keeps the other", () => {
    const text = withCloudPlace({ format: "spellsheet.cloud", input }, "output", output);
    expect(JSON.parse(text!)).toEqual({ format: "spellsheet.cloud", input, output });
  });
  it("removes a side, and the whole file when nothing is left", () => {
    expect(JSON.parse(withCloudPlace({ format: "spellsheet.cloud", input, output }, "input", null)!)).toEqual({ format: "spellsheet.cloud", output });
    expect(withCloudPlace({ format: "spellsheet.cloud", input }, "input", null)).toBeNull();
    expect(withCloudPlace(null, "output", null)).toBeNull();
  });
});
