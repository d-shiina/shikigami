// The first time the AI pane opens with no AI Writer can run: people do not
// know whether their AI "has MCP", so they say which AI they use, by name,
// and Writer decides how to work with it (lib/aiWay.ts).
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useAgent } from "../agent";
import { type AiPick, BRANDS, type Brand, chatAi, FOLLOW_UPS, guess, pickFor, useAiWay } from "../lib/aiWay";
import { t } from "../lib/i18n";

type Question = keyof typeof FOLLOW_UPS;

const row =
  "flex w-full items-center gap-2 rounded-md border border-slate-200 bg-sheet px-2.5 py-2 text-left text-[13px] text-ink hover:border-brand-500 hover:bg-brand-50 focus-visible:border-brand-500 focus-visible:outline-none disabled:opacity-60";

/** Names the AI or chat a pick leads to, for the sentence that says what was set. */
export function pickName(pick: AiPick, names: ReadonlyMap<string, string>): string {
  if (pick.kind === "paste") return pick.chat === "other" ? t.aiChat.start.brands.other : chatAi(pick.chat).name;
  if (pick.kind === "agent") return names.get(pick.agent) ?? "AI";
  return "AI";
}

export function AiStart({ onDecided }: { onDecided: (sentence: string) => void }) {
  const choices = useAgent((s) => s.choices);
  const choose = useAgent((s) => s.chooseAgent);
  const setWay = useAiWay((s) => s.setWay);
  const [question, setQuestion] = useState<Question | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = new Map((choices ?? []).map((c) => [c.kind, c.name] as const));
  const apply = async (pick: AiPick, found = false) => {
    if (pick.kind === "ask") return setQuestion(pick.question);
    if (pick.kind === "unknown") {
      const next = guess((choices ?? []).filter((c) => c.installed).map((c) => c.kind));
      const sentence = next.kind === "agent" ? t.aiChat.decided.foundAgent(pickName(next, names)) : t.aiChat.decided.noAgent;
      await apply(next, true);
      onDecided(sentence);
      return;
    }
    setError(null);
    if (pick.kind === "agent") {
      setBusy(true);
      try {
        await choose(pick.agent);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        setBusy(false);
      }
      setWay("agent");
    } else {
      setWay("paste", pick.chat);
    }
    if (!found) onDecided(t.aiChat.decided[pick.kind](pickName(pick, names)));
  };
  const s = t.aiChat.start;
  return (
    <div className="space-y-2.5 rounded-lg border border-brand-100 bg-brand-50 px-3 py-3 text-[12px] text-ink">
      {question ? (
        <>
          <button type="button" onClick={() => setQuestion(null)} className="flex items-center gap-0.5 text-slate-500 hover:text-ink">
            <ChevronLeft size={14} aria-hidden="true" />
            {s.back}
          </button>
          <div className="text-[13px] font-semibold">{s.questions[question].title}</div>
          <div className="space-y-1.5">
            {(["first", "second"] as const).map((which, i) => (
              <button key={which} type="button" disabled={busy} onClick={() => void apply(FOLLOW_UPS[question][i]!)} className={row}>
                <span className="min-w-0 flex-1">{s.questions[question][which]}</span>
                <ChevronRight size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="text-[13px] font-semibold">{s.title}</div>
          <div className="leading-relaxed text-slate-700">{s.lead}</div>
          <div className="grid grid-cols-2 gap-1.5">
            {BRANDS.map((brand: Brand) => (
              <button key={brand} type="button" disabled={busy} onClick={() => void apply(pickFor(brand))} className={row}>
                <span className="min-w-0 flex-1 truncate">{s.brands[brand]}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {error && <div className="text-shu-600">{error}</div>}
    </div>
  );
}
