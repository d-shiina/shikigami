import type { Flow, Part, ProjectFiles, StepTypeDef } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import {
  cleanUp,
  imageOf,
  imagePartOps,
  inProject,
  missingImages,
  newImageLabel,
  newImagePart,
  offsetAt,
  partChoices,
  partKind,
  reshot,
  takesImage,
  unusedParts,
  withImage,
} from "./imageParts";

const win = { process: "billing.exe" };
const imagePart = (path = "templates/image1.png"): Part => ({ app: "desktop", label: "保存ボタン", target: { window: win, image: { path } } }) as unknown as Part;
const buttonPart: Part = { app: "desktop", label: "保存", target: { window: win, element: { id: "btnSave" } } } as unknown as Part;
const files = (...paths: string[]): ProjectFiles => ({ flowId: "scn_a", files: paths.map((path) => ({ path, size: 1 })) }) as unknown as ProjectFiles;
const def = (type: string, image: boolean): StepTypeDef =>
  ({
    type,
    paramsSchema: { properties: { target: { properties: { window: {}, ...(image ? { image: {} } : {}) } } } },
  }) as unknown as StepTypeDef;

describe("image parts", () => {
  it("are desktop parts that find a picture, so the file format stays as it is", () => {
    expect(imageOf(imagePart())).toEqual({ path: "templates/image1.png" });
    expect(partKind(imagePart())).toBe("image");
    expect(partKind(buttonPart)).toBe("desktop");
    expect(imageOf({ app: "browser", target: { image: { path: "x.png" } } } as unknown as Part)).toBeUndefined();
  });

  it("are offered only to nodes that find their place by a picture", () => {
    const parts = { image1: imagePart(), save: buttonPart };
    expect(takesImage(def("desktop.mouseClick", true))).toBe(true);
    expect(partChoices(parts, "desktop", def("desktop.mouseClick", true)).map(([n]) => n)).toEqual(["image1", "save"]);
    expect(partChoices(parts, "desktop", def("desktop.click", false)).map(([n]) => n)).toEqual(["save"]);
  });

  it("get a key and a file in templates/ that nothing else has", () => {
    expect(newImagePart(["image1"], files("templates/image2.png"))).toEqual({ name: "image3", path: "templates/image3.png" });
    expect(newImageLabel({ a: { ...imagePart(), label: "画像 1" } as Part }, "画像")).toBe("画像 2");
  });

  it("point the node at the new part in the same edit", () => {
    const step = { id: "s1", type: "desktop.mouseClick", params: { target: { window: win }, button: "left" } };
    expect(imagePartOps(step, "image1", "保存ボタン", win, "templates/image1.png")).toEqual([
      { op: "setPart", name: "image1", part: { app: "desktop", label: "保存ボタン", target: { window: win, image: { path: "templates/image1.png" } } } },
      { op: "updateStep", stepId: "s1", patch: { replaceParams: { target: { part: "image1" }, button: "left" } } },
    ]);
  });

  it("keep their file when retaken, and drop settings back to the default", () => {
    const part = withImage(imagePart(), { threshold: 0.8 }, { x: 12, y: -3 });
    expect(part.target).toEqual({ window: win, image: { path: "templates/image1.png", threshold: 0.8 }, offset: { x: 12, y: -3 } });
    expect(withImage(part, { threshold: undefined }, { x: 0, y: 0 }).target).toEqual({ window: win, image: { path: "templates/image1.png" } });
    expect(reshot(part, { process: "other.exe" }).target).toMatchObject({ window: { process: "other.exe" }, image: { path: "templates/image1.png", threshold: 0.8 } });
  });

  it("turn a click on the shown picture into pixels from its centre", () => {
    // A 100 × 40 picture shown at 50 × 20: the top-left corner.
    expect(offsetAt(0, 0, 50, 20, 100, 40)).toEqual({ x: -50, y: -20 });
    expect(offsetAt(25, 10, 50, 20, 100, 40)).toEqual({ x: 0, y: 0 });
  });

  it("are cleaned up with their pictures, unless something else names the picture", () => {
    const flow = {
      parts: { image1: imagePart(), image2: imagePart("templates/shared.png"), save: buttonPart, used: imagePart("templates/used.png") },
      steps: [
        { id: "s1", type: "desktop.mouseClick", params: { target: { part: "used" } } },
        { id: "s2", type: "desktop.waitFor", params: { target: { window: win, image: { path: "templates\\shared.png" } } } },
      ],
    } as unknown as Flow;
    expect(unusedParts(flow)).toEqual(["image1", "image2", "save"]);
    const plan = cleanUp(flow, unusedParts(flow));
    expect(plan.ops).toEqual([
      { op: "removePart", name: "image1" },
      { op: "removePart", name: "image2" },
      { op: "removePart", name: "save" },
    ]);
    expect(plan.files).toEqual(["templates/image1.png"]);
  });

  it("whose picture is missing are a person's to cut out", () => {
    const flow = { parts: { image1: imagePart(), full: imagePart("C:\\RPA\\a.png"), save: buttonPart }, steps: [] } as unknown as Flow;
    expect(missingImages(flow, files())).toEqual(["image1"]);
    expect(missingImages(flow, files("templates/image1.png"))).toEqual([]);
    expect(missingImages(flow, null)).toEqual([]);
  });

  it("know which pictures Writer can keep in the flow's folder", () => {
    expect(inProject("templates/image1.png")).toBe(true);
    expect(inProject("templates\\a.png")).toBe(true);
    expect(inProject("C:\\RPA\\a.png")).toBe(false);
    expect(inProject("/home/a.png")).toBe(false);
    expect(inProject("../other/a.png")).toBe(false);
  });
});
