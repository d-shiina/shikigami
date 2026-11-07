// Reads a step as a sentence for the 手順書 view, in Japanese or English.
// Display only: it looks at a step's type and params and never changes or
// interprets them beyond choosing words, so an unknown type still reads as
// its label. Word order differs between the languages, so each has its own
// builders rather than dictionary entries.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { locale, stepLabel, t } from "./i18n";
import { choiceLabel, columnOf, type Match, recognize, slotsOf, splitParts, textOf, valueKind, wordsOf } from "./transforms";

/** Plain words, or a value shown as a code chip (expressions, variables). */
export type Part = { text: string } | { code: string };

const w = (text: string): Part => ({ text });

const PATH = String.raw`([A-Za-z_][\w.]*(?:\[\d+\])?)`;
/** Built-in functions that read better as words. The flow keeps the expression as written. */
const fn = (name: string) => new RegExp(String.raw`\b${name}\(${PATH}\)`, "g");
const SYMBOLS: [RegExp, string][] = [
  [/\s*>=\s*/g, " ≥ "],
  [/\s*<=\s*/g, " ≤ "],
  [/\s*!=\s*/g, " ≠ "],
  [/\s*==\s*/g, " = "],
];
const WORDS: Record<"ja" | "en", [RegExp, string][]> = {
  ja: [
    [fn("len"), "$1の件数"],
    [fn("sum"), "$1の合計"],
    [new RegExp(String.raw`!isEmpty\(${PATH}\)`, "g"), "$1が空でない"],
    [fn("isEmpty"), "$1が空"],
    [/\s*&&\s*/g, " かつ "],
    [/\s*\|\|\s*/g, " または "],
    ...SYMBOLS,
  ],
  en: [
    [fn("len"), "count of $1"],
    [fn("sum"), "sum of $1"],
    [new RegExp(String.raw`!isEmpty\(${PATH}\)`, "g"), "$1 is not empty"],
    [fn("isEmpty"), "$1 is empty"],
    [/\s*&&\s*/g, " and "],
    [/\s*\|\|\s*/g, " or "],
    ...SYMBOLS,
  ],
};

/** An expression as it reads on screen: `len(invoices)` becomes `invoicesの件数` (`count of invoices`). */
export function readable(expr: string): string {
  return WORDS[locale].reduce((text, [pattern, words]) => text.replace(pattern, words), expr);
}

function code(value: unknown): Part {
  if (value === undefined || value === null || value === "") return { text: locale === "ja" ? "（未設定）" : "(not set)" };
  return { code: typeof value === "string" ? readable(value) : JSON.stringify(value) };
}

/** The values a case compares to, as literals: 「A」「B」 / "A", "B". */
function caseValues(values: unknown, sep: string): Part[] {
  const list = Array.isArray(values) ? values : [];
  return list.flatMap((v, i) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    const quoted = locale === "ja" ? `「${text}」` : `"${text}"`;
    return [...(i > 0 ? [w(sep)] : []), ...(typeof v === "string" && v.includes("{{") ? template(v) : [w(quoted)])];
  });
}

/** A case: the values it matches, or its condition, or both. */
function caseParts(p: Record<string, unknown>): Part[] {
  const ja = locale === "ja";
  const values = Array.isArray(p.values) && p.values.length > 0 ? caseValues(p.values, ja ? "・" : ", ") : [];
  const condition = typeof p.condition === "string" && p.condition !== "" ? [code(p.condition)] : [];
  if (ja) {
    if (values.length > 0 && condition.length > 0) return [...values, w(" か "), ...condition, w(" のとき")];
    if (values.length > 0) return [w("値が "), ...values, w(" のとき")];
    if (condition.length > 0) return [...condition, w(" のとき")];
    return [w("（値が未設定）")];
  }
  if (values.length > 0 && condition.length > 0) return [w("Case "), ...values, w(" or "), ...condition];
  if (values.length > 0) return [w("Case "), ...values];
  if (condition.length > 0) return [w("Case "), ...condition];
  return [w("Case (no value set)")];
}

/** A literal with `{{ expr }}` holes: the words stay words, the holes become chips. */
function template(value: unknown): Part[] {
  if (typeof value !== "string" || !value.includes("{{")) return [code(value)];
  return value
    .split(/(\{\{.*?\}\})/)
    .filter((piece) => piece !== "")
    .map((piece) => (piece.startsWith("{{") ? { code: readable(piece.slice(2, -2).trim()) } : w(piece)));
}

/** A browser target such as { role: "button", name: "ログイン" }, or a desktop one, in words. */
export function targetText(target: unknown): string {
  const text = locale === "ja" ? targetJa(target) : targetEn(target);
  const frame = target && typeof target === "object" ? (target as Record<string, unknown>).frame : undefined;
  return frame ? `${text}${frameText(frame)}` : text;
}

/** "（フレーム「main」の中）": where an element inside an iframe is. */
function frameText(frame: unknown): string {
  if (!frame || typeof frame !== "object") return "";
  const f = frame as Record<string, unknown>;
  const name = String(f.name ?? f.title ?? f.src ?? f.css ?? "");
  const outer = f.frame ? frameText(f.frame) : "";
  return locale === "ja" ? `（フレーム「${name}」の中）${outer}` : ` in the frame "${name}"${outer}`;
}

/** What a step answers to the JS dialog it causes, if it says. */
function dialogText(dialog: unknown): string {
  const action = typeof dialog === "string" ? dialog : dialog && typeof dialog === "object" ? (dialog as Record<string, unknown>).action : undefined;
  if (action !== "accept" && action !== "dismiss") return "";
  if (locale === "ja") return action === "accept" ? "て、確認に OK で答える" : "て、確認をキャンセルする";
  return action === "accept" ? ", answering OK to the dialog" : ", cancelling the dialog";
}

/** The file name at the end of a Windows or POSIX path. */
const fileName = (path: unknown) => String(path ?? "").split(/[\\/]/).pop() ?? "";

/** A desktop target ({ window, element | image | ocr | region | point }) in words. */
function desktopJa(t: Record<string, unknown>): string {
  const win = (t.window ?? {}) as Record<string, unknown>;
  const name = `「${String(win.title ?? win.process ?? win.className ?? "")}」`;
  const image = t.image as Record<string, unknown> | undefined;
  const ocr = t.ocr as Record<string, unknown> | undefined;
  const region = t.region as Record<string, number> | undefined;
  const point = t.point as Record<string, number> | undefined;
  const nth = (q: Record<string, unknown> | undefined) => (typeof q?.nth === "number" ? `の${q.nth + 1}番目` : "");
  if (image) return `${name}の画像 ${fileName(image.path)}${nth(image)}`;
  if (ocr) return `${name}の文字「${String(ocr.text ?? "")}」${nth(ocr)}`;
  if (point) return `${name}の座標 (${point.x}, ${point.y})`;
  if (region) return `${name}の範囲 (${region.x}, ${region.y}, ${region.width}×${region.height})`;
  const el = t.element as Record<string, unknown> | undefined;
  if (!el) return `${name}ウィンドウ`;
  if (el.id) return `${name}の [${el.id}]${nth(el)}`;
  return `${name}の${targetJa(el)}`;
}

function desktopEn(t: Record<string, unknown>): string {
  const win = (t.window ?? {}) as Record<string, unknown>;
  const name = `"${String(win.title ?? win.process ?? win.className ?? "")}"`;
  const image = t.image as Record<string, unknown> | undefined;
  const ocr = t.ocr as Record<string, unknown> | undefined;
  const region = t.region as Record<string, number> | undefined;
  const point = t.point as Record<string, number> | undefined;
  const nth = (q: Record<string, unknown> | undefined) => (typeof q?.nth === "number" ? ` #${q.nth + 1}` : "");
  if (image) return `the image ${fileName(image.path)}${nth(image)} in ${name}`;
  if (ocr) return `the text "${String(ocr.text ?? "")}"${nth(ocr)} in ${name}`;
  if (point) return `the point (${point.x}, ${point.y}) in ${name}`;
  if (region) return `the area (${region.x}, ${region.y}, ${region.width}×${region.height}) of ${name}`;
  const el = t.element as Record<string, unknown> | undefined;
  if (!el) return `the ${name} window`;
  if (el.id) return `[${el.id}]${nth(el)} in ${name}`;
  return `${targetEn(el)} in ${name}`;
}

/** The open flow's parts, for `{ part: "<name>" }` targets (set by the store). */
let partLookup: (name: string) => { label?: string } | undefined = () => undefined;
export function setPartLookup(lookup: typeof partLookup) {
  partLookup = lookup;
}
const partName = (target: unknown): string | undefined => {
  const t = target as Record<string, unknown> | null;
  if (!t || typeof t !== "object" || Object.keys(t).length !== 1 || typeof t.part !== "string") return undefined;
  return partLookup(t.part)?.label || t.part;
};

function targetJa(target: unknown): string {
  if (!target || typeof target !== "object") return "（要素未設定）";
  const part = partName(target);
  if (part) return `部品「${part}」`;
  const t = target as Record<string, unknown>;
  if (t.window) return desktopJa(t);
  const nth = typeof t.nth === "number" ? `の${t.nth + 1}番目` : "";
  if (t.label) return `「${t.label}」欄${nth}`;
  if (t.role && t.name) return `「${t.name}」${ROLE[String(t.role)] ?? String(t.role)}${nth}`;
  if (t.text) return `「${t.text}」${nth}`;
  if (t.name) return `「${t.name}」${nth}`;
  if (t.placeholder) return `「${t.placeholder}」欄${nth}`;
  if (t.role) return `${ROLE[String(t.role)] ?? String(t.role)}${nth}`;
  if (t.testId) return `[${t.testId}]${nth}`;
  if (t.css) return `${t.css}${nth}`;
  return "（要素未設定）";
}

function targetEn(target: unknown): string {
  if (!target || typeof target !== "object") return "(no element set)";
  const part = partName(target);
  if (part) return `the part "${part}"`;
  const t = target as Record<string, unknown>;
  if (t.window) return desktopEn(t);
  const nth = typeof t.nth === "number" ? ` #${t.nth + 1}` : "";
  const role = (r: unknown) => ROLE_EN[String(r)] ?? String(r);
  if (t.label) return `the "${t.label}" field${nth}`;
  if (t.role && t.name) return `the "${t.name}" ${role(t.role)}${nth}`;
  if (t.text) return `"${t.text}"${nth}`;
  if (t.name) return `"${t.name}"${nth}`;
  if (t.placeholder) return `the "${t.placeholder}" field${nth}`;
  if (t.role) return `the ${role(t.role)}${nth}`;
  if (t.testId) return `[${t.testId}]${nth}`;
  if (t.css) return `${t.css}${nth}`;
  return "(no element set)";
}

const ROLE_EN: Record<string, string> = {
  textbox: "field",
  combobox: "drop-down",
};

const ROLE: Record<string, string> = {
  button: "ボタン",
  link: "リンク",
  textbox: "欄",
  heading: "見出し",
  table: "表",
  cell: "セル",
  row: "行",
  checkbox: "チェックボックス",
  combobox: "選択欄",
};

/**
 * Names of the workspace's flows by id, so a call reads as the flow
 * it runs. Studio keeps it in step with the flow list.
 */
let flowNames: ReadonlyMap<string, string> = new Map();

export function setFlowNames(names: ReadonlyMap<string, string>) {
  flowNames = names;
}

/** What a call's target reads as: its name, or its id when it is not in this workspace. */
export function calledName(id: unknown): string | null {
  if (typeof id !== "string" || id === "") return null;
  return flowNames.get(id) ?? id;
}

type Builder = (p: Record<string, unknown>, step: Step) => Part[];

/** A value slot as it reads: text in brackets, today as a word, a variable as a chip. */
function valuePart(source: string): Part {
  const text = textOf(source);
  if (text !== null) return w(locale === "ja" ? `「${text}」` : `“${text}”`);
  const kind = valueKind(source);
  if (kind === "today" || kind === "now") return w(t.transforms.kinds[kind]);
  if (kind === "number") return w(source);
  return code(source);
}

/** What a recognised expression is, in words: "rows の「金額」の合計". */
export function transformPhrase(match: Match): Part[] {
  const kinds = new Map(slotsOf(match.def).map((s) => [s.name, s.kind]));
  const out: Part[] = [];
  for (const piece of wordsOf(match.def).phrase.split(/(\{\w+\})/)) {
    const slot = /^\{(\w+)\}$/.exec(piece)?.[1];
    if (!slot) {
      if (piece) out.push(w(piece));
      continue;
    }
    const value = match.slots[slot] ?? "";
    const kind = kinds.get(slot);
    if (kind === "choice") out.push(w(choiceLabel(slot, value)));
    else if (kind === "col") out.push(w(columnOf(value)));
    else if (kind === "num") out.push(w(value));
    else if (kind === "parts") splitParts(value).forEach((p, i) => out.push(...(i > 0 ? [w(" + ")] : []), valuePart(p)));
    else out.push(valuePart(value));
  }
  return out;
}

/** A node's kind as its header shows it: a recognised "変数への代入" by its form ("表の列を集計"). */
export function typeTitle(step: Step, def: StepTypeDef | undefined): string {
  const match = step.type === "variable.set" && step.params?.value === undefined ? recognize(step.params?.expression) : null;
  return match ? wordsOf(match.def).label : stepLabel(step.type, def?.label);
}

/** "total に rows の「金額」の合計 を入れる" when the expression has a form, else the expression. */
function setValue(p: Record<string, unknown>): Part[] {
  const match = p.value === undefined ? recognize(p.expression) : null;
  return match ? transformPhrase(match) : [code(p.expression ?? p.value)];
}

const BUILDERS: Record<string, Builder> = {
  "log.message": (p) => [w("「"), ...template(p.message), w(`」と${p.level === "warn" ? "警告を" : p.level === "error" ? "エラーを" : "ログに"}書く`)],
  "variable.set": (p) => {
    const value = setValue(p);
    return [code(p.name), w(" に "), ...value, w(value.at(-1) && "text" in value.at(-1)! ? "を入れる" : " を入れる")];
  },
  "control.if": (p) => [w("もし "), code(p.condition), w(" なら")],
  "control.switch": (p) => [code(p.value), w(" の値で分ける")],
  "control.case": (p) => caseParts(p),
  "control.while": (p) => [code(p.condition), w(" の間、繰り返す")],
  "control.repeat": (p) => [code(p.count), w(" 回繰り返す")],
  "control.forEach": (p) => [code(p.items), w(" を1件ずつ "), code(p.itemVar ?? "item"), w(" として繰り返す")],
  "control.try": () => [w("失敗したら catch、最後に finally")],
  "control.break": () => [w("繰り返しを抜ける")],
  "control.continue": () => [w("次の繰り返しへ進む")],
  "control.fail": (p) => [w("「"), ...template(p.message), w("」として失敗させる")],
  "flow.delay": (p) => [code(p.ms), w(" ミリ秒待つ")],
  "flow.call": (p) => {
    const name = calledName(p.flow);
    return name ? [w(`サブフロー「${name}」を呼ぶ`)] : [w("サブフローを呼ぶ（呼ぶフローが未設定）")];
  },
  "browser.open": (p) => [...template(p.url), w(" をブラウザで開く")],
  "browser.click": (p, s) =>
    p.button === "right" || p.double === true
      ? [w(`${targetText(p.target)}を${p.button === "right" ? "右クリック" : "ダブルクリック"}${dialogText(p.dialog) ? `し${dialogText(p.dialog)}` : "する"}`), ...saveAs(s)]
      : [w(`${targetText(p.target)}を押${dialogText(p.dialog) ? `し${dialogText(p.dialog)}` : "す"}`), ...saveAs(s)],
  "browser.check": (p) => [w(`${targetText(p.target)}のチェックを${p.checked === false ? "外す" : "付ける"}`)],
  "browser.navigate": (p) => [w(p.action === "back" ? "前のページに戻る" : p.action === "forward" ? "次のページに進む" : "ページを読み込み直す")],
  "browser.hover": (p) => [w(`${targetText(p.target)}にマウスを乗せる`)],
  "browser.attach": (p) => [w(p.title || p.url ? `開いているブラウザの「${String(p.title ?? p.url)}」のタブを使う` : "開いているブラウザを使う")],
  "browser.download": (p, s) => [w(`${targetText(p.target)}を押してダウンロードし、`), code(p.path ?? p.folder), w(p.path ? " に保存する" : " に保存する（名前はサイトのまま）"), ...saveAs(s)],
  "browser.upload": (p) => [w(`${targetText(p.target)}に `), code(Array.isArray(p.path) ? p.path.join(", ") : p.path), w(" を添付する")],
  "browser.scroll": (p) => [
    w(
      p.target
        ? p.to
          ? `${targetText(p.target)}の中を${p.to === "top" ? "一番上" : "一番下"}までスクロールする`
          : `${targetText(p.target)}が見えるまでスクロールする`
        : `ページを${p.to === "top" ? "一番上" : "一番下"}までスクロールする`,
    ),
  ],
  "browser.getAttribute": (p, s) => [w(`${targetText(p.target)}の `), code(p.name), w(" 属性を読む"), ...saveAs(s)],
  "browser.switchTab": (p, s) => [
    w(typeof p.index === "number" ? `${p.index + 1}番目のタブに移る` : `「${String(p.title ?? p.url ?? "")}」のタブに移る`),
    ...saveAs(s),
  ],
  "browser.closeTab": () => [w("今のタブを閉じて前のタブに戻る")],
  "browser.fill": (p) => [w(`${targetText(p.target)}に `), ...template(p.value), w(" を入れる")],
  "browser.select": (p) => [w(`${targetText(p.target)}で `), code(p.value), w(" を選ぶ")],
  "browser.press": (p) => [w(p.target ? `${targetText(p.target)}で ` : ""), code(p.key), w(` キーを押${dialogText(p.dialog) ? `し${dialogText(p.dialog)}` : "す"}`)],
  "browser.getText": (p, s) => [w(`${targetText(p.target)}の文字を読む`), ...saveAs(s)],
  "browser.getTable": (p, s) => [w(`${targetText(p.target)}を表として読む`), ...saveAs(s)],
  "browser.waitFor": (p) => [w(`${targetText(p.target)}が${p.state === "hidden" || p.state === "detached" ? "消える" : "出る"}まで待つ`)],
  "browser.screenshot": (p) => [w("画面を "), code(p.path), w(" に保存する")],
  "browser.close": () => [w("ブラウザを閉じる")],
  "desktop.launch": (p) => [code(p.path), w(" を起動する")],
  "desktop.click": (p) => [w(`${targetText(p.target)}を押す`)],
  "desktop.mouseClick": (p) => [w(`${targetText(p.target)}をマウスでクリックする`)],
  "desktop.setValue": (p) => [w(`${targetText(p.target)}に `), ...template(p.value), w(" を入れる")],
  "desktop.type": (p) => [w(`${targetText(p.target)}に `), ...template(p.text), w(" を打つ")],
  "desktop.press": (p) => [w(p.target ? `${targetText(p.target)}で ` : ""), code(p.key), w(" キーを押す")],
  "desktop.select": (p) => [w(`${targetText(p.target)}で `), code(p.value), w(" を選ぶ")],
  "desktop.getValue": (p, s) => [w(`${targetText(p.target)}の値を読む`), ...saveAs(s)],
  "desktop.readText": (p, s) => [...(p.file !== undefined && p.target === undefined ? [...template(p.file), w(" の画像の文字を OCR で読む")] : [w(`${targetText(p.target)}の文字を OCR で読む`)]), ...saveAs(s)],
  "desktop.waitFor": (p) => [w(`${targetText(p.target)}が${p.state === "hidden" ? "消える" : "出る"}まで待つ`)],
  "desktop.closeWindow": (p) => [w(`${targetText(p.target)}を閉じる`)],
  "desktop.setWindow": (p) => [w(`${targetText(p.target)}を${p.state === "maximized" ? "最大化する" : p.state === "minimized" ? "最小化する" : p.state === "normal" ? "元のサイズに戻す" : p.front === true ? "前面に出す" : "動かす"}`)],
  "desktop.check": (p) => [w(`${targetText(p.target)}のチェックを${p.checked === false ? "外す" : "付ける"}`)],
  "process.list": (p, s) => [...(p.name ? [code(p.name), w(" が動いているか調べる")] : [w("動いているプログラムを調べる")]), ...saveAs(s)],
  "process.kill": (p) => [code(p.name), w(" を終了させる")],
  "desktop.getTable": (p, s) => [w(`${targetText(p.target)}${isTargetElement(p.target) ? "" : "の最初の表"}を表として読む`), ...saveAs(s)],
  "sap.runTransaction": (p, s) => [w(`${targetText(p.target)}で SAP のトランザクション `), code(p.code), w(" を開く"), ...saveAs(s)],
  "desktop.selectMenu": (p) => [w(`${targetText(p.target)}${isTargetElement(p.target) ? "の右クリックメニュー" : ""}で `), code(menuPath(p.path)), w(" を選ぶ")],
  "desktop.scroll": (p, s) => [w(p.direction ? `${targetText(p.target)}を${DIRECTION_JA[String(p.direction)] ?? String(p.direction)}へスクロールする` : `${targetText(p.target)}が見えるまでスクロールする`), ...saveAs(s)],
  "desktop.mouseScroll": (p) => [w(`${targetText(p.target)}の上でホイールを${DIRECTION_JA[String(p.direction)] ?? String(p.direction)}へ回す`)],
  "desktop.drag": (p) => [w(`${targetText(p.target)}を${targetText(p.to)}へドラッグする`)],
  "desktop.hover": (p) => [w(`${targetText(p.target)}にマウスを重ねる`)],
};

const BUILDERS_EN: Record<string, Builder> = {
  "log.message": (p) => [w(p.level === "warn" ? "Warn " : p.level === "error" ? "Log error " : "Log "), w("\""), ...template(p.message), w("\"")],
  "variable.set": (p) => [w("Set "), code(p.name), w(" to "), ...setValue(p)],
  "control.if": (p) => [w("If "), code(p.condition)],
  "control.switch": (p) => [w("Switch on "), code(p.value)],
  "control.case": (p) => caseParts(p),
  "control.while": (p) => [w("Repeat while "), code(p.condition)],
  "control.repeat": (p) => [w("Repeat "), code(p.count), w(" times")],
  "control.forEach": (p) => [w("For each "), code(p.itemVar ?? "item"), w(" in "), code(p.items)],
  "control.try": () => [w("Try, catch on failure, finally at the end")],
  "control.break": () => [w("Exit the loop")],
  "control.continue": () => [w("Go to the next iteration")],
  "control.fail": (p) => [w("Fail with \""), ...template(p.message), w("\"")],
  "flow.delay": (p) => [w("Wait "), code(p.ms), w(" ms")],
  "flow.call": (p) => {
    const name = calledName(p.flow);
    return name ? [w(`Call the subflow "${name}"`)] : [w("Call a subflow (none chosen)")];
  },
  "browser.open": (p) => [w("Open "), ...template(p.url), w(" in the browser")],
  "browser.click": (p, s) => [
    w(`${p.button === "right" ? "Right-click" : p.double === true ? "Double-click" : "Click"} ${targetText(p.target)}${dialogText(p.dialog)}`),
    ...saveAs(s),
  ],
  "browser.check": (p) => [w(`${p.checked === false ? "Uncheck" : "Check"} ${targetText(p.target)}`)],
  "browser.navigate": (p) => [w(p.action === "back" ? "Go back a page" : p.action === "forward" ? "Go forward a page" : "Reload the page")],
  "browser.hover": (p) => [w(`Hover over ${targetText(p.target)}`)],
  "browser.attach": (p) => [w(p.title || p.url ? `Use the "${String(p.title ?? p.url)}" tab of the open browser` : "Use the open browser")],
  "browser.download": (p, s) => [w(`Click ${targetText(p.target)} and save the download to `), code(p.path ?? p.folder), w(p.path ? "" : " (keeping the site's name)"), ...saveAs(s)],
  "browser.upload": (p) => [w("Attach "), code(Array.isArray(p.path) ? p.path.join(", ") : p.path), w(` to ${targetText(p.target)}`)],
  "browser.scroll": (p) => [
    w(
      p.target
        ? p.to
          ? `Scroll ${targetText(p.target)} to the ${p.to === "top" ? "top" : "bottom"}`
          : `Scroll until ${targetText(p.target)} is in view`
        : `Scroll the page to the ${p.to === "top" ? "top" : "bottom"}`,
    ),
  ],
  "browser.getAttribute": (p, s) => [w("Read the "), code(p.name), w(` attribute of ${targetText(p.target)}`), ...saveAs(s)],
  "browser.switchTab": (p, s) => [
    w(typeof p.index === "number" ? `Move to tab #${p.index + 1}` : `Move to the "${String(p.title ?? p.url ?? "")}" tab`),
    ...saveAs(s),
  ],
  "browser.closeTab": () => [w("Close this tab and go back to the previous one")],
  "browser.fill": (p) => [w("Fill "), ...template(p.value), w(` into ${targetText(p.target)}`)],
  "browser.select": (p) => [w("Select "), code(p.value), w(` in ${targetText(p.target)}`)],
  "browser.press": (p) => [w("Press "), code(p.key), w(`${p.target ? ` on ${targetText(p.target)}` : ""}${dialogText(p.dialog)}`)],
  "browser.getText": (p, s) => [w(`Read the text of ${targetText(p.target)}`), ...saveAs(s)],
  "browser.getTable": (p, s) => [w(`Read ${targetText(p.target)} as a table`), ...saveAs(s)],
  "browser.waitFor": (p) => [
    w(`Wait until ${targetText(p.target)} ${p.state === "hidden" || p.state === "detached" ? "disappears" : "appears"}`),
  ],
  "browser.screenshot": (p) => [w("Save the screen to "), code(p.path)],
  "browser.close": () => [w("Close the browser")],
  "desktop.launch": (p) => [w("Launch "), code(p.path)],
  "desktop.click": (p) => [w(`Press ${targetText(p.target)}`)],
  "desktop.mouseClick": (p) => [w(`Click ${targetText(p.target)} with the mouse`)],
  "desktop.setValue": (p) => [w("Put "), ...template(p.value), w(` into ${targetText(p.target)}`)],
  "desktop.type": (p) => [w("Type "), ...template(p.text), w(` into ${targetText(p.target)}`)],
  "desktop.press": (p) => [w("Press "), code(p.key), w(p.target ? ` on ${targetText(p.target)}` : "")],
  "desktop.select": (p) => [w("Select "), code(p.value), w(` in ${targetText(p.target)}`)],
  "desktop.getValue": (p, s) => [w(`Read the value of ${targetText(p.target)}`), ...saveAs(s)],
  "desktop.readText": (p, s) => [...(p.file !== undefined && p.target === undefined ? [w("Read the text in the image "), ...template(p.file), w(" with OCR")] : [w(`Read the text of ${targetText(p.target)} with OCR`)]), ...saveAs(s)],
  "desktop.waitFor": (p) => [w(`Wait until ${targetText(p.target)} ${p.state === "hidden" ? "disappears" : "appears"}`)],
  "desktop.closeWindow": (p) => [w(`Close ${targetText(p.target)}`)],
  "desktop.setWindow": (p) => [w(`${p.state === "maximized" ? "Maximize" : p.state === "minimized" ? "Minimize" : p.state === "normal" ? "Restore" : p.front === true ? "Bring to front" : "Move"} ${targetText(p.target)}`)],
  "desktop.check": (p) => [w(`${p.checked === false ? "Uncheck" : "Check"} ${targetText(p.target)}`)],
  "process.list": (p, s) => [w(p.name ? "Find running " : "List running programs"), ...(p.name ? [code(p.name)] : []), ...saveAs(s)],
  "process.kill": (p) => [w("End "), code(p.name)],
  "desktop.getTable": (p, s) => [w(isTargetElement(p.target) ? `Read ${targetText(p.target)} as a table` : `Read the first table in ${targetText(p.target)}`), ...saveAs(s)],
  "sap.runTransaction": (p, s) => [w("Start the SAP transaction "), code(p.code), w(` in ${targetText(p.target)}`), ...saveAs(s)],
  "desktop.selectMenu": (p) => [w("Choose "), code(menuPath(p.path)), w(isTargetElement(p.target) ? ` from the right-click menu of ${targetText(p.target)}` : ` in ${targetText(p.target)}`)],
  "desktop.scroll": (p, s) => [w(p.direction ? `Scroll ${targetText(p.target)} ${String(p.direction)}` : `Scroll until ${targetText(p.target)} is in view`), ...saveAs(s)],
  "desktop.mouseScroll": (p) => [w(`Turn the mouse wheel ${String(p.direction)} over ${targetText(p.target)}`)],
  "desktop.drag": (p) => [w(`Drag ${targetText(p.target)} to ${targetText(p.to)}`)],
  "desktop.hover": (p) => [w(`Move the mouse onto ${targetText(p.target)}`)],
};

const DIRECTION_JA: Record<string, string> = { up: "上", down: "下", left: "左", right: "右", top: "いちばん上", bottom: "いちばん下" };

/** A menu path as a person reads it: ファイル › 名前を付けて保存. */
function menuPath(path: unknown): string {
  return Array.isArray(path) ? path.map(String).join(" › ") : String(path ?? "");
}

function isTargetElement(target: unknown): boolean {
  return !!target && typeof target === "object" && "element" in target && !!(target as { element?: unknown }).element;
}

function saveAs(step: Step): Part[] {
  if (!step.saveAs) return [];
  return locale === "ja" ? [w("（→ "), code(step.saveAs), w("）")] : [w(" (→ "), code(step.saveAs), w(")")];
}

export function sentence(step: Step, def: StepTypeDef | undefined): Part[] {
  const build = (locale === "ja" ? BUILDERS : BUILDERS_EN)[step.type];
  if (build) return build(step.params ?? {}, step);
  // Unknown or adapter-provided types: the registry label, then its params.
  const parts: Part[] = [w(stepLabel(step.type, def?.label))];
  for (const [key, value] of Object.entries(step.params ?? {}).slice(0, 3)) {
    // A target reads as words ("billing.exe の [btnSave]"), never as JSON.
    parts.push(...(key === "target" ? [w(` ${targetText(value)}`)] : [w(` ${t.paramNames.for[step.type]?.[key] ?? t.paramNames.labels[key] ?? key}：`), code(value)]));
  }
  return [...parts, ...saveAs(step)];
}

/** The sentence as plain text, e.g. for tooltips and tests. */
export const plain = (parts: Part[]) => parts.map((p) => ("text" in p ? p.text : p.code)).join("");
