// What belongs to the window rather than to what is open: the app's name and
// its menu (theme, language, version, settings), the search over everything
// (Ctrl+P), and the AI's chat (Ctrl+J). They sit on the window's ground, in
// the bar along its top, as Windows apps carry their name and VS Code its
// command center with Copilot beside it.
import { AppWindow, Blocks, CalendarClock, Check, ChevronDown, Inbox, KeyRound, LayoutList, type LucideIcon, MessageSquareText, Moon, Play, Plus, Settings2, Sparkles, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { activity, anyBusy, useAgent, useAgentApi } from "../agent";
import { useStudio } from "../context";
import { type Locale, setLocale, t, useLocale } from "../lib/i18n";
import { setTheme, type ThemeChoice, useTheme } from "../lib/theme";
import { isActive, type Place } from "../store";
import { runnerApi } from "../runner/api";
import { useAppVersion, useUpdate } from "./AppMenu";

const KBD = "rounded-sm border border-slate-200 bg-sheet px-1 font-sans text-[10.5px] leading-4 font-medium text-slate-500";

/** Opens on a click, closes on a click outside or Esc. */
function usePopover(): [boolean, (open: boolean) => void, React.RefObject<HTMLDivElement | null>] {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return [open, setOpen, ref];
}

const THEMES: [ThemeChoice, () => string][] = [
  ["system", () => t.bar.themeSystem],
  ["light", () => t.bar.themeLight],
  ["dark", () => t.bar.themeDark],
];
const LANGUAGES: [Locale, string][] = [
  ["ja", "日本語"],
  ["en", "English"],
];

function MenuRow({ icon: Icon, label, hint, onClick, on }: { icon?: LucideIcon; label: string; hint?: string; onClick: () => void; on?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-ink hover:bg-slate-100">
      <span className="grid w-4 shrink-0 place-items-center text-slate-500">{Icon ? <Icon size={15} strokeWidth={1.75} aria-hidden="true" /> : on ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : null}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-slate-400">{hint}</span>}
    </button>
  );
}

const MenuLabel = ({ children }: { children: React.ReactNode }) => <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-slate-400">{children}</div>;
const MenuRule = () => <div className="my-1 h-px bg-slate-200" />;

/**
 * The app's name at the window's top left, as every Windows app carries it.
 * Its menu holds what is the window's, not the work's: theme, language,
 * settings and the version (with an update, when one waits).
 */
export function Brand({ compact = false }: { compact?: boolean }) {
  const [open, setOpen, ref] = usePopover();
  const setPlace = useStudio((s) => s.setPlace);
  const version = useAppVersion();
  const update = useUpdate();
  const { choice } = useTheme();
  const { locale } = useLocale();
  const [product, ...rest] = t.appName.split(" ");
  const screen = rest.join(" ");
  const close = (then: () => void) => () => {
    setOpen(false);
    then();
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.shell.brandMenu}
        title={t.shell.brandMenu}
        className={`flex h-7 items-center gap-2 rounded-md ${compact ? "w-8 justify-center" : "pr-1.5 pl-1"} ${open ? "bg-slate-200/70" : "hover:bg-slate-200/50"}`}
      >
        <img src="/mark.png" alt="" className="h-[18px] w-[18px] shrink-0" draggable={false} />
        {!compact && (
          <>
            {/* The app's name from the strings (t.appName), so a rename of this screen follows by itself:
                the product in ink, which screen of it in grey ("SpellSheet" + "Writer"). */}
            <span className="text-[13.5px] tracking-[-0.01em] whitespace-nowrap">
              <span className="font-semibold text-ink">{product}</span>
              {screen && <span className="ml-1 font-medium text-slate-500">{screen}</span>}
            </span>
            <ChevronDown size={13} strokeWidth={2} className="text-slate-400" aria-hidden="true" />
          </>
        )}
        {update && <span className="absolute top-0.5 left-5 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-frame" />}
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-50 mt-1 w-64 rounded-lg border border-slate-200 bg-sheet p-1 shadow-lifted">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <img src="/mark.png" alt="" className="h-7 w-7" draggable={false} />
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink">{t.appName}</div>
              <div className="text-[11px] text-slate-500">{version ? t.shell.version(version) : ""}</div>
            </div>
          </div>
          {update && (
            <button
              type="button"
              onClick={close(() => setPlace("settings"))}
              className="mb-1 flex h-8 w-full items-center gap-2 rounded-md bg-brand-50 px-2 text-left text-[12.5px] font-medium text-brand-700 hover:bg-brand-100"
            >
              <span className="h-2 w-2 rounded-full bg-brand-500" />
              {t.updateAvailable} v{update}
            </button>
          )}
          <MenuRule />
          <MenuLabel>{t.bar.theme}</MenuLabel>
          {THEMES.map(([key, label]) => (
            <MenuRow key={key} label={label()} on={choice === key} onClick={() => setTheme(key)} />
          ))}
          <MenuLabel>{t.bar.language}</MenuLabel>
          {LANGUAGES.map(([key, name]) => (
            <MenuRow key={key} label={name} on={locale === key} onClick={() => setLocale(key)} />
          ))}
          <MenuRule />
          <MenuRow icon={Settings2} label={t.shell.settings} hint="Ctrl+," onClick={close(() => setPlace("settings"))} />
        </div>
      )}
    </div>
  );
}

/** The AI's chat, by name: what it is doing shows on it from every place. */
export function AiButton() {
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const busy = useAgent(anyBusy);
  const news = useAgent((s) => s.chats.some((c) => c.unread));
  const name = useAgent((s) => s.info?.name ?? "AI");
  const tool = useAgent((s) => activity(s)?.tool ?? null);
  const working = useAgent((s) => activity(s) !== null);
  const what = working && tool ? ((t.agent.tools as Record<string, string>)[tool] ?? tool) : null;
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      aria-label={t.shell.aiChat}
      title={`${t.shell.aiChat}：${name}（Ctrl+J）`}
      className={`flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12.5px] ${
        open ? "border-brand-300 bg-brand-100 font-medium text-brand-700" : "border-brand-100 bg-brand-50 font-medium text-brand-700 hover:border-brand-300"
      }`}
    >
      <Sparkles size={14} strokeWidth={1.75} className={open ? "text-brand-600" : "text-brand-500"} aria-hidden="true" />
      <span className="shrink-0">{t.shell.aiChat}</span>
      {working ? (
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-normal text-slate-500">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand-500 motion-reduce:animate-none" />
          <span className="max-w-48 truncate">{t.bar.aiWorking(name, what)}</span>
        </span>
      ) : (
        (news || busy) && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
      )}
      {!working && <span className={`${KBD} ml-0.5 ${open ? "border-brand-100 bg-brand-50 text-brand-600" : ""}`}>Ctrl J</span>}
    </button>
  );
}

type Command = { id: string; group: "ai" | "flows" | "places" | "commands"; icon: LucideIcon; label: string; note?: string; hint?: string; run: () => void };

/** The search over everything, in the middle of the window's top bar (Ctrl+P). */
export function SearchBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setOpen((now) => !now);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t.shell.search}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md border border-slate-200 bg-sheet/80 px-2.5 text-[12.5px] text-slate-400 hover:border-slate-300 hover:bg-sheet hover:text-slate-500"
      >
        <Sparkles size={14} strokeWidth={1.75} className="shrink-0 text-brand-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">{t.shell.searchPlaceholder}</span>
        <span className={KBD}>Ctrl P</span>
      </button>
      {open && <CommandDialog onClose={() => setOpen(false)} onToggleSidebar={onToggleSidebar} />}
    </>
  );
}

const PLACES: [Place, LucideIcon, () => string][] = [
  ["library", LayoutList, () => t.flows],
  ["review", Inbox, () => t.awaitingReview],
  ["runs", CalendarClock, () => t.runs.place],
  ["secrets", KeyRound, () => t.secrets],
  ["extensions", Blocks, () => t.extensions.place],
  ["settings", Settings2, () => t.shell.settings],
];

function CommandDialog({ onClose, onToggleSidebar }: { onClose: () => void; onToggleSidebar: () => void }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const summaries = useStudio((s) => s.summaries);
  const flow = useStudio((s) => s.flow);
  const open = useStudio((s) => s.open);
  const setPlace = useStudio((s) => s.setPlace);
  const startRun = useStudio((s) => s.startRun);
  const run = useStudio((s) => s.run);
  const agent = useAgentApi();
  const list = useRef<HTMLDivElement>(null);
  const commands = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (s: string) => q === "" || s.toLowerCase().includes(q);
    const out: Command[] = [];
    if (q !== "")
      out.push({
        id: "ai",
        group: "ai",
        icon: Sparkles,
        label: query.trim(),
        note: t.shell.askAi,
        hint: t.shell.askAiHint,
        run: () => {
          const s = agent.getState();
          s.setDraft(s.current, query.trim());
          s.setOpen(true);
          setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-agent-input]")?.focus(), 50);
        },
      });
    for (const f of summaries) {
      if (!hit(f.name)) continue;
      // To the editor from any place, as the library opens flows.
      const go = () => {
        setPlace("flows");
        void open(f.id);
      };
      out.push({ id: `flow:${f.id}`, group: "flows", icon: Workflow, label: f.name, note: flow?.id === f.id ? "●" : undefined, run: go });
    }
    for (const [place, icon, label] of PLACES) if (hit(label())) out.push({ id: `place:${place}`, group: "places", icon, label: label(), run: () => setPlace(place) });
    const actions: Command[] = [
      { id: "new", group: "commands", icon: Plus, label: t.shell.newFlowCommand, run: () => setPlace("library") },
      // Not while a run of it is under way: that would start a second copy (the bar's Run and F5 hold back too).
      ...(flow && !isActive(run) ? [{ id: "run", group: "commands" as const, icon: Play, label: t.shell.runCommand, hint: "F5", run: () => void startRun() }] : []),
      { id: "ai-toggle", group: "commands", icon: MessageSquareText, label: t.shell.toggleAi, hint: "Ctrl+J", run: () => agent.getState().setOpen(!agent.getState().open) },
      { id: "sidebar", group: "commands", icon: LayoutList, label: t.shell.toggleSidebar, hint: "Ctrl+B", run: onToggleSidebar },
      { id: "theme", group: "commands", icon: Moon, label: t.shell.themeCommand(document.documentElement.dataset.theme === "dark" ? t.bar.themeLight : t.bar.themeDark), run: () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
      { id: "runner", group: "commands", icon: AppWindow, label: t.runner.open, run: () => void runnerApi.openWindow().catch(() => {}) },
    ];
    for (const c of actions) if (hit(c.label)) out.push(c);
    return out;
  }, [query, summaries, flow, open, setPlace, startRun, run, agent, onToggleSidebar]);
  // Something typed puts the AI first only when nothing else matches it.
  // The AI comes first: SpellSheet is built by asking it, so what is typed goes to it on Enter,
  // unless it names a flow, place or action exactly (then that opens).
  const exact = commands.some((c) => c.group !== "ai" && c.label.toLowerCase() === query.trim().toLowerCase());
  const ordered = useMemo(() => {
    const ai = commands.filter((c) => c.group === "ai");
    const rest = commands.filter((c) => c.group !== "ai");
    return exact ? [...rest, ...ai] : [...ai, ...rest];
  }, [commands, exact]);
  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-at="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const groups: [Command["group"], string][] = [
    ...(exact ? [] : [["ai", t.shell.askAi] as [Command["group"], string]]),
    ["flows", t.shell.groupFlows],
    ["places", t.shell.groupPlaces],
    ["commands", t.shell.groupCommands],
    ...(exact ? [["ai", t.shell.askAi] as [Command["group"], string]] : []),
  ];
  let index = -1;
  // Out of the top bar: its centring transform would hold a fixed layer inside it.
  return createPortal(
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={t.shell.search}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute top-1.5 left-1/2 flex max-h-[min(560px,80vh)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-slate-200 bg-sheet shadow-dialog"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-slate-200 px-4">
          <Sparkles size={16} strokeWidth={1.75} className="text-brand-500" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setAt((a) => Math.min(ordered.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setAt((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(ordered[at]);
              } else if (e.key === "Escape") onClose();
            }}
            placeholder={t.shell.searchInput}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-slate-400"
          />
          <span className={KBD}>Esc</span>
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {ordered.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-slate-500">{t.shell.noMatch}</div>}
          {groups.map(([group, title]) => {
            const items = ordered.filter((c) => c.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="mb-1">
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-slate-400">{title}</div>
                {items.map((c) => {
                  index = ordered.indexOf(c);
                  const on = index === at;
                  const Icon = c.icon;
                  const i = index;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      data-at={i}
                      onMouseMove={() => setAt(i)}
                      onClick={() => choose(c)}
                      className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] ${on ? "bg-slate-100 text-ink" : "text-slate-700"}`}
                    >
                      <Icon size={15} strokeWidth={1.75} className={c.group === "ai" ? "shrink-0 text-brand-500" : "shrink-0 text-slate-500"} aria-hidden="true" />
                      {c.group === "ai" ? (
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-brand-700">{c.note}：</span>
                          {c.label}
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      )}
                      {c.note && c.group !== "ai" && <span className="text-[10px] text-brand-500">{c.note}</span>}
                      {c.hint && <span className="shrink-0 text-[11px] text-slate-400">{c.hint}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex h-8 shrink-0 items-center border-t border-slate-200 bg-paper px-4 text-[11px] text-slate-400">{t.shell.navigateHint}</div>
      </div>
    </div>,
    document.body,
  );
}
