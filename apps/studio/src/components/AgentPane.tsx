// Talk to the AI without leaving Studio. Messages go to the person's own
// agent (Claude Code by default) with Shikigami's MCP server; whatever it
// edits lands in 確認待ち like any other AI edit.
import { useEffect, useRef, useState } from "react";
import { type AgentPart, type ChatItem, useAgent } from "../agent";
import { useStudio } from "../context";

const TOOL_LABELS: Record<string, string> = {
  list_scenarios: "シナリオの一覧を見ました",
  get_scenario: "シナリオを読みました",
  validate_scenario: "シナリオを検査しました",
  list_step_types: "使える手順を調べました",
  get_step_schema: "手順の書き方を調べました",
  get_history: "変更の記録を見ました",
  get_review: "差し戻しの内容を読みました",
  get_run_status: "実行の様子を見ました",
  get_run_logs: "実行ログを読みました",
  list_runs: "実行の記録を見ました",
  list_secrets: "シークレットの名前を見ました",
  list_versions: "版の一覧を見ました",
  get_version: "版を読みました",
  diff_versions: "版の違いを見ました",
  create_scenario: "シナリオを作りました",
  update_scenario: "シナリオを変えました",
  add_step: "手順を追加しました",
  update_step: "手順を変えました",
  remove_step: "手順を消しました",
  move_step: "手順を動かしました",
  undo: "編集を元に戻しました",
  redo: "編集をやり直しました",
  create_version: "版を作りました",
  restore_version: "版を戻しました",
  run_scenario: "試しに実行しました",
  stop_scenario: "実行を止めました",
  inspect_page: "Web画面を確かめました",
  inspect_ui: "アプリの画面を確かめました",
  test_step: "手順を一つ試しました",
};

const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;

/** Header button that opens the pane. */
export function AgentButton() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const busy = useAgent((s) => s.turnId !== null);
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      title="AIに頼む・相談する"
      className={`flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-semibold ${open ? "bg-ink text-white" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
    >
      <span className={`h-2 w-2 rounded-full ${busy ? "swirl animate-pulse" : open ? "bg-white" : "swirl"}`} />
      AIと話す
    </button>
  );
}

export function AgentPane() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const info = useAgent((s) => s.info);
  const items = useAgent((s) => s.items);
  const turnId = useAgent((s) => s.turnId);
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
    const context = scenario ? `「${scenario.name}」${stepId ? "の選んだ手順" : ""}について` : null;
    if (await send(draft, ref, context)) setDraft("");
  };
  return (
    <aside className="fixed top-12 right-0 bottom-0 z-30 flex w-[380px] flex-col border-l border-slate-200 bg-sheet shadow-xl">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5">
        <span className="swirl h-2.5 w-2.5 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold">AIと話す</div>
          <div className="truncate text-[10.5px] text-slate-400">
            {info?.available ? `${info.name}・変えたものは「確認待ち」に並びます` : (info?.name ?? "AI")}
          </div>
        </div>
        <button
          type="button"
          onClick={reset}
          disabled={turnId !== null || items.length === 0}
          className="rounded-[5px] px-2 py-1 text-[11px] text-slate-500 enabled:hover:bg-slate-100 disabled:text-slate-300"
          title="新しい会話を始めます"
        >
          新しい会話
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
        {items.length === 0 && info?.available && <Welcome scenarioName={scenario?.name ?? null} />}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        <div ref={end} />
      </div>
      <div className="border-t border-slate-200 p-3">
        {scenario && (
          <div className="mb-1.5 truncate text-[10.5px] text-slate-400">
            「{scenario.name}」{stepId ? "の選んだ手順" : ""}について話します
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
          placeholder="例：ログインの後、受注一覧をCSVに保存する手順を足して"
          className="w-full resize-none rounded-[6px] border border-slate-300 bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-500 disabled:bg-slate-100"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[10.5px] leading-tight text-slate-400">パスワードは書かず、シークレットの名前で伝えてください</span>
          {turnId ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="ml-auto h-8 shrink-0 rounded-[6px] border border-slate-300 px-3 text-[12px] text-slate-600 hover:bg-slate-100"
            >
              止める
            </button>
          ) : (
            <button
              type="button"
              disabled={!info?.available || draft.trim() === ""}
              onClick={() => void submit()}
              title="Ctrl+Enter"
              className="ml-auto h-8 shrink-0 rounded-[6px] bg-ink px-4 text-[12px] font-semibold text-white enabled:hover:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              送る
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Welcome({ scenarioName }: { scenarioName: string | null }) {
  return (
    <div className="rounded-[8px] border border-dashed border-slate-300 px-3 py-4 text-[12px] leading-relaxed text-slate-500">
      チャットに戻らなくても、ここから頼めます。
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
        <li>{scenarioName ? `「${scenarioName}」の` : ""}この手順が失敗する理由を調べて直して</li>
        <li>〇〇のサイトから△△を取ってくるシナリオを作って</li>
        <li>確認待ちで「差し戻す」と、理由がそのままAIに届いて直り始めます</li>
      </ul>
    </div>
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
          <span className="swirl h-1.5 w-1.5 animate-pulse rounded-full" />
          考えています…
        </div>
      )}
      {item.status === "failed" && (
        <div className="rounded-[6px] border border-shu-100 bg-shu-50 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-shu-600">
          {item.message ?? "うまくいきませんでした"}
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
      return <div className="pl-3 text-[11px] text-shu-600">うまくいかなかった操作：{part.message}</div>;
  }
}
