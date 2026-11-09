// Names for the variables a freshly added node fills, so a person building a
// flow by hand never has to invent one before the next node can use the
// result. Variable names are identifiers (ASCII), so the names are short
// English nouns for what the node returns.
import type { Step, StepTypeDef, VariableDef } from "@shikigami/schema";
import { knownVariables } from "./nodeRows";

const NAMES: Record<string, string> = {
  "excel.readRows": "rows",
  "excel.readRange": "rows",
  "excel.readCell": "cell",
  "excel.listSheets": "sheets",
  "file.readCsv": "rows",
  "file.readText": "text",
  "file.list": "files",
  "file.exists": "exists",
  "browser.getText": "text",
  "browser.getTable": "table",
  "browser.getAttribute": "attribute",
  "browser.runScript": "result",
  "browser.isVisible": "visible",
  "desktop.getTable": "table",
  "desktop.getValue": "value",
  "desktop.readText": "text",
  "desktop.isVisible": "visible",
  "dialog.input": "answer",
  "dialog.form": "form",
  "dialog.message": "answer",
  "dialog.selectFile": "selected",
  "http.request": "response",
  "db.query": "rows",
  "mail.list": "mails",
  "pdf.readText": "text",
  "word.readText": "text",
  "word.readTables": "tables",
  "clipboard.get": "clipboard",
  "config.read": "config",
  "process.run": "output",
};

/** The type's own name for its result: `excel.readRows` → rows, `foo.getStatus` → status. */
function baseName(type: string): string {
  if (NAMES[type]) return NAMES[type]!;
  const action = type.split(".").pop() ?? "result";
  const noun = action.replace(/^(get|read|list|find)(?=[A-Z])/, "");
  const name = noun.charAt(0).toLowerCase() + noun.slice(1);
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : "result";
}

/** A name not yet used in the flow: rows, rows2, rows3… */
export function freeName(base: string, variables: VariableDef[] | undefined, steps: Step[]): string {
  const used = knownVariables(variables, steps);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

/**
 * Nodes that do something (click, type, open, repeat…) also return a value,
 * but nobody reads it: they get no variable, so the chart shows no stray
 * `click` or `forEach`. Only nodes that read or ask for something do.
 */
const READS = /^(get|read|list|find|is|exists|query|request|input|select|search|count|download|run)/i;

/** Where a new node of `def` keeps its result, or undefined for a node that returns nothing worth keeping. */
export function resultName(def: StepTypeDef | undefined, variables: VariableDef[] | undefined, steps: Step[]): string | undefined {
  if (!def?.hasOutput) return undefined;
  if (!NAMES[def.type] && !READS.test(def.type.split(".").pop() ?? "")) return undefined;
  return freeName(baseName(def.type), variables, steps);
}
