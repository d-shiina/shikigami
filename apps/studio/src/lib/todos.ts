// What a person still has to do before a flow can run, when its author could
// not: an AI in a chat window without MCP (Microsoft Copilot) cannot see the
// screen, register a login or put files in the flow's folder. Studio lists
// these apart from what the AI must fix, with the one button that does each,
// and gives the AI's part as text to paste back into the chat.
import type { Flow, ProjectFiles, Step, StepTypeDef, ValidationIssue, ValidationReport } from "@shikigami/schema";
import type { AnswerProblem, SecretField } from "./api";
import { t } from "./i18n";
import { missingImages } from "./imageParts";
import { partRef } from "./parts";
import { writtenAt } from "./problemText";

export type Todo =
  /** A screen part without a target: pick it on the screen (`image`: cut its picture out of the screen). */
  | { kind: "pick"; part: string; label: string; app: string; steps: string[]; image?: boolean }
  /** A login the flow types by name that is not registered on this PC. */
  | { kind: "secret"; name: string; fields: SecretField[]; steps: string[] }
  /** A file the flow reads from its folder that is not there. */
  | { kind: "file"; path: string; steps: string[] };

/** Issue codes that mean "a person does this", not "the author got it wrong". */
export const PERSON_CODES: ReadonlySet<string> = new Set(["PART_NOT_PICKED"]);

/** Folders whose files a flow reads: they have to be there before a run. */
const READ_FOLDERS = new Set(["input", "templates", "config"]);

function* walk(steps: readonly Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    for (const block of Object.values(step.blocks ?? {})) yield* walk(block);
  }
}

/** Every `{ secret, field }` inside a value. */
function secretsIn(value: unknown, found: { name: string; field?: string }[]): void {
  if (Array.isArray(value)) {
    for (const v of value) secretsIn(v, found);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.secret === "string" && obj.secret.trim() !== "") {
      found.push({ name: obj.secret, field: typeof obj.field === "string" ? obj.field : undefined });
      return;
    }
    for (const v of Object.values(obj)) secretsIn(v, found);
  }
}

/** A literal path relative to the flow's folder in a folder the flow reads. */
function readPath(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("{{")) return null;
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const top = path.split("/")[0] ?? "";
  return READ_FOLDERS.has(top) && path.length > top.length + 1 ? path : null;
}

/**
 * What a person has to do in Studio. `secrets` (registered names) and
 * `files` (the flow's folder) are null while unknown; nothing is reported
 * for them then.
 */
export function personTodos(
  flow: Flow,
  defs: ReadonlyMap<string, StepTypeDef>,
  secrets: ReadonlySet<string> | null,
  files: ProjectFiles | null,
): Todo[] {
  const todos: Todo[] = [];
  const steps = [...walk(flow.steps ?? [])];
  for (const [name, part] of Object.entries(flow.parts ?? {})) {
    const target = part.target as unknown;
    if (target !== undefined && target !== null) continue;
    const uses = steps.filter((s) => partRef(s.params?.target) === name).map((s) => s.id ?? "");
    todos.push({ kind: "pick", part: name, label: part.label || name, app: part.app, steps: uses });
  }
  for (const name of missingImages(flow, files)) {
    const part = flow.parts?.[name];
    if (!part) continue;
    const uses = steps.filter((s) => partRef(s.params?.target) === name).map((s) => s.id ?? "");
    todos.push({ kind: "pick", part: name, label: part.label || name, app: part.app, steps: uses, image: true });
  }
  if (secrets) {
    const missing = new Map<string, { fields: Set<SecretField>; steps: string[] }>();
    for (const step of steps) {
      const found: { name: string; field?: string }[] = [];
      secretsIn(step.params, found);
      for (const { name, field } of found) {
        if (secrets.has(name)) continue;
        const entry = missing.get(name) ?? { fields: new Set<SecretField>(), steps: [] };
        if (field === "username" || field === "password" || field === "totp") entry.fields.add(field);
        if (step.id && !entry.steps.includes(step.id)) entry.steps.push(step.id);
        missing.set(name, entry);
      }
    }
    for (const [name, { fields, steps: ids }] of missing) {
      todos.push({ kind: "secret", name, fields: fields.size ? [...fields] : ["username", "password"], steps: ids });
    }
  }
  if (files) {
    const have = new Set(files.files.map((f) => f.path.toLowerCase()));
    const missing = new Map<string, string[]>();
    for (const step of steps) {
      const def = defs.get(step.type);
      for (const key of def?.pathParams ?? []) {
        const value = step.params?.[key];
        for (const item of Array.isArray(value) ? value : [value]) {
          const path = readPath(item);
          if (!path || have.has(path.toLowerCase())) continue;
          const ids = missing.get(path) ?? [];
          if (step.id && !ids.includes(step.id)) ids.push(step.id);
          missing.set(path, ids);
        }
      }
    }
    for (const [path, ids] of missing) todos.push({ kind: "file", path, steps: ids });
  }
  return todos;
}

/** Step id → what a person has to do there, for the marks on the chart. */
export function todosByStep(todos: readonly Todo[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const todo of todos) {
    for (const id of todo.steps) {
      const list = map.get(id) ?? [];
      list.push(todoTitle(todo));
      map.set(id, list);
    }
  }
  return map;
}

export function todoTitle(todo: Todo): string {
  switch (todo.kind) {
    case "pick":
      return todo.image ? t.todos.snip(todo.label) : t.todos.pick(todo.label);
    case "secret":
      return t.todos.secret(todo.name);
    case "file":
      return t.todos.file(todo.path);
  }
}

/** Warnings that are the author's mistake all the same: the flow runs, but not as meant. */
const AUTHOR_WARNINGS: ReadonlySet<string> = new Set(["EXPR_OTHER_LANGUAGE"]);

/** The errors the flow's author has to fix (not the ones a person does). */
export function authorIssues(validation: ValidationReport | null | undefined): ValidationIssue[] {
  return (validation?.issues ?? []).filter(
    (i) => (i.severity === "error" || AUTHOR_WARNINGS.has(i.code)) && !PERSON_CODES.has(i.code) && !isUnset(i),
  );
}

/**
 * A required setting left empty: what every node is right after it is added.
 * Shown as "未設定" (not set up yet), not as an error; a run still waits for it.
 */
export function isUnset(issue: Pick<ValidationIssue, "code" | "message" | "path">): boolean {
  // Only a node's own settings (`…/params`): a required item inside a list or
  // record is not what the unset count sees, and stays an error.
  return issue.code === "INVALID_PARAMS" && /is a required property/.test(issue.message) && issue.path.endsWith("/params");
}

/** The required settings still empty, one per field. */
export function unsetIssues(validation: ValidationReport | null | undefined): ValidationIssue[] {
  return (validation?.issues ?? []).filter((i) => i.severity === "error" && isUnset(i));
}

/** The flow as the AI writes it: the answer object, keeping step IDs and picked targets. */
export function flowForChat(flow: Flow): string {
  const content: Record<string, unknown> = { name: flow.name };
  if (flow.description) content.description = flow.description;
  // A secret's value never leaves Studio, even one wrongly saved as a default
  // (the bundle export drops it the same way).
  if (flow.variables?.length) content.variables = flow.variables.map((v) => (v.secret ? withoutDefault(v) : v));
  if (flow.parts && Object.keys(flow.parts).length) content.parts = flow.parts;
  content.steps = flow.steps ?? [];
  if (flow.settings && Object.keys(flow.settings).length) content.settings = flow.settings;
  return JSON.stringify({ format: "shikigami.answer", summary: "", checks: [], flow: content }, null, 2);
}

function withoutDefault<T extends { default?: unknown }>(v: T): Omit<T, "default"> {
  const { default: _value, ...rest } = v;
  return rest;
}

const fence = (json: string) => "```json\n" + json + "\n```";

/** To paste into the chat with a request: the current flow and how to answer. */
export function handOffText(flow: Flow): string {
  return `${t.todos.handOff}\n\n${fence(flowForChat(flow))}\n`;
}

/** Where an issue is, in words the AI can find in its own answer. */
function where(path: string | undefined, name: string | undefined): string {
  return [path, name ? t.todos.stepNamed(name) : ""].filter(Boolean).join(" ");
}

/**
 * The problems for the AI, to paste back into the chat: where each is, what
 * is wrong, what was written there, and how to fix it, with the expression
 * rules when an expression is wrong. With `flow`, the problems are
 * validation issues of that flow (paths inside it) and the flow goes along,
 * so the AI fixes what Studio has, edits by the person included.
 */
export function returnText(problems: (AnswerProblem | ValidationIssue)[], flow?: Flow): string {
  const steps = new Map(flow ? [...walk(flow.steps ?? [])].map((s) => [s.id ?? "", s] as const) : []);
  const lines = problems.map((p, i) => {
    const issue = p as ValidationIssue;
    const answer = p as AnswerProblem;
    const path = flow && p.path ? `/flow${p.path}` : p.path;
    const name = (issue.stepId ? steps.get(issue.stepId)?.name : undefined) ?? answer.step;
    const at = where(path, name);
    const out = [`${i + 1}. ${at ? `${at}: ` : ""}${p.message}`];
    const written = answer.found ?? (flow ? writtenAt(flow, issue) : null);
    if (written) out.push(`   ${t.todos.written}: ${written}`);
    if (issue.hint) out.push(`   ${t.todos.fixHint}: ${issue.hint}`);
    return out.join("\n");
  });
  const parts = [flow ? t.todos.returnLeadFlow : t.todos.returnLead, "", ...lines];
  if (problems.some((p) => (p as ValidationIssue).code?.startsWith("EXPR_"))) {
    parts.push("", `${t.todos.rulesTitle}:`, ...t.todos.rules.map((rule) => `- ${rule}`));
  }
  if (flow) parts.push("", fence(flowForChat(flow)));
  return parts.join("\n") + "\n";
}
