// Opens and closes the AI's chat. The AI is not a place but a helper on
// whatever is open, so its button sits at the window's top right, left of the
// window buttons, the same on every place, and the chat opens on the right
// right under it, as Copilot does in VS Code and Edge.
import { MessageSquareText } from "lucide-react";
import { anyBusy, useAgent } from "../agent";
import { t } from "../lib/i18n";

export function AgentButton() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const busy = useAgent(anyBusy);
  // A conversation finished while the pane was closed or showing another.
  const news = useAgent((s) => s.chats.some((c) => c.unread));
  // Named by what it is, not by the AI in use (Claude Code, Codex, …): which
  // one is set in Settings and shown in the pane's head.
  const name = useAgent((s) => s.info?.name ?? "AI");
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      aria-label={t.shell.aiChat}
      title={`${t.shell.aiChat}：${name}（Ctrl+J）`}
      className={`relative my-auto mr-1 flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] ${open ? "bg-slate-200/70 font-semibold text-ink" : "text-slate-600 hover:bg-slate-200/50 hover:text-ink"}`}
    >
      <MessageSquareText size={15} strokeWidth={1.75} aria-hidden="true" />
      <span>{t.shell.aiChat}</span>
      {(news || busy) && <span className={`h-2 w-2 rounded-full bg-brand-500 ${busy ? "animate-pulse" : ""}`} />}
    </button>
  );
}
