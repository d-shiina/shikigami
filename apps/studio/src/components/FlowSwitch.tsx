// The open flow's name in the title bar, and the way to another flow from
// it: pressed, it lists the flows worked on lately (pinned first), as the
// sidebar used to. The whole list stays one step left of it (フロー).
import { ChevronsUpDown, Pin, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgent } from "../agent";
import { useStudio } from "../context";
import { t } from "../lib/i18n";

const RECENT_KEY = "spellsheet.studio.recent";
const PINS_KEY = "spellsheet.studio.pins";
const RECENT_MAX = 6;

function readIds(key: string): string[] {
  try {
    const raw = JSON.parse(
      globalThis.localStorage?.getItem(key) ?? "[]",
    ) as unknown;
    return Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
function writeIds(key: string, ids: string[]) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(ids));
  } catch {
    // Only a remembered preference.
  }
}

/**
 * The flows the person works on, as Linear keeps favourites and Notion
 * recent pages: pinned first, then the last ones opened. The window shows one
 * flow at a time, so a row switches the editor to it; the library page keeps
 * the whole list. A dot says what is happening in it (running, the AI at work).
 */
export function FlowSwitch() {
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) =>
      !box.current?.contains(e.target as Node) && setShown(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShown(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [shown]);
  const flow = useStudio((s) => s.flow);
  const place = useStudio((s) => s.place);
  const summaries = useStudio((s) => s.summaries);
  const open = useStudio((s) => s.open);
  const setPlace = useStudio((s) => s.setPlace);
  const run = useStudio((s) => s.run);
  const aiFlows = useAgent((s) =>
    s.chats
      .filter((c) => c.turnId)
      .map((c) => c.flowId)
      .join("\n"),
  ).split("\n");
  const [recent, setRecent] = useState(() => readIds(RECENT_KEY));
  const [pins, setPins] = useState(() => readIds(PINS_KEY));
  useEffect(() => {
    if (!flow) return;
    setRecent((now) => {
      const next = [flow.id, ...now.filter((id) => id !== flow.id)].slice(
        0,
        20,
      );
      writeIds(RECENT_KEY, next);
      return next;
    });
  }, [flow?.id]);
  const togglePin = (id: string) => {
    const next = pins.includes(id)
      ? pins.filter((p) => p !== id)
      : [...pins, id];
    setPins(next);
    writeIds(PINS_KEY, next);
  };
  const name = new Map(summaries.map((f) => [f.id, f.name] as const));
  // Pins of flows gone from this workspace (deleted, or another workspace) take no room.
  const shownPins = pins.filter((id) => name.has(id));
  const rest = recent
    .filter((id) => !pins.includes(id) && name.has(id))
    .slice(0, Math.max(0, RECENT_MAX - shownPins.length));
  const rows = [...shownPins, ...rest];
  const running =
    run && (run.status === "running" || run.status === "paused")
      ? run.flowId
      : null;
  if (!flow) return null;
  // With no other flow to go to, the name is only a name.
  const others = rows.some((id) => id !== flow.id);
  return (
    <div ref={box} className="relative min-w-[5em]">
      <button
        type="button"
        disabled={!others}
        onClick={() => setShown(!shown)}
        aria-haspopup="menu"
        aria-expanded={shown}
        title={flow.name}
        className={`flex h-7 max-w-full items-center gap-1 rounded-md px-1.5 text-[13px] font-semibold text-ink ${others ? "hover:bg-slate-100" : ""} ${shown ? "bg-slate-100" : ""}`}
      >
        <span className="min-w-0 truncate">{flow.name}</span>
        {others && (
          <ChevronsUpDown
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-slate-400"
            aria-hidden="true"
          />
        )}
      </button>
      {shown && (
        <div
          role="menu"
          className="absolute top-full left-0 z-50 mt-1 w-72 rounded-lg border border-slate-200 bg-sheet p-1 shadow-lifted"
        >
          <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-slate-400">
            {t.shell.recentFlows}
          </div>
          {rows.map((id) => {
            const on = place === "flows" && flow?.id === id;
            const pinned = pins.includes(id);
            const state =
              running === id
                ? "bg-accent-500 animate-pulse motion-reduce:animate-none"
                : aiFlows.includes(id)
                  ? "bg-brand-500 animate-pulse motion-reduce:animate-none"
                  : null;
            return (
              <div
                key={id}
                className={`group flex h-8 items-center rounded-lg ${on ? "bg-slate-200/70" : "hover:bg-slate-100"}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    // To the editor from any place, as the library opens flows.
                    setShown(false);
                    setPlace("flows");
                    if (flow?.id !== id) void open(id);
                  }}
                  aria-current={on ? "page" : undefined}
                  title={name.get(id)}
                  className={`flex h-full min-w-0 flex-1 items-center gap-2 pr-1 pl-2 text-left text-[13px] ${on ? "font-semibold text-ink" : "text-slate-600 group-hover:text-ink"}`}
                >
                  <span className="relative grid h-4 w-4 shrink-0 place-items-center">
                    <Workflow
                      size={14}
                      strokeWidth={1.75}
                      className={on ? "text-ink" : "text-slate-500"}
                      aria-hidden="true"
                    />
                    {state && (
                      <span
                        className={`absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-sheet ${state}`}
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {name.get(id)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => togglePin(id)}
                  aria-label={pinned ? t.shell.unpin : t.shell.pin}
                  title={pinned ? t.shell.unpin : t.shell.pin}
                  className={`mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-slate-200 hover:text-ink focus-visible:opacity-100 ${pinned ? "" : "opacity-0 group-hover:opacity-100"}`}
                >
                  <Pin
                    size={13}
                    strokeWidth={1.75}
                    className={pinned ? "fill-current" : ""}
                    aria-hidden="true"
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
