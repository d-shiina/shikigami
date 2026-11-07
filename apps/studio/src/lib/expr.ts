// Reads flow expressions into tokens, the same way Core does
// (crates/shikigami-core/src/expr.rs), for display and editing help only:
// colouring variables, suggesting names, and recognising the shapes the
// transform forms edit. Studio never evaluates expressions itself; the
// result under a field comes from Core (`eval_expression`).

export type TokenKind = "ident" | "number" | "string" | "punct" | "space" | "error";

export type Token = {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** For strings: the value without quotes and escapes. */
  value?: string;
};

const PUNCT = ["=>", "==", "!=", "<=", ">=", "&&", "||", "(", ")", "[", "]", "{", "}", ",", ".", ":", "+", "-", "*", "/", "%", "!", "<", ">"];

// Names are letters of any script (受注番号), digits and _: Rust's
// char::is_alphabetic / is_alphanumeric, as Core reads them.
const isIdentStart = (c: string) => /[\p{Alphabetic}_]/u.test(c);
const isIdentPart = (c: string) => /[\p{Alphabetic}\p{N}_]/u.test(c);

/** Splits an expression into tokens, keeping spaces; never throws (bad input becomes `error` tokens). */
export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  const chars = Array.from(source);
  // Offsets are in UTF-16 units (what inputs and selections use).
  const offsets: number[] = [];
  let o = 0;
  for (const c of chars) {
    offsets.push(o);
    o += c.length;
  }
  offsets.push(o);
  let i = 0;
  const push = (kind: TokenKind, from: number, to: number, value?: string) =>
    out.push({ kind, text: source.slice(offsets[from]!, offsets[to]!), start: offsets[from]!, end: offsets[to]!, value });
  while (i < chars.length) {
    const c = chars[i]!;
    const from = i;
    if (/\s/u.test(c)) {
      while (i < chars.length && /\s/u.test(chars[i]!)) i++;
      push("space", from, i);
    } else if (/[0-9]/.test(c)) {
      while (i < chars.length && /[0-9.]/.test(chars[i]!)) i++;
      push("number", from, i);
    } else if (c === "'" || c === '"') {
      i++;
      let value = "";
      let closed = false;
      while (i < chars.length) {
        const ch = chars[i++]!;
        if (ch === "\\" && i < chars.length) {
          const next = chars[i++]!;
          value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
        } else if (ch === c) {
          closed = true;
          break;
        } else value += ch;
      }
      push(closed ? "string" : "error", from, i, value);
    } else if (isIdentStart(c)) {
      while (i < chars.length && isIdentPart(chars[i]!)) i++;
      push("ident", from, i);
    } else {
      const rest = chars.slice(i, i + 2).join("");
      const p = PUNCT.find((x) => rest.startsWith(x));
      i += p ? Array.from(p).length : 1;
      push(p ? "punct" : "error", from, i);
    }
  }
  return out;
}

/** The meaningful tokens (no spaces). */
export const solid = (tokens: Token[]) => tokens.filter((t) => t.kind !== "space");

const KEYWORDS = new Set(["true", "false", "null"]);

export type Role = "variable" | "unknown" | "param" | "field" | "function" | "string" | "number" | "keyword" | "operator" | "error";

export type Piece = Token & { role: Role };

/**
 * Each token with what it is, for colouring: a variable of the flow, a name
 * the flow does not have, a `r =>` parameter, a field after `.`, a function,
 * a literal or an operator. `known` holds the flow's variable names.
 */
export function classify(source: string, known: ReadonlySet<string>): Piece[] {
  const tokens = tokenize(source);
  const params = new Set<string>();
  const real = solid(tokens);
  real.forEach((t, i) => {
    if (t.kind === "ident" && real[i + 1]?.text === "=>") params.add(t.text);
  });
  return tokens.map((t, idx) => {
    const prev = prevSolid(tokens, idx);
    const next = nextSolid(tokens, idx);
    let role: Role;
    if (t.kind === "string") role = "string";
    else if (t.kind === "number") role = "number";
    else if (t.kind === "error") role = "error";
    else if (t.kind === "space") role = "operator";
    else if (t.kind === "punct") role = "operator";
    else if (KEYWORDS.has(t.text)) role = "keyword";
    else if (prev?.text === ".") role = "field";
    else if (next?.text === "(") role = "function";
    else if (next?.text === ":" && (prev?.text === "{" || prev?.text === ",")) role = "field";
    else if (params.has(t.text)) role = "param";
    else role = known.has(t.text) ? "variable" : "unknown";
    return { ...t, role };
  });
}

function prevSolid(tokens: Token[], idx: number): Token | undefined {
  for (let i = idx - 1; i >= 0; i--) if (tokens[i]!.kind !== "space") return tokens[i];
  return undefined;
}
function nextSolid(tokens: Token[], idx: number): Token | undefined {
  for (let i = idx + 1; i < tokens.length; i++) if (tokens[i]!.kind !== "space") return tokens[i];
  return undefined;
}

/** Writes text as an expression string literal. */
export function quote(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
}

/** Whether a name can be written after `.` (else it needs `['…']`). */
export const isPlainName = (name: string) => /^[\p{Alphabetic}_][\p{Alphabetic}\p{N}_]*$/u.test(name) && !KEYWORDS.has(name);

/** A field access: `.金額`, or `['税込 金額']` when the name has spaces or symbols. */
export const fieldAccess = (name: string) => (isPlainName(name) ? `.${name}` : `[${quote(name)}]`);

/** Root variables an expression reads (not functions, fields or `r =>` parameters). */
export function readsVariables(source: string): string[] {
  const names = classify(source, new Set()).filter((p) => p.role === "unknown" || p.role === "variable").map((p) => p.text);
  return [...new Set(names)];
}

/**
 * Where the cursor is, for suggestions: the word being typed, and what comes
 * before it (`.` after a variable or parameter means a field).
 */
export type CursorContext = {
  /** The partial word before the cursor (may be empty). */
  word: string;
  /** Where the word starts. */
  from: number;
  /** Set when typing a field: the variable or parameter before the `.`. */
  owner?: string;
  /** The innermost function call the cursor is inside, and which argument. */
  call?: { name: string; arg: number };
};

export function cursorContext(source: string, cursor: number): CursorContext {
  const before = source.slice(0, cursor);
  const tokens = tokenize(before);
  const last = tokens.at(-1);
  let word = "";
  let from = cursor;
  let rest = tokens;
  if (last && last.kind === "ident" && last.end === cursor) {
    word = last.text;
    from = last.start;
    rest = tokens.slice(0, -1);
  }
  const real = solid(rest);
  let owner: string | undefined;
  if (real.at(-1)?.text === "." && rest.at(-1)?.text === ".") {
    const o = real.at(-2);
    if (o?.kind === "ident") owner = o.text;
  }
  // The innermost open call: walk back counting brackets.
  let depth = 0;
  let arg = 0;
  let call: CursorContext["call"];
  const all = solid(tokens);
  for (let i = all.length - 1; i >= 0; i--) {
    const t = all[i]!;
    if (t.text === ")" || t.text === "]" || t.text === "}") depth++;
    else if (t.text === "[" || t.text === "{") {
      if (depth === 0) break;
      depth--;
    } else if (t.text === "(") {
      if (depth === 0) {
        const name = all[i - 1];
        if (name?.kind === "ident") call = { name: name.text, arg };
        break;
      }
      depth--;
    } else if (t.text === "," && depth === 0) arg++;
  }
  return { word, from, owner, call };
}

/**
 * The table a lambda parameter walks over: in `map(rows, r => r.`, `r` is a
 * row of `rows`. Only when the list is a plain variable.
 */
export function paramSource(source: string, param: string): string | undefined {
  const real = solid(tokenize(source));
  for (let i = 0; i + 3 < real.length; i++) {
    if (real[i + 1]?.text === "," && real[i + 2]?.text === param && real[i + 3]?.text === "=>" && real[i]!.kind === "ident") {
      return real[i]!.text;
    }
  }
  return undefined;
}
