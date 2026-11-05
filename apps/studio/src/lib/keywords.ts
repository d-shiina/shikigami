// Control steps keep their programming keyword (forEach, try, …) next to the
// Japanese: the AI and the docs talk in those words, and they can be looked
// up. Block labels spell out the condition, so a loop says what it walks over.
import type { Step } from "@shikigami/schema";
import { blockName, locale } from "./i18n";

export const KEYWORD: Record<string, string> = {
  "control.if": "if",
  "control.while": "while",
  "control.repeat": "repeat",
  "control.forEach": "forEach",
  "control.try": "try",
  "control.parallel": "parallel",
  "control.break": "break",
  "control.continue": "continue",
  "control.fail": "throw",
  "scenario.call": "call",
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
      return "then: when the condition holds";
    case "control.if:else":
      return "else: otherwise";
    case "control.while:body": {
      const max = p.maxIterations ? ` (up to ${p.maxIterations} times)` : "";
      return `while: ${text(p.condition)}${max}`;
    }
    case "control.repeat:body":
      return `repeat: ${text(p.count)} times${p.indexVar ? ` (count → ${p.indexVar})` : ""}`;
    case "control.forEach:body": {
      const at = p.concurrency && Number(p.concurrency) > 1 ? `, ${p.concurrency} at a time` : "";
      return `forEach: each of ${text(p.items)} → ${p.itemVar ?? "item"}${at}`;
    }
    case "control.try:try":
      return "try: run first";
    case "control.try:catch":
      return `catch: on failure (error → ${p.errorVar ?? "error"})`;
    case "control.try:finally":
      return "finally: always, at the end";
    default:
      return blockName(step.type, block, label);
  }
}

function blockLabelJa(step: Step, block: string, label: string): string {
  const p = (step.params ?? {}) as Record<string, unknown>;
  switch (`${step.type}:${block}`) {
    case "control.if:then":
      return "then：条件が成り立つとき";
    case "control.if:else":
      return "else：成り立たないとき";
    case "control.while:body": {
      const max = p.maxIterations ? `（最大 ${p.maxIterations} 回）` : "";
      return `while：${text(p.condition)} の間${max}`;
    }
    case "control.repeat:body":
      return `repeat：${text(p.count)} 回${p.indexVar ? `（何回目 → ${p.indexVar}）` : ""}`;
    case "control.forEach:body": {
      const at = p.concurrency && Number(p.concurrency) > 1 ? `・${p.concurrency} 件ずつ同時` : "";
      return `forEach：${text(p.items)} の 1 件ずつ → ${p.itemVar ?? "item"}${at}`;
    }
    case "control.try:try":
      return "try：まず実行";
    case "control.try:catch":
      return `catch：失敗したら（内容 → ${p.errorVar ?? "error"}）`;
    case "control.try:finally":
      return "finally：成功でも失敗でも最後に";
    default:
      return label;
  }
}
