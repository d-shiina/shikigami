// The programming keyword of each control step (forEach, try, …): the chart
// never shows it (people read 繰り返し・条件分岐), but the palette finds a
// node by it, since the AI and the docs use those words. Block labels spell
// out the condition in plain words, so a loop says what it walks over.
import type { Step } from "@shikigami/schema";
import { blockName, locale } from "./i18n";

export const KEYWORD: Record<string, string> = {
  "control.if": "if",
  "control.switch": "switch",
  "control.case": "case",
  "control.while": "while",
  "control.repeat": "repeat",
  "control.forEach": "forEach",
  "control.try": "try",
  "control.parallel": "parallel",
  "control.break": "break",
  "control.continue": "continue",
  "control.fail": "throw",
  "flow.call": "call",
};

const MAX = 36;

function text(value: unknown): string {
  const s = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s;
}

/** The label of `block` of `step`, falling back to the registry's `label`. */
export function blockLabel(step: Step, block: string, label: string): string {
  return locale === "ja" ? blockLabelJa(step, block, label) : blockLabelEn(step, block, label);
}

function blockLabelEn(step: Step, block: string, label: string): string {
  const p = (step.params ?? {}) as Record<string, unknown>;
  switch (`${step.type}:${block}`) {
    case "control.if:then":
      return "when the condition holds";
    case "control.if:else":
      return "otherwise";
    case "control.while:body": {
      const max = p.maxIterations ? ` (up to ${p.maxIterations} times)` : "";
      return `while ${text(p.condition)}${max}`;
    }
    case "control.repeat:body":
      return `${text(p.count)} times${p.indexVar ? ` (count → ${p.indexVar})` : ""}`;
    case "control.forEach:body": {
      const at = p.concurrency && Number(p.concurrency) > 1 ? `, ${p.concurrency} at a time` : "";
      return `each of ${text(p.items)} → ${p.itemVar ?? "item"}${at}`;
    }
    case "control.switch:cases":
      return "by value";
    case "control.switch:default":
      return "when none match";
    case "control.case:body":
      return "";
    case "control.try:try":
      return "run first";
    case "control.try:catch":
      return `on failure (error → ${p.errorVar ?? "error"})`;
    case "control.try:finally":
      return "always, at the end";
    default:
      return blockName(step.type, block, label);
  }
}

function blockLabelJa(step: Step, block: string, label: string): string {
  const p = (step.params ?? {}) as Record<string, unknown>;
  switch (`${step.type}:${block}`) {
    case "control.if:then":
      return "条件が成り立つとき";
    case "control.if:else":
      return "成り立たないとき";
    case "control.while:body": {
      const max = p.maxIterations ? `（最大 ${p.maxIterations} 回）` : "";
      return `${text(p.condition)} の間${max}`;
    }
    case "control.repeat:body":
      return `${text(p.count)} 回${p.indexVar ? `（何回目 → ${p.indexVar}）` : ""}`;
    case "control.forEach:body": {
      const at = p.concurrency && Number(p.concurrency) > 1 ? `・${p.concurrency} 件ずつ同時` : "";
      return `${text(p.items)} の 1 件ずつ → ${p.itemVar ?? "item"}${at}`;
    }
    case "control.switch:cases":
      return "値ごと";
    case "control.switch:default":
      return "どれにも該当しないとき";
    case "control.case:body":
      return "";
    case "control.try:try":
      return "まず実行";
    case "control.try:catch":
      return `失敗したら（内容 → ${p.errorVar ?? "error"}）`;
    case "control.try:finally":
      return "成功でも失敗でも最後に";
    default:
      return label;
  }
}

/**
 * The short heading of a block's column on the chart, under the head of its
 * frame: はい／いいえ for an if, 実行／失敗したとき for a try. Empty where the
 * head already says it (a loop's body, a group's) or the column has its own
 * tab (a switch's cases).
 */
export function laneLabel(step: Step, block: string, label: string): string {
  const ja = locale === "ja";
  const p = (step.params ?? {}) as Record<string, unknown>;
  switch (`${step.type}:${block}`) {
    case "control.if:then":
      return ja ? "はい" : "Yes";
    case "control.if:else":
      return ja ? "いいえ" : "No";
    case "control.switch:default":
      return ja ? "その他" : "Other";
    case "control.try:try":
      return ja ? "実行" : "Run";
    case "control.try:catch":
      return ja ? `失敗したとき（→ ${p.errorVar ?? "error"}）` : `On failure (→ ${p.errorVar ?? "error"})`;
    case "control.try:finally":
      return ja ? "最後に必ず" : "Always at the end";
    case "control.switch:cases":
    case "control.case:body":
    case "control.group:body":
    case "control.parallel:branches":
    case "control.forEach:body":
    case "control.repeat:body":
    case "control.while:body":
    case "wait.until:check":
      return "";
    default:
      return blockLabel(step, block, label);
  }
}

/** On the foot of a loop's frame: it goes round again. */
export function loopBackLabel(step: Step): string {
  const ja = locale === "ja";
  if (step.type === "control.forEach") return ja ? "次の 1 件へ" : "Next item";
  if (step.type === "wait.until") return ja ? "もう一度確かめる" : "Check again";
  return ja ? "次の回へ" : "Next round";
}

/** What a loop asks each time round (on its decision), and its two answers. */
export function loopQuestion(step: Step): { question: string; yes: string; no: string } {
  const ja = locale === "ja";
  const p = (step.params ?? {}) as Record<string, unknown>;
  const answers = ja ? { yes: "はい", no: "いいえ" } : { yes: "Yes", no: "No" };
  switch (step.type) {
    case "control.forEach":
      return { question: ja ? "次の 1 件がある？" : "Another item?", ...answers };
    case "control.repeat":
      return { question: ja ? "まだ回数が残っている？" : "Rounds left?", ...answers };
    default: {
      const condition = plainExpr(p.condition);
      return { question: condition ? `${condition}${ja ? "？" : "?"}` : ja ? "条件を満たす？" : "Condition holds?", ...answers };
    }
  }
}

/** On the line out of a loop's frame: when it leaves. */
export function loopExitLabel(step: Step): string {
  const ja = locale === "ja";
  if (step.type === "control.forEach") return ja ? "すべて終わったら" : "When all are done";
  if (step.type === "control.while") return ja ? "条件が外れたら" : "When the condition fails";
  if (step.type === "wait.until") return ja ? "条件を満たしたら" : "When the condition holds";
  const count = (step.params as Record<string, unknown> | undefined)?.count;
  if (typeof count === "number") return ja ? `${count} 回終えたら` : `After ${count} rounds`;
  return ja ? "回数を終えたら" : "After the last round";
}

/** What the head of a frame says after its name: the condition of an if, the value a switch compares, what a loop walks over. */
export function headSummary(step: Step): string {
  const p = (step.params ?? {}) as Record<string, unknown>;
  switch (step.type) {
    case "control.if":
      return plainExpr(p.condition);
    case "control.switch":
      return plainExpr(p.value);
    case "control.forEach":
    case "control.repeat":
    case "control.while":
      return blockLabel(step, "body", "").replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, "$1");
    default:
      return "";
  }
}

/** `{{ a > 1 }}` as `a > 1`. */
function plainExpr(value: unknown): string {
  const s = text(value).trim();
  const m = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(s);
  return m ? (m[1] ?? "") : s;
}
