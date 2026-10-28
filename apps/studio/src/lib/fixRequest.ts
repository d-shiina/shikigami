// What Studio tells the AI when a run paused on an error: enough to fix the
// step without seeing the screen (the AI's MCP server runs in another
// process, so the paused browser is not open there).
import type { Scenario, StepTypeDef } from "@shikigami/schema";
import type { RunEvidence } from "./api";
import type { Pause } from "../store";
import { findStep } from "../store";

/** Longest page / window tree quoted in the request. */
const MAX_TREE_CHARS = 6000;
/** Longest single variable value quoted. */
const MAX_VALUE_CHARS = 300;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The request text, in Japanese like the rest of Studio. */
export function fixRequest(input: {
  scenario: Pick<Scenario, "id" | "name" | "steps">;
  runId: string;
  pause: Pause;
  evidence: RunEvidence | null;
  defs: StepTypeDef[];
}): string {
  const { scenario, runId, pause, evidence } = input;
  const step = findStep(scenario.steps ?? [], pause.stepId);
  const def = input.defs.find((d) => d.type === pause.stepType);
  const kind = def?.label ?? pause.stepType;
  const label = step?.name ? `${kind}「${step.name}」` : kind;
  const lines = [
    `シナリオ「${scenario.name}」（${scenario.id}）を Studio で実行したところ、ステップ ${label}（stepId: ${pause.stepId}, type: ${pause.stepType}）でエラーになり、その場で一時停止しています。`,
    "",
    `エラー: ${pause.error?.code ?? "?"}: ${pause.error?.message ?? ""}`,
  ];
  if (pause.error?.details != null) lines.push(`詳細: ${cut(JSON.stringify(pause.error.details), 1500)}`);
  if (step) lines.push("", "失敗したステップ:", "```json", JSON.stringify(step.params ?? {}, null, 2), "```");
  const vars = Object.entries(pause.variables);
  if (vars.length > 0) {
    lines.push("", "この時点の変数:");
    for (const [name, value] of vars) lines.push(`- ${name} = ${cut(JSON.stringify(value) ?? "null", MAX_VALUE_CHARS)}`);
  }
  const observation = evidence?.observation;
  if (observation) {
    lines.push("", `止まったときの画面（${observation.title}）:`);
    if (observation.tree) lines.push("```", cut(observation.tree, MAX_TREE_CHARS), "```");
  }
  lines.push(
    "",
    "お願い:",
    "- 原因を調べて、このシナリオを update_step などで直してください。必要なら失敗したステップの前に add_step で手順を足してもかまいません。",
    "- 実行は止めたままにしてあり、ブラウザなどの状態もそのままです。直したら人が確認して、失敗したステップから変数を保ったまま再開します。run_scenario で最初から実行し直さないでください。",
    "- すでに終わったステップや、今いるブロック（ループや条件）を消したり動かしたりすると、その場から再開できなくなります。",
  );
  if (observation) lines.push(`- 編集の observations に ${observation.id} を付けると、確認する人に根拠の画面として見えます。`);
  lines.push(`- 実行の記録は get_run_logs で runId ${runId} から読めます。`);
  return lines.join("\n");
}
