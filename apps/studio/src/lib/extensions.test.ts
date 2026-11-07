import type { StepTypeDef } from "@shikigami/schema";
import { afterEach, describe, expect, it } from "vitest";
import { effects } from "./effects";
import { credentialFor, registerExtensions } from "./extensions";
import { EXTENSION_ICONS, groupIcon, nodeIcon } from "./nodeIcons";
import { choiceLabel, paramLabel } from "./nodeRows";
import { appTag, groupLabel, groupOf, groups, paletteItems, stepSummary } from "./palette";

const ocr: StepTypeDef = {
  type: "azureocr.readDocument",
  category: "other",
  label: "AI-OCR の読み取り",
  description: "Sends the file to Azure.",
  risk: "interactive",
  secretParams: ["key"],
  paramsSchema: {
    type: "object",
    properties: {
      endpoint: { type: "string", title: "エンドポイント" },
      key: { type: "string", title: "API キー" },
      path: { type: "string", title: "ファイル" },
      model: { type: "string", enum: ["prebuilt-read", "prebuilt-invoice"], title: "読み取りの種類", "x-enumLabels": { "prebuilt-invoice": "請求書の項目" } },
    },
  },
  plugin: {
    name: "azureocr",
    version: "0.1.0",
    label: "Azure AI-OCR",
    tag: "AI-OCR",
    summary: "画像や PDF を AI-OCR で読み取ります",
    icon: "scan-text",
    credentials: [{ kind: "apiKey", label: "Azure のキー", params: ["key"] }],
    external: { service: "Azure AI Document Intelligence", data: "読み取るファイル", param: "endpoint" },
  },
};
const builtin: StepTypeDef = { type: "browser.open", category: "browser", label: "ページ表示", description: "", risk: "interactive", paramsSchema: {} };

afterEach(() => registerExtensions([]));

describe("extension nodes", () => {
  it("are listed under their extension, with its tag and icon", () => {
    registerExtensions([builtin, ocr]);
    expect(groupOf(ocr)).toBe("ext:azureocr");
    expect(groupLabel("ext:azureocr")).toBe("Azure AI-OCR");
    // People read the manifest's summary, not the description written for AI.
    expect(stepSummary(ocr.type, ocr.description)).toBe("画像や PDF を AI-OCR で読み取ります");
    expect(groups(paletteItems([builtin, ocr])).map(([g]) => g)).toContain("ext:azureocr");
    expect(appTag(ocr, ocr.label)).toBeNull(); // the name already says AI-OCR
    expect(appTag(ocr, "読み取り")).toBe("AI-OCR");
    expect(nodeIcon(ocr.type, "other")).toBe(EXTENSION_ICONS["scan-text"]);
    expect(groupIcon("ext:azureocr")).toBe(EXTENSION_ICONS["scan-text"]);
    // Built-in nodes are unchanged.
    expect(groupOf(builtin)).toBe("browser");
  });

  it("name settings and choices as their manifest does", () => {
    registerExtensions([ocr]);
    expect(paramLabel("endpoint", ocr.type)).toBe("エンドポイント");
    expect(choiceLabel("model", "prebuilt-invoice", ocr.type)).toBe("請求書の項目");
    expect(choiceLabel("model", "prebuilt-read", ocr.type)).toBe("prebuilt-read");
    expect(credentialFor(ocr, "key")?.kind).toBe("apiKey");
    expect(credentialFor(ocr, "path")).toBeUndefined();
  });

  it("show on the review panel what they send outside, and where", () => {
    registerExtensions([ocr]);
    const [effect] = effects(
      [{ id: "o", type: ocr.type, params: { endpoint: "https://acme.cognitiveservices.azure.com", path: "input/a.pdf" } }],
      new Map([["o", "added"]]),
      [],
      new Map([[ocr.type, ocr]]),
    );
    expect(effect).toMatchObject({
      target: "https://acme.cognitiveservices.azure.com",
      external: { service: "Azure AI Document Intelligence", data: "読み取るファイル" },
      reads: false,
    });
  });
});
