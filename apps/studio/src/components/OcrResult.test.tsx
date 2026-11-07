// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OcrResult, isOcrOutput } from "./OcrResult";

afterEach(cleanup);

const read = {
  text: "請求全額1,200\n合計",
  engine: "paddle",
  lines: [
    { text: "請求全額1,200", x: 0, y: 0, width: 90, height: 20, confidence: 0.42, unsure: [2, 3] },
    { text: "合計", x: 0, y: 30, width: 40, height: 20, confidence: 0.99 },
  ],
};

describe("OcrResult", () => {
  it("marks the characters OCR was unsure of and names the engine", () => {
    const { container } = render(<OcrResult value={read} />);
    const marked = [...container.querySelectorAll("mark[data-unsure]")].map((m) => m.textContent);
    expect(marked).toEqual(["全額"]);
    expect(screen.getByText("標準（PaddleOCR）")).toBeTruthy();
    expect(screen.getByText("確かめたい文字 2 個")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("99%")).toBeTruthy();
  });

  it("says when the engine gives no confidence, and shows its warning", () => {
    const windows = { engine: "windows", warning: "PaddleOCR がありません", lines: [{ text: "保存" }] };
    render(<OcrResult value={windows} />);
    expect(screen.getByText("Windows 標準 OCR")).toBeTruthy();
    expect(screen.getAllByText("PaddleOCR がありません")[0]?.tagName).toBe("P");
    expect(screen.getByText("このエンジンは信頼度を返しません")).toBeTruthy();
  });

  it("is used only for desktop.readText's output", () => {
    expect(isOcrOutput("desktop.readText", read)).toBe(true);
    expect(isOcrOutput("desktop.getValue", read)).toBe(false);
    expect(isOcrOutput("desktop.readText", "text")).toBe(false);
  });
});
