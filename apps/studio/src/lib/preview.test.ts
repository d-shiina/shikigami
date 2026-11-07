import { afterEach, describe, expect, it } from "vitest";
import { filePath, imageData, loadPreview, previewSource, setPreviewReader, sizeText } from "./preview";

const PNG = `iVBORw0KGgo${"A".repeat(80)}`;

describe("previewSource", () => {
  it("takes a path to a picture, a table or a text file, relative or full", () => {
    expect(previewSource("templates/ok.png")).toEqual({ kind: "file", path: "templates/ok.png" });
    expect(previewSource("C:\\work\\shot.JPG")).toEqual({ kind: "file", path: "C:\\work\\shot.JPG" });
    expect(previewSource("input/orders.xlsx", { sheet: "明細" })).toEqual({ kind: "file", path: "input/orders.xlsx", sheet: "明細" });
    expect(previewSource('"input/a.csv"')).toEqual({ kind: "file", path: "input/a.csv" });
  });

  it("leaves paths it cannot read alone", () => {
    expect(filePath("output/{{ name }}.png")).toBeNull();
    expect(filePath("https://example.com/a.png")).toBeNull();
    expect(filePath("archive.zip")).toBeNull();
    expect(filePath("a.png\nb.png")).toBeNull();
    expect(previewSource(42)).toBeNull();
    expect(previewSource("hello")).toBeNull();
  });

  it("finds the picture of a place given by a picture, and a file in a result", () => {
    expect(previewSource({ window: { title: "請求" }, image: { path: "templates/save.png", threshold: 0.9 } })).toEqual({ kind: "file", path: "templates/save.png" });
    expect(previewSource({ path: "output/shot.png", width: 800 })).toEqual({ kind: "file", path: "output/shot.png" });
    expect(previewSource({ role: "button", name: "保存" })).toBeNull();
  });

  it("shows a picture's own data", () => {
    expect(imageData(PNG)).toBe(`data:image/png;base64,${PNG}`);
    expect(imageData("data:image/jpeg;base64,/9j/abc")).toBe("data:image/jpeg;base64,/9j/abc");
    expect(previewSource(PNG)).toEqual({ kind: "imageData", src: `data:image/png;base64,${PNG}` });
    // Base64 of something else is just text.
    expect(imageData("SGVsbG8gd29ybGQ".repeat(10))).toBeNull();
    expect(imageData(`Qk${"A".repeat(80)}`)).toBeNull();
  });

  it("shows a long text whole only when asked", () => {
    const long = "あ".repeat(60);
    expect(previewSource(long)).toBeNull();
    expect(previewSource(long, { longText: true })).toEqual({ kind: "text", text: long });
    expect(previewSource("一行目\n二行目", { longText: true })).toEqual({ kind: "text", text: "一行目\n二行目" });
    expect(previewSource("短い", { longText: true })).toBeNull();
  });
});

describe("loadPreview", () => {
  afterEach(() => setPreviewReader(async () => ({ kind: "missing" })));

  it("reads a file once while it is fresh, and says why when it cannot", async () => {
    let reads = 0;
    setPreviewReader(async (_id, path) => {
      reads += 1;
      if (path === "bad.csv") throw new Error("denied");
      return { kind: "table", columns: ["a"], rows: [["1"]], more: false };
    });
    const first = await loadPreview("f1", "input/a.csv");
    await loadPreview("f1", "input/a.csv");
    expect(first.preview.kind).toBe("table");
    expect(reads).toBe(1);
    // Another flow's file of the same name is another file.
    await loadPreview("f2", "input/a.csv");
    expect(reads).toBe(2);
    expect((await loadPreview("f1", "bad.csv")).preview).toEqual({ kind: "unreadable", message: "denied" });
  });

  it("keeps the shrunk picture, not the file's bytes", async () => {
    setPreviewReader(async () => ({ kind: "image", mime: "image/png", data: PNG, bytes: 120 }));
    const loaded = await loadPreview("f1", "templates/ok.png");
    expect(loaded.preview).toMatchObject({ kind: "image", data: "" });
    expect(loaded.picture?.src).toBe(`data:image/png;base64,${PNG}`);
  });
});

it("writes file sizes for people", () => {
  expect(sizeText(512)).toBe("512 B");
  expect(sizeText(2048)).toBe("2.0 KB");
  expect(sizeText(5 * 1024 * 1024)).toBe("5.0 MB");
});
