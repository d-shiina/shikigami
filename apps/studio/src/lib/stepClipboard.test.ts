import type { Step } from "@shikigami/schema";
import { describe, expect, it } from "vitest";
import { copyText, partOps, readCopied, siblingRange, withNewIds } from "./stepClipboard";

const steps: Step[] = [
  { id: "a", type: "log.message" },
  {
    id: "loop",
    type: "control.forEach",
    params: { items: "rows", itemVar: "row" },
    blocks: { body: [{ id: "b", type: "browser.click", params: { target: { part: "save" } } }, { id: "c", type: "log.message" }] },
  },
  { id: "d", type: "log.message" },
];

describe("node clipboard", () => {
  it("writes the nodes with the parts they use and reads them back", () => {
    const parts = { save: { label: "保存", app: "browser", target: { role: "button", name: "保存" } }, other: { app: "browser", target: { css: "#x" } } };
    const text = copyText([steps[1]!], parts as never);
    const read = readCopied(text)!;
    expect(read.steps).toEqual([steps[1]]);
    expect(Object.keys(read.parts)).toEqual(["save"]);
    // Only the parts the flow lacks are added; its own stay as they are.
    expect(partOps(read, {})).toEqual([{ op: "setPart", name: "save", part: parts.save }]);
    expect(partOps(read, { save: parts.other } as never)).toEqual([]);
  });

  it("takes a step, a list of steps or a whole flow, and nothing else", () => {
    expect(readCopied(JSON.stringify({ type: "log.message" }))?.steps).toHaveLength(1);
    expect(readCopied(JSON.stringify(steps))?.steps).toHaveLength(3);
    expect(readCopied(JSON.stringify({ name: "x", steps }))?.steps).toHaveLength(3);
    expect(readCopied("こんにちは")).toBeNull();
    expect(readCopied("[1, 2]")).toBeNull();
    expect(readCopied("{}")).toBeNull();
  });

  it("gives every copied node and its children a new ID", () => {
    let n = 0;
    const copy = withNewIds(steps[1]!, () => `new${++n}`);
    expect(copy.id).toBe("new1");
    expect(copy.blocks?.body?.map((s) => s.id)).toEqual(["new2", "new3"]);
    expect(steps[1]!.blocks?.body?.[0]?.id).toBe("b");
  });

  it("picks the run of siblings between two nodes, either way round", () => {
    expect(siblingRange(steps, "a", "d")).toEqual(["a", "loop", "d"]);
    expect(siblingRange(steps, "d", "loop")).toEqual(["loop", "d"]);
    expect(siblingRange(steps, "a", "b")).toBeNull();
  });
});
