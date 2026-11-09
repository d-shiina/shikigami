// Several accounts of one site: each is its own secret (「受注システム（経理）」
// 「受注システム（申請）」). A flow names the one it logs in with, or lets the
// person pick each run: an input whose choices are those names, written
// `{ "secret": "{{ アカウント }}" }` in the steps (validation checks it).
import type { EditOp, Flow, Step, VariableDef } from "@shikigami/schema";
import type { SecretInfo } from "./api";

/** `{{ name }}` → `name`, as the Runtime reads a secret name taken from a variable. */
export function nameVariable(secret: string): string | null {
  const m = /^\s*\{\{\s*([\p{L}\p{N}_]+)\s*\}\}\s*$/u.exec(secret);
  return m && !/^[0-9]/.test(m[1]!) ? m[1]! : null;
}

/** Inputs a secret name can be taken from: text inputs whose choices are names. */
export function accountInputs(flow: Pick<Flow, "variables">): VariableDef[] {
  return (flow.variables ?? []).filter(
    (v) =>
      (v.direction === "input" || v.direction === "inOut") &&
      v.type === "string" &&
      (v.choices ?? []).length > 0 &&
      (v.choices ?? []).every((c) => typeof c === "string"),
  );
}

/** The other secrets of the same kind registered for one of `name`'s sites. */
export function sameSite(secrets: SecretInfo[], name: string): SecretInfo[] {
  const own = secrets.find((s) => s.name === name);
  if (!own || own.sites.length === 0) return [];
  return secrets.filter((s) => s.name !== name && s.kind === own.kind && s.sites.some((site) => own.sites.includes(site)));
}

/** How a secret is told apart in a list: its name, and the user name as browsers show saved logins. */
export const accountLabel = (s: Pick<SecretInfo, "name" | "username">): string => (s.username ? `${s.name}（${s.username}）` : s.name);

function freeName(flow: Pick<Flow, "variables">, base: string): string {
  const taken = new Set((flow.variables ?? []).map((v) => v.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

function* walk(steps: Step[] | undefined): Generator<Step> {
  for (const step of steps ?? []) {
    yield step;
    for (const block of Object.values(step.blocks ?? {})) yield* walk(block);
  }
}

/** `value` with every reference to the secret `from` pointed at `to`. */
function repoint(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((v) => repoint(v, from, to));
  if (value && typeof value === "object") {
    const map = value as Record<string, unknown>;
    if (map.secret === from && "field" in map) return { ...map, secret: to };
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, repoint(v, from, to)]));
  }
  return value;
}

/**
 * 「実行のたびに選ぶ」: an input listing `names` (the first is the one the
 * flow used), and every step that logs in with `from` (its user name,
 * password and one-time code, the saved login of the same name, and the
 * OAuth sign-in) takes
 * the account from it. One undo step.
 */
export function pickEachRun(
  flow: Pick<Flow, "variables" | "steps">,
  from: string,
  names: string[],
  description: string,
  base: string,
): { variable: string; ops: EditOp[] } {
  const variable = freeName(flow, base);
  const to = `{{ ${variable} }}`;
  const ops: EditOp[] = [
    {
      op: "setVariable",
      variable: { name: variable, type: "string", direction: "input", description, choices: [from, ...names.filter((n) => n !== from)] },
    } as EditOp,
  ];
  for (const step of walk(flow.steps)) {
    const params = (step.params ?? {}) as Record<string, unknown>;
    let next = repoint(params, from, to) as Record<string, unknown>;
    // Steps that name the secret as plain text: the saved login, and the OAuth sign-in its access token comes from.
    if (step.type === "browser.open" && params.session === from) next = { ...next, session: to };
    if (step.type === "oauth.signIn" && params.secret === from) next = { ...next, secret: to };
    if (JSON.stringify(next) !== JSON.stringify(params) && step.id) {
      ops.push({ op: "updateStep", stepId: step.id, patch: { replaceParams: next } } as EditOp);
    }
  }
  return { variable, ops };
}
