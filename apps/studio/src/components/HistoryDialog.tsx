// The open scenario's past: who changed what (record) and the named versions
// kept of it (versions, sharing). Opened from the revision in the scenario
// bar, since both are about how the scenario got to this revision; neither is
// a property of what is selected, so they stay out of the inspector.
import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { Timeline } from "./Timeline";
import { VersionsPanel } from "./VersionsPanel";

type Tab = "timeline" | "versions";

export function HistoryDialog() {
  const open = useStudio((s) => s.historyOpen);
  const setOpen = useStudio((s) => s.setHistoryOpen);
  const name = useStudio((s) => s.scenario?.name);
  const [tab, setTab] = useState<Tab>("timeline");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  if (!open || !name) return null;
  const tabs: [Tab, string][] = [
    ["timeline", t.timeline],
    ["versions", t.versions],
  ];
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label={t.shell.history}
        className="flex h-[80vh] w-[560px] flex-col overflow-hidden rounded-[4px] border border-slate-200 bg-sheet shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 px-3">
          <span className="mr-3 max-w-[200px] truncate text-[13px] font-bold">{name}</span>
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`relative flex h-full items-center px-2.5 text-xs font-medium ${tab === key ? "text-ink" : "text-slate-500 hover:text-ink"}`}
            >
              {label}
              {tab === key && <span className="absolute inset-x-2 bottom-[-1px] h-[2px] bg-ink" />}
            </button>
          ))}
          <button
            type="button"
            className="ml-auto grid h-7 w-7 place-items-center rounded-[3px] text-slate-500 hover:bg-slate-100 hover:text-ink"
            onClick={() => setOpen(false)}
            aria-label={t.close}
            title={`${t.close} (Esc)`}
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{tab === "timeline" ? <Timeline /> : <VersionsPanel />}</div>
      </div>
    </div>
  );
}
