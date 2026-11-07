import type { StepTypeDef } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { folderOf, insideFolder, nodeForFile } from "./fileDrop";

const types = ["excel.readRows", "file.readCsv", "file.readText", "pdf.readText", "word.readText", "word.fillTemplate", "config.read"].map(
  (type) => ({ type }) as StepTypeDef,
);

describe("insideFolder", () => {
  it("keeps a file of the flow's folder relative to it, whatever the slashes and case", () => {
    expect(insideFolder("C:\\ws\\flows\\a", "c:\\WS\\flows\\a\\input\\受注.xlsx")).toBe("input/受注.xlsx");
    expect(insideFolder("C:/ws/flows/a/", "C:/ws/flows/a/config/settings.json")).toBe("config/settings.json");
  });
  it("leaves a file elsewhere alone", () => {
    expect(insideFolder("C:\\ws\\flows\\a", "C:\\ws\\flows\\ab\\x.csv")).toBeNull();
    expect(insideFolder("C:\\ws\\flows\\a", "D:\\x.csv")).toBeNull();
    expect(insideFolder(null, "D:\\x.csv")).toBeNull();
  });
});

describe("folderOf", () => {
  it("is the folder a file is in", () => {
    expect(folderOf("input/2026/a.xlsx")).toBe("input/2026");
    expect(folderOf("C:\\data\\a.csv")).toBe("C:/data");
  });
});

describe("nodeForFile", () => {
  it("reads a file with the node for it", () => {
    expect(nodeForFile("input/受注.xlsx", types)).toEqual({ type: "excel.readRows", params: { path: "input/受注.xlsx" } });
    expect(nodeForFile("input/a.CSV", types)).toEqual({ type: "file.readCsv", params: { path: "input/a.CSV" } });
    expect(nodeForFile("input/a.tsv", types)).toEqual({ type: "file.readCsv", params: { path: "input/a.tsv", delimiter: "\t" } });
    expect(nodeForFile("input/請求書.pdf", types)?.type).toBe("pdf.readText");
    expect(nodeForFile("input/契約書.docx", types)?.type).toBe("word.readText");
    expect(nodeForFile("input/memo.txt", types)?.type).toBe("file.readText");
  });
  it("fills a template and reads a settings file", () => {
    expect(nodeForFile("templates/請求書.docx", types)).toEqual({ type: "word.fillTemplate", params: { template: "templates/請求書.docx" } });
    expect(nodeForFile("config/settings.json", types)).toEqual({ type: "config.read", params: { path: "config/settings.json" } });
  });
  it("makes nothing for a file no node reads, or a node that is not there", () => {
    expect(nodeForFile("input/logo.png", types)).toBeNull();
    expect(nodeForFile("input/a.xlsx", [])).toBeNull();
  });
});
