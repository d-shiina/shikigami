// The files and systems a flow works with, for the review report: one row per
// target, said as a kind (入力ファイル, 出力ファイル, Web サイト …) and what each run
// does to it. Read from the flow's effects; display only.
import type { Effect } from "./effects";
import { fillTarget, type InputRow } from "./approval";
import { filePath } from "./preview";

export type UsedKind = "inputFile" | "inputFolder" | "outputFile" | "outputFolder" | "site" | "service" | "other";

export type UsedRow = {
  kind: UsedKind;
  /** The file, folder, URL or command, with the starting values filled in. */
  target: string;
  /** The nodes' names for what they do to it, e.g. "Excel 書き込み". */
  actions: string[];
  /** Nothing is changed: every node on it only reads. */
  reads: boolean;
  danger: boolean;
  status: Effect["status"];
  stepId: string;
  external?: Effect["external"];
  /** A path the report can show the content of. */
  preview: string | null;
  /** The place is only known while the flow runs (an expression the starting values do not settle). */
  atRun: boolean;
};

const EXTENSION = /\.[A-Za-z0-9]{1,5}$/;
/** A program or command line rather than a place: `robocopy a b /e`, `C:\\tools\\x.exe`. */
const COMMAND = /\s|\.(exe|bat|cmd|ps1|sh)$/i;

function kindOf(e: Effect, target: string): UsedKind {
  if (e.external) return "service";
  if (/^https?:/i.test(target)) return "site";
  if (!target || target.includes("{{") || (COMMAND.test(target) && !EXTENSION.test(target.replace(/\.(exe|bat|cmd|ps1|sh)$/i, "")))) return target.includes("{{") && e.reads ? "inputFile" : "other";
  if (EXTENSION.test(target)) return e.reads ? "inputFile" : "outputFile";
  return e.reads ? "inputFolder" : "outputFolder";
}

const STATUS_ORDER: Effect["status"][] = ["added", "changed", "removed", "same"];

/** One row per target; a file that is read and written is an output file. */
export function usedRows(effects: Effect[], values: InputRow[]): UsedRow[] {
  const rows = new Map<string, UsedRow>();
  for (const e of effects) {
    const target = fillTarget(e.target, values);
    const kind = kindOf(e, target);
    const key = `${e.status === "removed" ? "removed:" : ""}${target || e.action}`;
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        kind,
        target,
        actions: [e.action],
        reads: e.reads,
        danger: e.risk === "dangerous",
        status: e.status,
        stepId: e.stepId,
        ...(e.external ? { external: e.external } : {}),
        preview: kind === "inputFile" || kind === "outputFile" ? filePath(target) : null,
        atRun: target.includes("{{"),
      });
      continue;
    }
    if (!row.actions.includes(e.action)) row.actions.push(e.action);
    if (!e.reads) {
      // The first node that changes it is the one to open.
      if (row.reads) row.stepId = e.stepId;
      row.reads = false;
      if (row.kind === "inputFile") row.kind = "outputFile";
      if (row.kind === "inputFolder") row.kind = "outputFolder";
    }
    row.danger ||= e.risk === "dangerous";
    if (STATUS_ORDER.indexOf(e.status) < STATUS_ORDER.indexOf(row.status)) row.status = e.status;
  }
  const order: UsedKind[] = ["inputFolder", "inputFile", "outputFolder", "outputFile", "site", "service", "other"];
  const all = [...rows.values()];
  // A file read one at a time out of a folder the table already names says nothing more.
  const named = all.some((r) => !r.atRun && (r.kind === "inputFile" || r.kind === "inputFolder"));
  return all.filter((r) => !(named && r.atRun && r.reads)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** An AI's judgement as written in `checks`: the rule on the first line, this run's example after it. */
export function readCheck(text: string): { rule: string; example: string | null } {
  const [first, ...rest] = text.trim().split("\n");
  const example = rest.join("\n").trim();
  return { rule: (first ?? "").trim(), example: example || null };
}
