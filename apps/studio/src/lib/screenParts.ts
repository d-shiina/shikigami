import { create } from "zustand";
import { t } from "./i18n";

/**
 * A screen the person showed the AI (paste way): what Writer read from it,
 * cleaned so only the names and kinds of its parts go out. The AI chat
 * cannot see the screen; with this list it can point at parts as an AI with
 * inspect_ui / inspect_page does.
 */
export type Screen = {
  kind: "app" | "web";
  title: string;
  /** The process (app) or address (web). */
  where: string;
  /** An app's window as the picker found it (title, match, nth when one process has several): what its targets start with. */
  window?: Record<string, unknown>;
  /** The cleaned tree. */
  tree: string;
  parts: number;
};

/** More than a chat takes in well with the rest of the request. */
const MAX_LINES = 300;

/** Free text on the page: what it says, not something to point at. */
const TEXT_ROLES = new Set(["text", "paragraph", "statictext", "document"]);
/** Rows of data: their names are the data (customers, amounts). */
const ROW_ROLES = { app: new Set(["row", "listitem", "treeitem", "dataitem"]), web: new Set(["row"]) };
const HEADER_ROLES = new Set(["columnheader", "header", "rowheader"]);

type Line = { depth: number; role: string; body: string };

function parse(tree: string): Line[] {
  return tree.split("\n").flatMap((raw) => {
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (!m) return [];
    const body = m[2] ?? "";
    return [{ depth: Math.floor((m[1] ?? "").length / 2), role: /^[A-Za-z]+/.exec(body)?.[0]?.toLowerCase() ?? "", body }];
  });
}

/** The line without what is typed in it or the text it shows after its name. */
function plain(line: Line, kind: Screen["kind"]): string {
  if (kind === "app") return line.body.replace(/ value="(?:[^"\\]|\\.)*"/g, "");
  // `textbox "氏名": 山田太郎` / `link "ホーム":` → `textbox "氏名"` / `link "ホーム"`
  const m = /^([A-Za-z]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*)/.exec(line.body);
  return m?.[1] ?? line.body;
}

/**
 * The tree an adapter returned (`inspect` of a window or a page), as the part
 * list that goes to the AI: values, free text and data rows left out.
 */
export function cleanTree(tree: string, kind: Screen["kind"]): { tree: string; parts: number } {
  const lines = parse(tree);
  const out: string[] = [];
  let parts = 0;
  let skipBelow: number | null = null;
  let dropped = 0;
  let droppedAt = 0;
  const flush = () => {
    if (dropped > 0) out.push(`${"  ".repeat(droppedAt)}- ${t.aiChat.screen.rowsLeft(dropped)}`);
    dropped = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (skipBelow !== null && line.depth > skipBelow) continue;
    skipBelow = null;
    if (line.body.startsWith("/") || TEXT_ROLES.has(line.role)) continue;
    if (ROW_ROLES[kind].has(line.role)) {
      const children: Line[] = [];
      for (let j = i + 1; j < lines.length && lines[j]!.depth > line.depth; j++) if (lines[j]!.depth === line.depth + 1) children.push(lines[j]!);
      const header = children.length > 0 && children.every((c) => HEADER_ROLES.has(c.role));
      if (!header) {
        if (dropped === 0) droppedAt = line.depth;
        dropped++;
        skipBelow = line.depth;
        continue;
      }
    }
    flush();
    if (out.length >= MAX_LINES) {
      out.push(t.aiChat.screen.cut);
      return { tree: out.join("\n"), parts };
    }
    out.push(`${"  ".repeat(line.depth)}- ${plain(line, kind)}`);
    parts++;
  }
  flush();
  return { tree: out.join("\n"), parts };
}

/** The request's section for the screens the person added. */
export function screensSection(screens: Screen[]): string[] {
  if (screens.length === 0) return [];
  const s = t.aiChat.screen;
  return [
    `===== ${s.section} =====`,
    s.sectionLead,
    ...screens.flatMap((screen) => ["", screen.kind === "app" ? s.appHead(screen.title, screen.where) : s.webHead(screen.title, screen.where), ...(screen.window ? [s.window(JSON.stringify(screen.window))] : []), "```text", screen.tree, "```"]),
    "",
  ];
}

/** The screens added to each conversation's next request. */
type Screens = {
  byChat: Record<string, Screen[]>;
  add(chatId: string, screen: Screen): void;
  remove(chatId: string, index: number): void;
  clear(chatId: string): void;
};

export const useScreens = create<Screens>((set) => ({
  byChat: {},
  add: (chatId, screen) =>
    set((s) => {
      // The same window or page again replaces what was read before.
      const kept = (s.byChat[chatId] ?? []).filter((x) => !(x.kind === screen.kind && x.where === screen.where && x.title === screen.title));
      return { byChat: { ...s.byChat, [chatId]: [...kept, screen] } };
    }),
  remove: (chatId, index) => set((s) => ({ byChat: { ...s.byChat, [chatId]: (s.byChat[chatId] ?? []).filter((_, i) => i !== index) } })),
  clear: (chatId) =>
    set((s) => {
      const { [chatId]: _gone, ...rest } = s.byChat;
      return { byChat: rest };
    }),
}));

type Step = { type: string; params?: Record<string, unknown> | null; blocks?: Record<string, Step[]> | null };

/** The addresses the flow's 「ページを開く」 nodes open, for adding their pages. */
export function pagesOf(steps: Step[]): string[] {
  const found: string[] = [];
  const walk = (list: Step[]) => {
    for (const s of list) {
      const url = s.type === "browser.open" && typeof s.params?.url === "string" ? s.params.url.trim() : "";
      if (url && !url.includes("{{") && !found.includes(url)) found.push(url);
      for (const block of Object.values(s.blocks ?? {})) walk(block);
    }
  };
  walk(steps);
  return found;
}
