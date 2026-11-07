/**
 * A small Markdown reader for the AI chat: what the agents actually write
 * (headings, lists, code, tables, quotes, emphasis, links), read into a tree
 * that React draws. Nothing here becomes HTML: raw tags stay text, and a link
 * keeps only an http(s) address, so a reply can never run script in Studio.
 *
 * Replies arrive a few words at a time, so every prefix of a reply must read
 * sensibly: an unclosed code fence is a code block up to the end, and an
 * unclosed `**` or backtick is shown as the character it is.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "break" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "code"; lang: string; text: string; open: boolean }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; children: Block[] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

export type ListItem = { task: boolean | null; children: Block[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_RULE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

/** Reads a whole reply (or the part of it that has arrived) into blocks. */
export function parseMarkdown(source: string): Block[] {
  return blocks(source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      let open = true;
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const trimmed = l.trim();
        if (trimmed.startsWith(mark[0]!.repeat(mark.length)) && /^(`+|~+)$/.test(trimmed)) {
          open = false;
          i++;
          break;
        }
        body.push(l.slice(Math.min(indent, l.length - l.trimStart().length)));
        i++;
      }
      out.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n"), open });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE, ""));
      out.push({ kind: "quote", children: blocks(body) });
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, out);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      i = table(lines, i, out);
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(body.length > 0 && startsBlock(lines, i))) body.push(lines[i++]!.trim());
    out.push({ kind: "paragraph", children: parseInline(body.join("\n")) });
  }
  return out;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)) return true;
  return line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes("-");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function list(lines: string[], start: number, out: Block[]): number {
  const first = ITEM.exec(lines[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: { lines: string[] }[] = [];
  let content = 0;
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = ITEM.exec(line);
    if (item && item[1]!.length >= base && item[1]!.length < base + 2) {
      if (/\d/.test(item[2]!) !== ordered) break;
      // Where the item's own text begins; deeper lines belong to it.
      content = item[1]!.length + item[2]!.length + 1;
      items.push({ lines: [item[3] ?? ""] });
      i++;
      continue;
    }
    const current = items[items.length - 1]!;
    if (!line.trim()) {
      let next = i + 1;
      while (next < lines.length && !lines[next]!.trim()) next++;
      if (next >= lines.length) break;
      const following = lines[next]!;
      const sibling = ITEM.exec(following);
      const continues = indentOf(following) >= base + 2 || (sibling && indentOf(following) >= base && /\d/.test(sibling[2]!) === ordered);
      if (!continues) break;
      current.lines.push("");
      i++;
      continue;
    }
    if (indentOf(line) >= base + 2) {
      current.lines.push(line.slice(Math.min(content, indentOf(line))));
      i++;
      continue;
    }
    // A line run on from the item's text, as people often write.
    const previous = lines[i - 1]!;
    if (previous.trim() && indentOf(line) >= base && !startsBlock(lines, i)) {
      current.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  out.push({
    kind: "list",
    ordered,
    start: ordered ? Number.parseInt(first[2]!, 10) : 1,
    items: items.map(({ lines: body }) => {
      const task = /^\[([ xX])\][ \t]+/.exec(body[0]!);
      if (task) body[0] = body[0]!.slice(task[0].length);
      return { task: task ? task[1] !== " " : null, children: blocks(body) };
    }),
  });
  return i;
}

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    if (c === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cell += c;
    } else if (c === "|" && !code) {
      out.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  out.push(cell.trim());
  return out;
}

function table(lines: string[], start: number, out: Block[]): number {
  const head = cells(lines[start]!);
  const align: Align[] = cells(lines[start + 1]!).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null,
  );
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
    const row = cells(lines[i++]!);
    rows.push(head.map((_, n) => parseInline(row[n] ?? "")));
  }
  out.push({ kind: "table", align: head.map((_, n) => align[n] ?? null), head: head.map((c) => parseInline(c)), rows });
  return i;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

/** A web address an agent wrote, kept only when it is plainly http(s). */
export function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<(.*)>$/, "$1");
  if (!/^https?:\/\/[^\s/?#]+/i.test(href)) return null;
  // Control characters, spaces and quotes have no place in an address to hand to the system.
  if (/[\u0000- \u007f"<>\\^`{|}]/.test(href)) return null;
  if (href.length > 2048) return null;
  return href;
}

/** Inline text: code, emphasis, strikethrough, links and line breaks. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\" && i + 1 < source.length && PUNCTUATION.test(source[i + 1]!)) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      push({ kind: "break" });
      i++;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (source[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      let close = source.indexOf(ticks, i + run);
      while (close !== -1 && source[close + run] === "`") close = source.indexOf(ticks, close + run + 1);
      if (close !== -1) {
        let code = source.slice(i + run, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        push({ kind: "code", text: code });
        i = close + run;
        continue;
      }
      text += ticks;
      i += run;
      continue;
    }
    if (c === "[") {
      const link = readLink(source, i);
      if (link) {
        const href = safeHref(link.href);
        if (href) push({ kind: "link", href, children: parseInline(link.label) });
        else {
          flush();
          out.push(...parseInline(link.label));
        }
        i = link.end;
        continue;
      }
    }
    if ((c === "h" || c === "H") && /^https?:\/\//i.test(source.slice(i, i + 8)) && !WORD.test(source[i - 1] ?? "")) {
      const match = /^https?:\/\/[!#-;=?-~]+/i.exec(source.slice(i))!;
      let url = match[0];
      // Sentence punctuation after an address is not part of it.
      while (/[.,;:!?'*_~]$/.test(url) || (url.endsWith(")") && count(url, "(") < count(url, ")"))) url = url.slice(0, -1);
      const href = safeHref(url);
      if (href && url.length > "https://".length) {
        push({ kind: "link", href, children: [{ kind: "text", text: url }] });
        i += url.length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const span = readEmphasis(source, i);
      if (span) {
        push(span.node);
        i = span.end;
        continue;
      }
      let run = 1;
      while (source[i + run] === c) run++;
      text += c.repeat(run);
      i += run;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

function count(s: string, c: string): number {
  return s.split(c).length - 1;
}

function readLink(source: string, at: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let i = at;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
    else if (c === "\n" && source[i + 1] === "\n") return null;
  }
  if (i >= source.length || source[i + 1] !== "(") return null;
  const label = source.slice(at + 1, i);
  let parens = 0;
  let j = i + 2;
  for (; j < source.length; j++) {
    const c = source[j];
    if (c === "(") parens++;
    else if (c === ")" && parens-- === 0) break;
    else if (c === "\n") return null;
  }
  if (j >= source.length) return null;
  // `[label](url "title")`: the title is dropped.
  const href = source
    .slice(i + 2, j)
    .trim()
    .replace(/\s+(["']).*\1$/, "");
  return { label, href, end: j + 1 };
}

function readEmphasis(source: string, at: number): { node: Inline; end: number } | null {
  const c = source[at]!;
  let run = 1;
  while (source[at + run] === c) run++;
  const size = c === "~" ? (run === 2 ? 2 : 0) : Math.min(run, 3);
  if (size === 0 || run > 3) return null;
  const after = source[at + size];
  if (!after || /\s/.test(after)) return null;
  // `snake_case` and `2 * 3` are not emphasis.
  if (c === "_" && WORD.test(source[at - 1] ?? "")) return null;
  const mark = c.repeat(size);
  let from = at + size;
  while (from < source.length) {
    const close = source.indexOf(mark, from);
    if (close === -1) return null;
    const inner = source.slice(at + size, close);
    const ok =
      close > at + size &&
      !/\s/.test(source[close - 1]!) &&
      source[close + size] !== c &&
      !(c === "_" && WORD.test(source[close + size] ?? "")) &&
      !inner.includes("\n\n");
    if (ok) {
      const children = parseInline(inner);
      const node: Inline =
        c === "~"
          ? { kind: "del", children }
          : size === 3
            ? { kind: "strong", children: [{ kind: "em", children }] }
            : size === 2
              ? { kind: "strong", children }
              : { kind: "em", children };
      return { node, end: close + size };
    }
    from = close + 1;
  }
  return null;
}

/** The first line of a reply as plain words, for the chat list. */
export function plainLine(source: string): string {
  for (const block of parseMarkdown(source)) {
    const words = blockText(block).trim().split("\n")[0]!.trim();
    if (words) return words;
  }
  return "";
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return inlineText(block.children);
    case "code":
      return block.text;
    case "list":
      return block.items.map((item) => item.children.map(blockText).join("\n")).join("\n");
    case "quote":
      return block.children.map(blockText).join("\n");
    case "table":
      return block.head.map(inlineText).join(" ");
    case "rule":
      return "";
  }
}

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.kind === "text" || n.kind === "code" ? n.text : n.kind === "break" ? "\n" : inlineText(n.children)))
    .join("");
}
