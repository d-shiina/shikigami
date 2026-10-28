// The agent pane: ask the AI without leaving Studio. Messages go to the person's own
// agent (Claude Code by default) with Shikigami's MCP server; whatever it
// edits lands in 確認待ち like any other AI edit.
import { useEffect, useRef, useState } from "react";
import { type AgentPart, type ChatItem, useAgent } from "../agent";
import { useStudio } from "../context";

const TOOL_LABELS: Record<string, string> = {
  list_scenarios: "シナリオ一覧",
  get_scenario: "シナリオを確認",
  validate_scenario: "検証",
  list_step_types: "手順の種類を確認",
  get_step_schema: "手順の仕様を確認",
  get_history: "変更履歴を確認",
  get_review: "差し戻しを確認",
  get_run_status: "実行状況を確認",
  get_run_logs: "実行ログを確認",
  list_runs: "実行履歴を確認",
  list_secrets: "シークレット名を確認",
  list_versions: "版の一覧",
  get_version: "版を確認",
  diff_versions: "版を比較",
  create_scenario: "シナリオを作成",
  update_scenario: "シナリオを変更",
  add_step: "手順を追加",
  update_step: "手順を変更",
  remove_step: "手順を削除",
  move_step: "手順を移動",
  undo: "元に戻す",
  redo: "やり直し",
  create_version: "版を作成",
  restore_version: "版を復元",
  run_scenario: "試し実行",
  stop_scenario: "実行を停止",
  inspect_page: "Web画面を確認",
  inspect_ui: "アプリ画面を確認",
  test_step: "手順を試行",
};

const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;

/** Header button that opens the pane. */
export function AgentButton() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const busy = useAgent((s) => s.turnId !== null || s.sending);
  const name = useAgent((s) => s.info?.name ?? "AI");
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      title={`${name}（Ctrl+J）`}
      className={`flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-semibold ${open ? "bg-ink text-paper" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
    >
      <span className={`h-2 w-2 rounded-full ${busy ? "bg-brand-500 animate-pulse" : open ? "bg-paper" : "bg-brand-500"}`} />
      {name}
    </button>
  );
}

export function AgentPane() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const info = useAgent((s) => s.info);
  const items = useAgent((s) => s.items);
  const turnId = useAgent((s) => s.turnId);
  const sending = useAgent((s) => s.sending);
  const send = useAgent((s) => s.send);
  const stop = useAgent((s) => s.stop);
  const reset = useAgent((s) => s.reset);
  const scenario = useStudio((s) => s.scenario);
  const selection = useStudio((s) => s.selection);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Newer WebView2 returns a promise here; an effect must not.
    void end.current?.scrollIntoView({ block: "end" });
  }, [items]);
  if (!open) return null;
  const stepId = selection?.kind === "step" ? selection.stepId : null;
  const submit = async () => {
    const ref = scenario ? { id: scenario.id, name: scenario.name, stepId } : null;
    const context = scenario ? `${scenario.name}${stepId ? " ・ 選択中の手順" : ""}` : null;
    if (await send(draft, ref, context)) setDraft("");
  };
  return (
    <aside className="fixed top-12 right-0 bottom-7 z-30 flex w-[380px] flex-col border-l border-slate-200 bg-sheet shadow-xl">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-brand-500" />
        <div className="min-w-0 flex-1 text-[13px] font-bold">{info?.name ?? "AI"}</div>
        <button
          type="button"
          onClick={reset}
          disabled={turnId !== null || sending || items.length === 0}
          className="grid h-6 w-6 place-items-center rounded-[5px] text-[15px] text-slate-500 enabled:hover:bg-slate-100 enabled:hover:text-ink disabled:text-slate-300"
          title="新しい会話"
          aria-label="新しい会話"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="grid h-6 w-6 place-items-center rounded-[5px] text-slate-400 hover:bg-slate-100 hover:text-ink"
          aria-label="閉じる"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {info && !info.available && (
          <div className="rounded-[6px] border border-shu-100 bg-shu-50 px-3 py-2 text-[12px] leading-relaxed text-shu-600">{info.problem}</div>
        )}
        {items.length === 0 && info?.available && (
          <div className="grid h-full place-items-center">
            <img src="/mark.png" alt="" className="h-10 w-10 opacity-15 grayscale" />
          </div>
        )}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <div ref={end} />
      </div>
      <div className="border-t border-slate-200 p-3">
        {scenario && (
          <div className="mb-1.5 flex min-w-0 items-center gap-1 text-[10.5px] text-slate-500">
            <span className="truncate rounded-full bg-slate-100 px-2 py-0.5">{scenario.name}</span>
            {stepId && <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">選択中の手順</span>}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          disabled={!info?.available}
          placeholder={scenario ? "例：ログインの後で受注一覧をCSVに保存して" : "例：受注システムから未出荷の注文を集めるシナリオを作って"}
          className="w-full resize-none rounded-[6px] border border-slate-300 bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-500 disabled:bg-slate-100"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[10.5px] text-slate-400">Ctrl+Enter で送信</span>
          {turnId ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="ml-auto h-8 shrink-0 rounded-[6px] border border-slate-300 px-3 text-[12px] text-slate-600 hover:bg-slate-100"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              disabled={!info?.available || sending || draft.trim() === ""}
              onClick={() => void submit()}
              className="ml-auto h-8 shrink-0 rounded-[6px] bg-ink px-4 text-[12px] font-semibold text-white enabled:hover:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              送信
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Item({ item }: { item: ChatItem }) {
  if (item.role === "person") {
    return (
      <div className="ml-8">
        {item.context && <div className="mb-0.5 truncate text-right text-[10px] text-slate-400">{item.context}</div>}
        <div className="rounded-[8px] rounded-tr-[2px] bg-ink px-3 py-2 text-[13px] whitespace-pre-wrap text-white">{item.text}</div>
      </div>
    );
  }
  return (
    <div className="mr-4 space-y-1.5">
      {item.parts.map((part, i) => (
        <Part key={i} part={part} />
      ))}
      {item.status === "running" && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
          作業中
        </div>
      )}
      {item.status === "failed" && (
        <div className="rounded-[6px] border border-shu-100 bg-shu-50 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-shu-600">
          {item.message ?? "失敗しました"}
        </div>
      )}
    </div>
  );
}

function Part({ part }: { part: AgentPart }) {
  switch (part.kind) {
    case "text":
      return <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{part.text.trim()}</div>;
    case "tool":
      return (
        <div className="flex items-start gap-1.5 text-[11.5px] text-slate-500">
          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
          <span>
            {toolLabel(part.name)}
            {part.detail && <span className="text-slate-400">：{part.detail}</span>}
          </span>
        </div>
      );
    case "toolFailed":
      return <div className="pl-3 text-[11px] text-shu-600">失敗：{part.message}</div>;
  }
}
