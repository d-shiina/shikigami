// What the node palette (Ctrl+K) lists and how it finds things: the nodes in
// groups by what they work on, a "frequent" view to start from, and a search
// that ranks by how well the name matches and forgives the ways Japanese can
// be written (katakana / hiragana, full / half width).
import type { FlowSummary, StepTypeDef } from "@shikigami/schema";
import { stepLabel, t } from "./i18n";
import { KEYWORD } from "./keywords";
import { presets } from "./presets";

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
  /** Normalised text, by how much a match in it counts. */
  find: { label: string; strong: string; weak: string };
};

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
  "control.if",
  "control.forEach",
  "variable.set",
  "dialog.message",
  "log.message",
];

/** Node types that only exist inside another one. */
const UNLISTED = new Set(["control.case"]);

/** Office steps are listed by application: people look for "Excel", not "Office". */
const OFFICE_APPS: Record<string, string> = { excel: "excel", word: "word", mail: "outlook" };

export function groupOf(def: Pick<StepTypeDef, "type" | "category">): string {
  if (def.category === "office") return OFFICE_APPS[def.type.split(".")[0] ?? ""] ?? "office";
  return def.category;
}

export const groupLabel = (group: string): string => (t.categories as Record<string, string>)[group] ?? group;

/** Lower case, NFKC (full-width → half-width), katakana → hiragana. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
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
  return t.stepHelp[type]?.summary ?? firstSentence(description ?? "");
}

function stepItem(def: StepTypeDef): PaletteItem {
  const group = groupOf(def);
  const label = stepLabel(def.type, def.label);
  const help = t.stepHelp[def.type];
  return {
    key: def.type,
    group,
    label,
    keyword: KEYWORD[def.type],
    summary: stepSummary(def.type, def.description),
    type: def.type,
    find: {
      label: normalize(label),
      strong: normalize(
        `${def.label} ${def.type} ${KEYWORD[def.type] ?? ""} ${help?.words ?? ""} ${groupLabel(group)} ${readings(`${def.label} ${help?.words ?? ""}`)}`,
      ),
      weak: normalize(`${help?.summary ?? ""} ${def.description ?? ""}`),
    },
  };
}

function presetItems(): PaletteItem[] {
  return presets().map((preset) => ({
    key: preset.key,
    group: preset.category,
    label: preset.label,
    keyword: preset.keyword,
    summary: `${preset.description}　${preset.name} ← ${preset.expression}`,
    type: "variable.set",
    params: { name: preset.name, expression: preset.expression },
    find: {
      label: normalize(preset.label),
      strong: normalize(`${preset.keyword} ${groupLabel(preset.category)} ${readings(`${preset.label} ${preset.description}`)}`),
      weak: normalize(`${preset.description} ${preset.expression}`),
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
    .map((f) => {
      const shape = t.palette.flowShape(f.inputs ?? [], f.outputs ?? []);
      return {
        key: `flow:${f.id}`,
        group: "subflow",
        label: f.name,
        summary: f.description.trim() ? firstSentence(f.description.trim()) : shape,
        type: "flow.call",
        params: { flow: f.id },
        find: {
          // The name is all a flow has to go by, so its kana reading counts as the name.
          label: normalize(`${f.name} ${readings(f.name)}`),
          strong: normalize(`${groupLabel("subflow")} ${(f.tags ?? []).join(" ")}`),
          weak: normalize(`${f.description} ${shape}`),
        },
      };
    });
}

/** Every line the palette can show. `flows` and `openId` add the reusable flows (not the open one). */
export function paletteItems(defs: readonly StepTypeDef[], flows: readonly FlowSummary[] = [], openId?: string): PaletteItem[] {
  // A case is added from its switch ("ケースを追加"), never on its own.
  const listed = defs.filter((d) => !UNLISTED.has(d.type));
  return [...listed.map(stepItem), ...flowItems(flows, openId), ...presetItems()];
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
 * Whether `text` contains `word`. Latin words must start a word ("read" is
 * not in "already"); Japanese has no spaces, so it matches anywhere.
 */
function has(text: string, word: string): boolean {
  if (!/^[a-z0-9]/.test(word)) return text.includes(word);
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return true;
  }
  return false;
}

/** How well `item` matches one query word; 0 when it does not. */
function wordScore(item: PaletteItem, word: string): number {
  const { label, strong, weak } = item.find;
  if (label === word) return 120;
  if (label.startsWith(word)) return 100;
  if (has(label, word)) return 70;
  if (has(strong, word)) return 40;
  if (has(weak, word)) return 10;
  return 0;
}

/**
 * The items matching every word of `query`, best first: a word in the name
 * beats one in the other names people use, which beats one in the
 * description. Ties keep palette order; recently added nodes win a little.
 */
export function search(items: readonly PaletteItem[], query: string, recent: readonly string[] = []): PaletteItem[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  const scored: { item: PaletteItem; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    let score = 0;
    for (const word of words) {
      const s = wordScore(item, word);
      if (s === 0) return;
      score += s;
    }
    const used = recent.indexOf(item.key);
    if (used >= 0) score += 8 - Math.min(used, 7);
    scored.push({ item, score, at });
  });
  return scored
    .sort((a, b) => b.score - a.score || rank(a.item.group) - rank(b.item.group) || a.at - b.at)
    .map((s) => s.item);
}

/** The frequent view: up to 6 recently added, then the common nodes not among them. */
export function frequent(items: readonly PaletteItem[], recent: readonly string[]): { recent: PaletteItem[]; common: PaletteItem[] } {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const used = recent.flatMap((k) => byKey.get(k) ?? []).slice(0, 6);
  const taken = new Set(used.map((i) => i.key));
  const common = COMMON.flatMap((k) => (taken.has(k) ? [] : (byKey.get(k) ?? [])));
  return { recent: used, common };
}

const RECENT_KEY = "shikigami.studio.recentNodes";

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
  const group = groupOf(def);
  if (!APP_GROUPS.has(group) || group === "system") return null;
  const label = groupLabel(group);
  return title.includes(label) ? null : label;
}
