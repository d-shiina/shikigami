// The rail down the left edge: the places of Studio, one per kind of work.
// A new kind of work (run history, schedules, plugins) is a new entry in
// PLACES, not a new button somewhere in a toolbar. Settings sit at the foot,
// apart from the work, as in most desktop apps.
import type { ReactNode } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import type { Place } from "../store";
import { useInbox } from "./ReviewDesk";
import { useUpdate } from "./AppMenu";

const icon = (d: ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const ICONS: Record<Place, ReactNode> = {
  scenarios: icon(
    <>
      <rect x="6.5" y="2.5" width="7" height="4" rx="1" />
      <rect x="6.5" y="13.5" width="7" height="4" rx="1" />
      <path d="M10 6.5v7" />
    </>,
  ),
  review: icon(
    <>
      <rect x="3" y="3" width="14" height="14" rx="1.5" />
      <path d="m6.5 10.2 2.3 2.3 4.7-5" />
    </>,
  ),
  secrets: icon(
    <>
      <circle cx="7" cy="10" r="3.5" />
      <path d="M10.5 10H17M14.5 10v3M17 10v2.5" />
    </>,
  ),
  settings: icon(
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>,
  ),
};

type RailProps = { place: Place; label: string; badge?: number; dot?: boolean; tone?: "shu" | "accent"; title?: string; onEnter?: () => void };

function RailButton({ place, label, badge, dot, tone, title, onEnter }: RailProps) {
  const current = useStudio((s) => s.place);
  const setPlace = (p: Place) => {
    setPlaceRaw(p);
    onEnter?.();
  };
  const setPlaceRaw = useStudio((s) => s.setPlace);
  const on = current === place;
  const badgeColor = tone === "accent" ? "bg-accent-500" : "bg-shu-500";
  return (
    <button
      type="button"
      onClick={() => setPlace(place)}
      aria-current={on ? "page" : undefined}
      title={title ?? label}
      className={`relative flex w-full flex-col items-center gap-0.5 py-2 text-[10px] leading-3 ${on ? "font-semibold text-ink" : "text-slate-500 hover:text-ink"}`}
    >
      {/* The current place is marked on the edge it opens from. */}
      {on && <span className="absolute inset-y-1.5 left-0 w-[3px] bg-ink" />}
      <span className={`grid h-8 w-10 place-items-center rounded-[4px] ${on ? "bg-sheet shadow-sheet" : ""}`}>{ICONS[place]}</span>
      <span className="max-w-[68px] truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className={`absolute top-1 right-2 min-w-4 rounded-[3px] px-1 text-center text-[10px] leading-4 font-bold text-white ${badgeColor}`}>{badge}</span>
      )}
      {/* Something new to look at, nothing to act on: a dot, not a count. */}
      {dot && <span className="absolute top-2 right-3.5 h-2 w-2 rounded-full bg-brand-500" />}
    </button>
  );
}

export function Rail() {
  // Sent-back scenarios wait on the AI, not on the person.
  const inbox = useInbox().filter((i) => !i.waiting);
  const open = useStudio((s) => s.open);
  const currentId = useStudio((s) => s.scenario?.id);
  // Land on something to review rather than a scenario with nothing new.
  const enterReview = () => {
    const first = inbox[0];
    if (first && !inbox.some((i) => i.scenarioId === currentId)) void open(first.scenarioId);
  };
  const asks = useStudio((s) => s.secretRequests.length);
  const update = useUpdate();
  return (
    <nav aria-label={t.shell.places} className="flex w-[72px] shrink-0 flex-col items-stretch border-r border-slate-200 bg-paper pb-1">
      {/* The top of the window: the mark, and room to drag it by. */}
      <div data-tauri-drag-region className="mb-1 grid h-10 shrink-0 place-items-center select-none">
        <img data-tauri-drag-region src="/mark.png" alt="Shikigami Studio" className="h-6 w-6" draggable={false} />
      </div>
      <RailButton place="scenarios" label={t.scenarios} />
      <RailButton place="review" label={t.awaitingReview} badge={inbox.length} title={t.bar.reviewTitle} onEnter={enterReview} />
      <RailButton place="secrets" label={t.secrets} badge={asks} tone="accent" title={asks > 0 ? t.bar.secretAskTitle : t.secretsIntro} />
      <span className="flex-1" />
      <RailButton place="settings" label={t.shell.settings} dot={update !== null} title={update ? `${t.updateAvailable} v${update}` : t.shell.settings} />
    </nav>
  );
}
