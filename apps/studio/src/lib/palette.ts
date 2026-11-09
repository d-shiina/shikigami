// What the node palette (Ctrl+K) lists and how it finds things: the nodes in
// groups by what they work on, a "frequent" view to start from, and a search
// that ranks by how well the name matches and forgives the ways Japanese can
// be written (katakana / hiragana, full / half width).
import type { FlowSummary, StepTypeDef } from "@spellsheet/schema";
import { stepLabel, t } from "./i18n";
import { KEYWORD } from "./keywords";
import { en } from "./locales/en";
import { presets } from "./presets";
import { extensionGroup, extensionOf, extensionSummary, extensionTag, groupExtension } from "./extensions";
import { toKana } from "./romaji";

/** One line of the palette: a node type, or a ready-made "変数への代入" (preset). */
export type PaletteItem = {
  key: string;
  /** The palette group it is listed under (see GROUPS). */
  group: string;
  label: string;
  keyword?: string;
  summary: string;
  /** What gets added. */
  type: string;
  params?: Record<string, unknown>;
  name?: string;
  /** The sub-heading it is listed under inside its group (see SUBGROUPS), if any. */
  sub?: string;
  /** Its place in its group: the order people reach for nodes, used to break ties. */
  order: number;
  /** Normalised text, by how much a match in it counts. */
  find: { label: Text; strong: Text; weak: Text };
};

/** Normalised text, and which of its characters were katakana before (see `has`). */
type Text = { text: string; kata: string };

/**
 * The groups, in the order the palette lists them, under three headings:
 * what the flow works on first (that is what people look for when
 * building an automation), then the flow's own nodes, then data handling.
 */
export const SECTIONS: { id: string; groups: string[] }[] = [
  { id: "apps", groups: ["browser", "excel", "word", "outlook", "office", "file", "windows", "network", "database", "system"] },
  { id: "flow", groups: ["control", "subflow", "variable", "flow", "log"] },
  { id: "data", groups: ["text", "number", "date", "list"] },
];
const ORDER = SECTIONS.flatMap((s) => s.groups);

/** The opening view: recently added nodes, then these. */
const COMMON = [
  "browser.open",
  "browser.click",
  "browser.fill",
  "browser.getText",
  "excel.readRows",
  "excel.writeCell",
  "file.readCsv",
  "dialog.message",
  "control.if",
  "control.forEach",
  "control.repeat",
  "control.try",
  "variable.set",
  "flow.delay",
  "log.message",
];

/**
 * The order inside a group, by what the node is for: open, operate, read,
 * wait… People look for "the browser node that reads" more than for a name,
 * and alphabetical order put rarely used nodes (既存ブラウザへの接続) first.
 * Nodes not listed here (new ones, plugins) follow, in registry order.
 */
export const SUBGROUPS: Record<string, [string, string[]][]> = {
  browser: [
    ["open", ["browser.open", "browser.attach", "browser.navigate", "browser.switchTab", "browser.closeTab", "browser.close"]],
    ["operate", ["browser.click", "browser.fill", "browser.select", "browser.check", "browser.press", "browser.hover", "browser.scroll", "browser.upload", "browser.download"]],
    ["read", ["browser.getText", "browser.getTable", "browser.getAttribute", "browser.isVisible", "browser.screenshot", "browser.runScript"]],
    ["wait", ["browser.waitFor", "browser.waitForHuman"]],
  ],
  excel: [
    ["read", ["excel.readRows", "excel.readCell", "excel.readRange", "excel.listSheets"]],
    ["write", ["excel.writeCell", "excel.writeRange", "excel.appendRows", "excel.insertRows", "excel.deleteRows", "excel.clearRange"]],
    ["sheet", ["excel.addSheet", "excel.renameSheet", "excel.copySheet", "excel.deleteSheet"]],
    ["arrange", ["excel.sort", "excel.filter", "excel.format", "excel.pivot", "excel.recalculate"]],
    ["output", ["excel.saveAs", "excel.exportPdf", "excel.runMacro"]],
  ],
  word: [["", ["word.fillTemplate", "word.readText", "word.replaceText", "word.readTables", "word.exportPdf"]]],
  outlook: [["", ["mail.list", "mail.saveAttachments", "mail.move", "mail.markRead", "mail.delete", "mail.createDraft", "mail.reply", "mail.forward", "mail.sendDraft", "mail.send"]]],
  file: [
    ["read", ["file.readCsv", "file.readText", "pdf.readText", "config.read"]],
    ["write", ["file.writeCsv", "file.writeText"]],
    ["manage", ["file.list", "file.exists", "file.copy", "file.move", "file.delete", "file.createFolder"]],
    ["zipPdf", ["file.zip", "file.unzip", "pdf.merge", "pdf.split", "pdf.extractPages"]],
  ],
  windows: [
    ["open", ["desktop.launch", "sap.runTransaction", "desktop.setWindow", "desktop.closeWindow"]],
    [
      "operate",
      ["desktop.click", "desktop.setValue", "desktop.select", "desktop.check", "desktop.selectMenu", "desktop.type", "desktop.press", "desktop.mouseClick", "desktop.hover", "desktop.drag", "desktop.scroll", "desktop.mouseScroll"],
    ],
    ["read", ["desktop.getValue", "desktop.getTable", "desktop.readText", "desktop.isVisible", "desktop.screenshot"]],
    ["wait", ["desktop.waitFor"]],
  ],
  network: [["", ["http.request", "oauth.signIn"]]],
  database: [["", ["db.query", "db.execute"]]],
  system: [
    ["dialog", ["dialog.message", "dialog.input", "dialog.form", "dialog.selectFile"]],
    ["system", ["clipboard.get", "clipboard.set", "process.run", "process.list", "process.kill"]],
  ],
  control: [
    ["branch", ["control.if", "control.switch", "control.parallel"]],
    ["loop", ["control.forEach", "control.repeat", "control.while", "control.break", "control.continue"]],
    ["error", ["control.try", "control.group", "control.fail"]],
    ["call", ["flow.call"]],
  ],
  variable: [["", ["variable.set"]]],
  flow: [["", ["flow.delay", "wait.until"]]],
  log: [["", ["log.message"]]],
};

const PLACE = new Map<string, { sub: string; order: number }>();
for (const subs of Object.values(SUBGROUPS)) {
  let order = 0;
  for (const [sub, types] of subs) for (const type of types) PLACE.set(type, { sub, order: order++ });
}

/**
 * What usually comes next after a node (or inside a block, "type:block"):
 * offered first when adding right after it, the way an Excel read is
 * followed by a loop over its rows.
 */
const NEXT: Record<string, string[]> = {
  "browser.open": ["browser.fill", "browser.click", "browser.getText"],
  "browser.attach": ["browser.click", "browser.fill", "browser.getText"],
  "browser.fill": ["browser.fill", "browser.click", "browser.press"],
  "browser.click": ["browser.waitFor", "browser.getText", "browser.fill"],
  "browser.getTable": ["control.forEach", "excel.writeRange", "file.writeCsv"],
  "browser.download": ["file.move", "excel.readRows", "file.readCsv"],
  "excel.readRows": ["control.forEach", "excel.writeCell"],
  "excel.readRange": ["control.forEach", "excel.writeRange"],
  "file.readCsv": ["control.forEach", "excel.writeRange"],
  "file.list": ["control.forEach", "file.move"],
  "mail.list": ["control.forEach", "mail.saveAttachments"],
  "db.query": ["control.forEach", "excel.writeRange", "file.writeCsv"],
  "desktop.launch": ["desktop.waitFor", "desktop.setValue", "desktop.click"],
  "desktop.setValue": ["desktop.setValue", "desktop.click", "desktop.press"],
  "desktop.click": ["desktop.waitFor", "desktop.getValue", "desktop.setValue"],
  "word.fillTemplate": ["mail.createDraft", "file.copy"],
  "dialog.input": ["control.if", "variable.set"],
  "dialog.selectFile": ["excel.readRows", "file.readCsv"],
  "control.forEach:body": ["browser.fill", "excel.writeCell", "control.if"],
  "control.repeat:body": ["browser.click", "control.if", "control.break"],
  "control.while:body": ["browser.click", "control.if", "control.break"],
  "control.try:catch": ["log.message", "dialog.message", "mail.send"],
};

/** Up to 3 nodes that usually follow `key` (a step type, or "type:block" for an empty block). */
export function nextAfter(items: readonly PaletteItem[], key: string | undefined): PaletteItem[] {
  if (!key) return [];
  const byKey = new Map(items.map((i) => [i.key, i]));
  return (NEXT[key] ?? []).flatMap((k) => byKey.get(k) ?? []).slice(0, 3);
}

/** Node types that only exist inside another one. */
const UNLISTED = new Set(["control.case"]);

/** Office steps are listed by application: people look for "Excel", not "Office". */
const OFFICE_APPS: Record<string, string> = { excel: "excel", word: "word", mail: "outlook" };

export function groupOf(def: Pick<StepTypeDef, "type" | "category">): string {
  // An extension's nodes are listed under the extension ("Azure AI-OCR"), as people look for it by name.
  const ext = extensionOf(def.type);
  if (ext) return extensionGroup(ext);
  if (def.category === "office") return OFFICE_APPS[def.type.split(".")[0] ?? ""] ?? "office";
  return def.category;
}

export const groupLabel = (group: string): string => {
  const ext = groupExtension(group);
  if (ext) return ext.label || ext.name;
  return (t.categories as Record<string, string>)[group] ?? group;
};

/** Lower case, NFKC (full-width → half-width), katakana → hiragana. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** `normalize`, remembering which characters were katakana ("K") before. */
export function normalizeMarked(text: string): Text {
  const nfkc = text.normalize("NFKC").toLowerCase();
  return { text: normalize(nfkc), kata: nfkc.replace(/[ァ-ヶー]/g, "K").replace(/[^K]/g, ".") };
}

/**
 * Readings of the words in node names and their other names, so a search
 * finds them while the IME still shows kana (まつ → 待機, よむ → 読む).
 */
const READINGS: [string, string][] = [
  ["読む", "よむ"], ["読み", "よみ"], ["書く", "かく"], ["書き", "かき"], ["入力", "にゅうりょく"], ["入れる", "いれる"],
  ["開く", "ひらく"], ["閉じる", "とじる"], ["待つ", "まつ"], ["待機", "たいき"], ["繰り返し", "くりかえし"], ["条件", "じょうけん"],
  ["分岐", "ぶんき"], ["変数", "へんすう"], ["代入", "だいにゅう"], ["表示", "ひょうじ"], ["保存", "ほぞん"], ["削除", "さくじょ"],
  ["消す", "けす"], ["移動", "いどう"], ["名前", "なまえ"], ["変更", "へんこう"], ["一覧", "いちらん"], ["探す", "さがす"],
  ["検索", "けんさく"], ["取得", "しゅとく"], ["起動", "きどう"], ["実行", "じっこう"], ["押す", "おす"], ["選ぶ", "えらぶ"],
  ["選択", "せんたく"], ["確認", "かくにん"], ["追加", "ついか"], ["作成", "さくせい"], ["作る", "つくる"], ["圧縮", "あっしゅく"],
  ["展開", "てんかい"], ["解凍", "かいとう"], ["添付", "てんぷ"], ["送信", "そうしん"], ["下書き", "したがき"], ["差し込", "さしこ"],
  ["文字", "もじ"], ["表", "ひょう"], ["画像", "がぞう"], ["例外", "れいがい"], ["計算", "けいさん"], ["式", "しき"],
  ["記録", "きろく"], ["出力", "しゅつりょく"], ["抜ける", "ぬける"], ["並行", "へいこう"], ["同時", "どうじ"], ["回数", "かいすう"],
  ["設定", "せってい"], ["通知", "つうち"], ["認証", "にんしょう"], ["終了", "しゅうりょう"], ["貼り付け", "はりつけ"], ["存在", "そんざい"],
  ["範囲", "はんい"], ["行", "ぎょう"], ["文章", "ぶんしょう"], ["帳票", "ちょうひょう"], ["請求書", "せいきゅうしょ"], ["時間", "じかん"],
  ["分ける", "わける"], ["場合", "ばあい"], ["聞く", "きく"], ["中断", "ちゅうだん"], ["呼ぶ", "よぶ"], ["呼び出し", "よびだし"],
  ["値", "あたい"], ["数値", "すうち"], ["日付", "ひづけ"], ["今日", "きょう"], ["合計", "ごうけい"], ["件数", "けんすう"],
];

function readings(text: string): string {
  return READINGS.flatMap(([word, kana]) => (text.includes(word) ? [kana] : [])).join(" ");
}

/** The first sentence of a description: enough to tell nodes apart. */
function firstSentence(text: string): string {
  // "e.g." and "i.e." do not end a sentence.
  const end = text.search(/(?<!\b(?:e\.g|i\.e))\.\s|。/);
  return end < 0 ? text : text.slice(0, end + 1);
}

/** What a node does, in a line, in the current language. */
export function stepSummary(type: string, description?: string | null): string {
  return t.stepHelp[type]?.summary ?? (extensionSummary(type) || firstSentence(description ?? ""));
}

function stepItem(def: StepTypeDef, at: number): PaletteItem {
  const group = groupOf(def);
  const label = stepLabel(def.type, def.label);
  const help = t.stepHelp[def.type];
  // The English name and words find a node in Japanese too (click, open, read…), and the other way round.
  const english = `${en.stepTypes[def.type] ?? ""} ${en.stepHelp[def.type]?.words ?? ""}`;
  const place = PLACE.get(def.type);
  return {
    key: def.type,
    group,
    label,
    keyword: KEYWORD[def.type],
    summary: stepSummary(def.type, def.description),
    type: def.type,
    sub: place?.sub || undefined,
    order: place?.order ?? 1000 + at,
    find: {
      label: normalizeMarked(label),
      strong: normalizeMarked(
        `${def.label} ${def.type} ${KEYWORD[def.type] ?? ""} ${help?.words ?? ""} ${english} ${groupLabel(group)} ${readings(`${def.label} ${help?.words ?? ""}`)}`,
      ),
      weak: normalizeMarked(`${help?.summary ?? ""} ${extensionSummary(def.type) ?? ""} ${def.description ?? ""}`),
    },
  };
}

function presetItems(): PaletteItem[] {
  return presets().map((preset, at) => ({
    key: preset.key,
    group: preset.category,
    label: preset.label,
    keyword: preset.keyword,
    // What it does in words: the expression it writes is for the form to show, not the list.
    summary: preset.description,
    type: "variable.set",
    params: { name: preset.name, expression: preset.expression },
    order: at,
    find: {
      label: normalizeMarked(preset.label),
      strong: normalizeMarked(`${preset.keyword} ${groupLabel(preset.category)} ${readings(`${preset.label} ${preset.description}`)}`),
      weak: normalizeMarked(`${preset.description} ${preset.expression}`),
    },
  }));
}

/**
 * The flows that take inputs or give outputs, as nodes of their own: adding
 * one adds a `flow.call` to it, so a flow made to be reused is found by
 * its name like any other node instead of through "call a flow" and a list.
 * Flows with neither are left out: they are usually whole jobs, not parts.
 */
function flowItems(flows: readonly FlowSummary[], openId: string | undefined): PaletteItem[] {
  return flows
    .filter((f) => f.id !== openId && ((f.inputs?.length ?? 0) > 0 || (f.outputs?.length ?? 0) > 0))
    .map((f, at) => {
      const shape = t.palette.flowShape(f.inputs ?? [], f.outputs ?? []);
      return {
        key: `flow:${f.id}`,
        group: "subflow",
        label: f.name,
        summary: f.description.trim() ? firstSentence(f.description.trim()) : shape,
        type: "flow.call",
        params: { flow: f.id },
        order: at,
        find: {
          // The name is all a flow has to go by, so its kana reading counts as the name.
          label: normalizeMarked(`${f.name} ${readings(f.name)}`),
          strong: normalizeMarked(`${groupLabel("subflow")} ${(f.tags ?? []).join(" ")}`),
          weak: normalizeMarked(`${f.description} ${shape}`),
        },
      };
    });
}

/** Every line the palette can show. `flows` and `openId` add the reusable flows (not the open one). */
export function paletteItems(defs: readonly StepTypeDef[], flows: readonly FlowSummary[] = [], openId?: string): PaletteItem[] {
  // A case is added from its switch ("ケースを追加"), never on its own.
  const listed = defs.filter((d) => !UNLISTED.has(d.type));
  // Each group in the order people reach for its nodes (SUBGROUPS), not registry order.
  const steps = listed.map(stepItem).sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order);
  return [...steps, ...flowItems(flows, openId), ...presetItems()];
}

const rank = (group: string) => {
  const at = ORDER.indexOf(group);
  return at < 0 ? ORDER.length : at;
};

/** The groups that have items, in palette order, with their counts. Unknown (plugin) groups go last. */
export function groups(items: readonly PaletteItem[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
  return [...counts].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/** The section a group is listed under. */
export function sectionOf(group: string): string {
  return SECTIONS.find((s) => s.groups.includes(group))?.id ?? "other";
}

/**
 * How `text` contains `word`: 2 as a whole word or the start of a Japanese
 * compound, 1 as only the start of a longer katakana word ("ログ" in
 * "ログイン"), 0 not at all. Latin words must start a word ("read" is not in
 * "already"). Japanese has no spaces, so it matches anywhere except the
 * middle of a katakana word: "ログ" is not in "ダイアログ", nor "ループ" in
 * "グループ".
 */
function has({ text, kata }: Text, word: string): 0 | 1 | 2 {
  const latin = /^[a-z0-9]/.test(word);
  let best: 0 | 1 | 2 = 0;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (latin) {
      if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return 2;
      continue;
    }
    if (at > 0 && kata[at - 1] === "K" && kata[at] === "K") continue;
    const end = at + word.length;
    if (kata[end - 1] === "K" && kata[end] === "K") best = 1;
    else return 2;
  }
  return best;
}

/** How well `item` matches one query word; 0 when it does not. */
function wordScore(item: PaletteItem, word: string): number {
  const { label, strong, weak } = item.find;
  if (label.text === word) return 120;
  const inLabel = has(label, word);
  if (inLabel && label.text.startsWith(word)) return inLabel === 2 ? 100 : 60;
  if (inLabel === 2) return 70;
  const inStrong = has(strong, word);
  if (inStrong === 2) return 40;
  if (inLabel === 1) return 30;
  if (inStrong === 1) return 15;
  return has(weak, word) === 2 ? 10 : 0;
}

/** The better of `word` as typed and read as romaji (kurikaesi → くりかえし). */
function bestScore(item: PaletteItem, word: string, kana: string | null): number {
  const typed = wordScore(item, word);
  return kana ? Math.max(typed, wordScore(item, kana)) : typed;
}

/**
 * The items matching every word of `query`, best first: a word in the name
 * beats one in the other names people use, which beats one in the
 * description. Ties keep palette order; recently added nodes win a little.
 */
export function search(items: readonly PaletteItem[], query: string, recent: readonly string[] = []): PaletteItem[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  const kana = words.map(toKana);
  const scored: { item: PaletteItem; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    let score = 0;
    for (const [i, word] of words.entries()) {
      const s = bestScore(item, word, kana[i]!);
      if (s === 0) return;
      score += s;
    }
    // Among equal matches, the nodes people use most come first (行の読み取り before シート追加).
    if (COMMON.includes(item.key)) score += 4;
    const used = recent.indexOf(item.key);
    if (used >= 0) score += 8 - Math.min(used, 7);
    scored.push({ item, score, at });
  });
  // A word only in the long descriptions is noise once some node has it in its name or other names
  // ("click" is in the description of half the browser nodes).
  const best = Math.max(0, ...scored.map((s) => s.score / words.length));
  return scored
    .filter((s) => best < 30 || s.score / words.length >= 15)
    .sort((a, b) => b.score - a.score || rank(a.item.group) - rank(b.item.group) || a.item.order - b.item.order || a.at - b.at)
    .map((s) => s.item);
}

/**
 * The opening view, split by kind so working on an app and steering the
 * flow are not one mixed list: per section ("apps", "flow", "data"), the
 * recently added nodes first, then the common ones (4 operations, 6 of the others). Sections
 * in palette order; empty ones left out.
 */
export function frequentBySection(items: readonly PaletteItem[], recent: readonly string[], skip: ReadonlySet<string> = new Set()): [string, PaletteItem[]][] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const keys = [...new Set([...recent, ...COMMON])];
  const out = new Map<string, PaletteItem[]>();
  for (const k of keys) {
    const item = byKey.get(k);
    if (!item || skip.has(k)) continue;
    const section = sectionOf(item.group);
    const list = out.get(section) ?? [];
    // Data handling only shows what was used: its common forms are a click away on the left.
    // Four operations leave room for the flow-control tiles below them without scrolling.
    if (list.length < (section === "apps" ? 4 : 6) && (section !== "data" || recent.includes(k))) out.set(section, [...list, item]);
  }
  return [...SECTIONS.map((s) => s.id), "other"].flatMap((id) => (out.get(id)?.length ? [[id, out.get(id)!] as [string, PaletteItem[]]] : []));
}

/** Search results under the same section headings, best match first within each. */
export function bySection(found: readonly PaletteItem[]): [string, PaletteItem[]][] {
  const out = new Map<string, PaletteItem[]>();
  for (const item of found) {
    const section = sectionOf(item.group);
    out.set(section, [...(out.get(section) ?? []), item]);
  }
  // The section of the best match first ("ログ" finds ログ出力 before 文字入力's "ログイン").
  return [...out];
}

/** The frequent view: up to 6 recently added, then the common nodes not among them. */
export function frequent(items: readonly PaletteItem[], recent: readonly string[]): { recent: PaletteItem[]; common: PaletteItem[] } {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const used = recent.flatMap((k) => byKey.get(k) ?? []).slice(0, 6);
  const taken = new Set(used.map((i) => i.key));
  const common = COMMON.flatMap((k) => (taken.has(k) ? [] : (byKey.get(k) ?? [])));
  return { recent: used, common };
}

const RECENT_KEY = "spellsheet.studio.recentNodes";

export function loadRecent(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** Puts `key` first in the recent list (kept to 12). */
export function remember(recent: readonly string[], key: string): string[] {
  const next = [key, ...recent.filter((k) => k !== key)].slice(0, 12);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Only a convenience.
  }
  return next;
}

const APP_GROUPS = new Set(SECTIONS.find((s) => s.id === "apps")?.groups ?? []);

/**
 * Where a node works, for its header: "ブラウザ", "デスクトップアプリ",
 * "Excel"… so 「文字入力」 says which screen it types into. Null for nodes
 * that work on nothing outside, and when the name already says it
 * ("Word 読み取り").
 */
export function appTag(def: Pick<StepTypeDef, "type" | "category"> | undefined, title: string): string | null {
  if (!def) return null;
  const ext = extensionOf(def.type);
  if (ext) {
    const tag = extensionTag(ext);
    return title.includes(tag) ? null : tag;
  }
  const group = groupOf(def);
  if (!APP_GROUPS.has(group) || group === "system") return null;
  const label = groupLabel(group);
  return title.includes(label) ? null : label;
}
