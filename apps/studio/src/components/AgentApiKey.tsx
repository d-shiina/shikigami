// The API key box for an AI that runs on a key (Gemini CLI): Google no longer
// takes a personal account's sign-in there, so the person pastes a key made
// in Google AI Studio. Writer keeps it in Windows Credential Manager and hands
// it to the AI when it starts; it never goes to config.json or to the AI's chat.
import { ExternalLink, KeyRound } from "lucide-react";
import { useState } from "react";
import { currentChat, useAgent } from "../agent";
import { agent } from "../lib/api";
import { t } from "../lib/i18n";

/** Where Google AI Studio makes API keys. */
export const GEMINI_KEY_PAGE = "https://aistudio.google.com/apikey";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * In the AI chat it shows only while a key is wanted (none saved, or the AI
 * turned the saved one down); in the settings it always shows.
 */
export function ApiKeyBox({ inSettings = false }: { inSettings?: boolean }) {
  const info = useAgent((s) => s.info);
  const save = useAgent((s) => s.saveApiKey);
  const refused = useAgent((s) => {
    const last = currentChat(s).items.at(-1);
    return last?.role === "ai" && last.needsLogin;
  });
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!info?.usesApiKey) return null;
  if (!inSettings && info.hasApiKey && !refused) return null;
  const asking = !info.hasApiKey || editing || (!inSettings && refused);
  const run = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await save(value);
      setKey("");
      setEditing(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const button =
    "h-7 rounded-lg border border-slate-300 bg-sheet px-2.5 text-[12px] text-slate-700 enabled:hover:bg-slate-50 disabled:opacity-50";
  const primary =
    "h-8 shrink-0 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary enabled:hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400";
  return (
    <div
      className={
        inSettings
          ? "max-w-md space-y-2 text-[12px] text-ink"
          : "space-y-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12px] text-ink"
      }
    >
      {!inSettings && (
        <div className="flex items-center gap-1.5 font-semibold">
          <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
          {t.agent.apiKey.title}
        </div>
      )}
      {!inSettings && refused && info.hasApiKey ? (
        <div className="leading-relaxed text-shu-600">
          {t.agent.apiKey.invalid}
        </div>
      ) : (
        asking && (
          <div className="leading-relaxed text-slate-700">
            {t.agent.apiKey.lead}
          </div>
        )
      )}
      {asking ? (
        <>
          <button
            type="button"
            onClick={() =>
              void agent
                .openLink(GEMINI_KEY_PAGE)
                .catch((e: unknown) => setError(message(e)))
            }
            className="flex items-center gap-1 text-brand-600 underline-offset-2 hover:underline"
          >
            <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
            {t.agent.apiKey.create}
          </button>
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void run(key);
            }}
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              aria-label={t.agent.apiKey.title}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t.agent.apiKey.placeholder}
              className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-sheet px-2 font-mono text-[12px] outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={!key.trim() || busy}
              className={primary}
            >
              {t.agent.apiKey.save}
            </button>
          </form>
          {editing && (
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-slate-500 hover:text-ink"
            >
              {t.cancel}
            </button>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-600">{t.agent.apiKey.saved}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(true)}
            className={button}
          >
            {t.agent.apiKey.change}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(null)}
            className={button}
          >
            {t.agent.apiKey.remove}
          </button>
        </div>
      )}
      {error && <div className="whitespace-pre-wrap text-shu-600">{error}</div>}
      <div className="text-[11px] leading-relaxed text-slate-500">
        {t.agent.apiKey.privacy}
      </div>
    </div>
  );
}
