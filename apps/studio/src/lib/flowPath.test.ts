import { describe, expect, it } from "vitest";
import { inFlowFolder, shownPath } from "./flowPath";

describe("flow paths", () => {
  it("keeps the part inside the flow's folder", () => {
    expect(inFlowFolder("C:\\Users\\you\\Documents\\SpellSheet\\flows\\請求書\\input\\受注一覧.xlsx")).toBe("input/受注一覧.xlsx");
    expect(inFlowFolder("/home/you/ws/flows/請求書/templates/ひな形.docx")).toBe("templates/ひな形.docx");
  });
  it("leaves other paths as they are", () => {
    expect(inFlowFolder("\\\\fs01\\経理\\受注.xlsx")).toBeNull();
    expect(shownPath("\\\\fs01\\経理\\受注.xlsx")).toBe("\\\\fs01\\経理\\受注.xlsx");
  });
});
