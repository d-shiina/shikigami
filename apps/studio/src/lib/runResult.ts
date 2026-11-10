// What the 実行結果 shows of one finished run, read from its record
// (runs/<id>/report.json and events.jsonl): the files it wrote, the values
// it returned and was given, and everything it worked on outside itself.
// Display only; the record is the source, kept for `records.keepDays`.
import type { Flow, RunEventEnvelope, RunOrigin, RunReport, StepTypeDef, Touched, VariableDef } from "@spellsheet/schema";
import { isInput, isOutput } from "../runner/form";
import { stepLabel, t } from "./i18n";
import { targetText } from "./sentence";

/** A run as the list beside the paper names it (`flow_runs`). */
export type FlowRun = {
  runId: string;
  status: RunReport["status"];
  startedAt: string;
  finishedAt: string;
  origin: RunOrigin;
  version?: number;
  revision: number;
  errorCode?: string;
};

/** The requester Runner gives its runs (src-tauri/src/runner.rs). */
const RUNNER = "runner";

/** Where a run was started from, in words: Writer, Runner, a schedule by name, an AI… */
export function originText(origin: RunOrigin | undefined): string {
  const by = origin?.requestedBy?.trim();
  switch (origin?.trigger) {
    case "studio":
      if (by === RUNNER) return t.result.origin.runner;
      // A test case run from Writer.
      if (by?.startsWith("test:")) return t.result.origin.test(by.slice(5));
      return t.result.origin.writer;
    case "mcp":
      return by?.startsWith("test:") ? t.result.origin.test(by.slice(5)) : t.result.origin.ai;
    case "schedule":
      return by ? t.result.origin.scheduleNamed(by) : t.result.origin.schedule;
    case "cli":
      return t.result.origin.cli;
    case "remote":
      return t.result.origin.remote;
    default:
      return t.result.origin.unknown;
  }
}

export type PlaceKind = "inputFile" | "inputFolder" | "outputFile" | "outputFolder" | "deleted" | "site" | "screen" | "mail" | "app" | "other";

/** One place the run worked on, as the paper lists it. */
export type PlaceRow = {
  kind: PlaceKind;
  /** As recorded (full path, URL, address). */
  target: string;
  /** The path inside the flow's folder when it is in it, else the target. */
  shown: string;
  /** What the nodes did to it, by their names: 「Excel 書き込み」. */
  actions: string[];
  reads: boolean;
  count: number;
  at: string;
  stepId: string;
  callPath: string[];
  touched: Touched;
};

const EXTENSION = /\.[A-Za-z0-9]{1,5}$/;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** `dir` with forward slashes and a trailing one, lower-cased on Windows-style paths, to compare with. */
function folderKey(dir: string): string {
  const slashed = dir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** `path` inside `dir` (the flow's folder), `/`-separated; null when it is elsewhere. */
export function insideFolder(path: string, dir: string | null | undefined): string | null {
  if (!dir) return null;
  const slashed = path.replace(/\\/g, "/");
  const key = folderKey(dir);
  const compared = /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
  return compared.startsWith(key) && compared.length > key.length ? slashed.slice(key.length) : null;
}

function kindOf(item: Touched): PlaceKind {
  const target = item.target;
  const types = item.stepTypes;
  if (item.screen) return "screen";
  if (item.gone && !item.reads) return "deleted";
  if (types.some((s) => s.startsWith("mail.")) && (ADDRESS.test(target) || target.includes("@"))) return "mail";
  if (/^https?:/i.test(target)) return "site";
  if (types.some((s) => s === "desktop.launch" || s.startsWith("system.process") || s.startsWith("process."))) return "app";
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(target) || EXTENSION.test(target)) {
    const file = EXTENSION.test(target) || !!item.file;
    if (item.reads) return file ? "inputFile" : "inputFolder";
    return file ? "outputFile" : "outputFolder";
  }
  return "other";
}

const ORDER: PlaceKind[] = ["outputFile", "outputFolder", "deleted", "mail", "site", "screen", "app", "inputFile", "inputFolder", "other"];

/** An element a step acted on (its target as JSON), in words: 「出荷」ボタン. */
function screenText(target: string): string {
  try {
    return targetText(JSON.parse(target));
  } catch {
    return target;
  }
}

/** The places of a run, changes first (files written, deleted, mail sent), then what it only read. */
export function placeRows(report: RunReport | null, defs: Map<string, StepTypeDef>, projectDir: string | null): PlaceRow[] {
  const rows = (report?.touched ?? []).map((item, i) => ({
    i,
    row: {
      kind: kindOf(item),
      target: item.target,
      shown: item.screen ? screenText(item.target) : (insideFolder(item.target, projectDir) ?? item.target),
      actions: item.stepTypes.map((type) => stepLabel(type, defs.get(type)?.label)),
      reads: item.reads === true,
      count: item.count,
      at: item.at,
      stepId: item.stepId,
      callPath: item.callPath ?? [],
      touched: item,
    } satisfies PlaceRow,
  }));
  return rows.sort((a, b) => ORDER.indexOf(a.row.kind) - ORDER.indexOf(b.row.kind) || a.i - b.i).map((r) => r.row);
}

/** The files the run wrote and left on the PC, to show the content of. */
export function writtenFiles(rows: PlaceRow[]): PlaceRow[] {
  return rows.filter((r) => r.kind === "outputFile" && r.touched.file);
}

/** The app a file opens in, when the button can name it: 「Excel で開く」. */
export function appOf(path: string): "excel" | "word" | "powerpoint" | "pdf" | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["xlsx", "xlsm", "xls", "xlsb"].includes(ext)) return "excel";
  if (["docx", "docm", "doc"].includes(ext)) return "word";
  if (["pptx", "pptm", "ppt"].includes(ext)) return "powerpoint";
  if (ext === "pdf") return "pdf";
  return null;
}

/** The values the run started with: its inputs as given (or their defaults). */
export function inputValues(flow: Flow | null, events: RunEventEnvelope[]): { variable: VariableDef | null; name: string; value: unknown }[] {
  const inputs = (flow?.variables ?? []).filter(isInput);
  const seen = new Map<string, unknown>();
  for (const e of events) {
    const change = e as unknown as { type: string; variable?: string; value?: unknown; stepId?: string | null };
    // Inputs and defaults are set before any node, without a node.
    if (change.type === "variableChanged" && !change.stepId && typeof change.variable === "string" && !seen.has(change.variable)) {
      seen.set(change.variable, change.value);
    }
    if (change.type === "stepStarted") break;
  }
  return inputs.filter((v) => seen.has(v.name)).map((v) => ({ variable: v, name: v.name, value: seen.get(v.name) }));
}

/** The values the run returned, in the order the flow declares its outputs. */
export function outputValues(flow: Flow | null, report: RunReport | null): [string, unknown][] {
  const outputs = report?.outputs ?? {};
  const declared = (flow?.variables ?? []).filter(isOutput).map((v) => v.name);
  const names = [...declared.filter((n) => n in outputs), ...Object.keys(outputs).filter((n) => !declared.includes(n))];
  return names.map((n) => [n, outputs[n]]);
}

/** Errors and warnings the run wrote, and how many nodes it ran. */
export function runCounts(events: RunEventEnvelope[]): { errors: number; warnings: number; nodes: number } {
  let errors = 0;
  let warnings = 0;
  const nodes = new Set<string>();
  for (const e of events) {
    const ev = e as unknown as { type: string; level?: string; stepId?: string; outcome?: string; callPath?: string[] };
    if (ev.type === "log" && ev.level === "error") errors++;
    if (ev.type === "log" && ev.level === "warn") warnings++;
    if (ev.type === "stepFinished" && ev.outcome === "failed") errors++;
    if (ev.type === "stepStarted" && ev.stepId) nodes.add(`${(ev.callPath ?? []).join("/")}|${ev.stepId}`);
  }
  return { errors, warnings, nodes: nodes.size };
}

/** Milliseconds between the start and end of a run. */
export function durationMs(run: { startedAt: string; finishedAt: string }): number {
  return Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) || 0;
}
