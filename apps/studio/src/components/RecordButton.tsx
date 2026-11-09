// "記録" on the canvas dock: Studio steps aside while the person works in a
// desktop app or on a page in the browser, then shows what was recorded. It becomes nodes as it is
// (where a new node would go), or goes to the AI to be tidied up; either
// way the raw recording stays in the flow's logs/recordings/.
import type { Step } from "@spellsheet/schema";
import { Circle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAgent } from "../agent";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { clipboardAi } from "../lib/askAi";
import { locale, t } from "../lib/i18n";
import { pageAbove } from "../lib/loopScope";
import { type Recording, recordedSteps, recordingOps, tidyRequest } from "../lib/recording";
import { plain, sentence } from "../lib/sentence";
import { projectApi } from "../project";
import { isActive, insertPlace, newStepId } from "../store";
import { Sentence } from "./StoryView";

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** The browser Studio opens to record with no run going (the picker's, kept open by the adapter). */
const STUDIO_BROWSER = "studio-pick";

/** The address of the flow's first 「ページを開く」, when it is written out. */
function firstPage(steps: readonly Step[]): string {
  for (const s of steps) {
    if (s.type === "browser.open" && typeof s.params?.url === "string" && !s.params.url.includes("{{")) return s.params.url;
    for (const inner of Object.values(s.blocks ?? {})) {
      const found = firstPage(inner);
      if (found) return found;
    }
  }
  return "";
}

type Where = "desktop" | "browser";

export function RecordButton() {
  const flow = useStudio((s) => s.flow);
  const run = useStudio((s) => s.run);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ recording: Recording; path: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState<Where>("desktop");
  const [url, setUrl] = useState("");
  const box = useRef<HTMLDivElement>(null);
  // A run going with its browser open: record there, on the page it is at.
  const running = run && isActive(run) ? run.runId : undefined;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = () => {
    if (!open && flow && !url) setUrl(firstPage(flow.steps ?? []));
    setOpen(!open);
  };

  const record = async () => {
    if (!flow) return;
    const browser = where === "browser";
    if (browser && !running && !url.trim()) return setNote(t.recording.needsUrl);
    setOpen(false);
    setBusy(true);
    setNote(null);
    try {
      const recording = (
        browser
          ? await api.pointAt(
              "browser",
              { action: "record", title: t.recording.bannerTitle, hint: t.recording.browserBannerHint, lang: locale, ...(running ? {} : { url: url.trim() }) },
              running ?? STUDIO_BROWSER,
            )
          : await api.pointAt("desktop", {
              action: "record",
              title: t.recording.bannerTitle,
              hint: t.recording.bannerHint,
            })
      ) as unknown as Recording;
      let path: string | null = `logs/recordings/${stamp()}.json`;
      try {
        await projectApi.writeText(flow.id, path, JSON.stringify(recording, null, 2), false);
      } catch {
        path = null;
      }
      setResult({ recording, path });
    } catch (e) {
      setNote(t.recording.failed(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const choice = (value: Where, label: string, hint: string) => (
    <label className={`flex cursor-pointer gap-2 rounded-md px-2 py-1.5 ${where === value ? "bg-slate-100" : "hover:bg-slate-50"}`}>
      <input type="radio" name="record-where" className="mt-1" checked={where === value} onChange={() => setWhere(value)} />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        <span className="block text-[11px] whitespace-normal text-slate-500">{hint}</span>
      </span>
    </label>
  );

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        title={note ?? t.recording.recordTitle}
        aria-expanded={open}
        onClick={toggle}
        disabled={busy}
        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-slate-100 disabled:opacity-60 ${note ? "text-shu-600" : "text-slate-700"}`}
      >
        <Circle size={11} strokeWidth={0} fill="currentColor" className="text-shu-500" aria-hidden="true" />
        <span className="@max-[560px]:hidden">{busy ? t.recording.busy : t.recording.record}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t.recording.where}
          className="absolute bottom-full left-0 z-30 mb-2 w-72 space-y-1 rounded-lg border border-slate-200 bg-sheet p-2 shadow-raised"
        >
          <p className="px-2 pt-1 text-[11px] font-medium text-slate-600">{t.recording.where}</p>
          {choice("desktop", t.recording.desktop, t.recording.desktopHint)}
          {choice("browser", t.recording.browser, running ? t.recording.browserRunning : t.recording.browserHint)}
          {where === "browser" && !running && (
            <label className="block space-y-1 px-2 pt-1">
              <span className="text-[11px] font-medium text-slate-600">{t.recording.url}</span>
              <input
                className="w-full rounded border border-slate-300 bg-paper px-2 py-1 font-mono text-xs focus:border-primary focus:outline-none"
                value={url}
                placeholder="https://"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void record()}
              />
            </label>
          )}
          {note && <p className="px-2 text-[11px] text-shu-600">{note}</p>}
          <div className="flex justify-end px-2 pt-1 pb-1">
            <button
              type="button"
              className="rounded bg-primary px-3 py-1 text-sm font-semibold text-on-primary hover:bg-primary-hover"
              onClick={() => void record()}
            >
              {t.recording.start}
            </button>
          </div>
        </div>
      )}
      {result &&
        createPortal(
          <RecordingDialog recording={result.recording} path={result.path} onClose={() => setResult(null)} />,
          document.body,
        )}
    </div>
  );
}

const skipText = (reason: "drag" | "failed" | "upload" | "opened") =>
  ({
    drag: t.recording.skippedDrag,
    failed: t.recording.skippedFailed,
    upload: t.recording.skippedUpload,
    opened: t.recording.skippedOpened,
  })[reason];

function RecordingDialog({ recording, path, onClose }: { recording: Recording; path: string | null; onClose: () => void }) {
  const flow = useStudio((s) => s.flow);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const applyOps = useStudio((s) => s.applyOps);
  const select = useStudio((s) => s.select);
  const agentAvailable = useAgent((s) => s.info?.available === true);
  const agentName = useAgent((s) => s.info?.name ?? "AI");
  const askAgent = useAgent((s) => s.send);
  const [told, setTold] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const place = flow ? insertPlace(flow.steps ?? [], selection, null) : null;
  // Nodes going after a 「ページを開く」 work on the page it opens.
  const pageOpen = Boolean(flow && place?.after && (place.after.type === "browser.open" || pageAbove(flow.steps ?? [], place.after.id ?? "")));
  const { steps, skipped } = useMemo(() => recordedSteps(recording.actions, newStepId, { pageOpen }), [recording, pageOpen]);
  const defs = useMemo(() => new Map(stepTypes.map((d) => [d.type, d])), [stepTypes]);
  if (!flow || !place) return null;
  const rows: ({ step: Step } | { skipped: string })[] = [];
  {
    let next = 0;
    recording.actions.forEach((_, index) => {
      const skip = skipped.find((s) => s.index === index);
      if (skip) rows.push({ skipped: skipText(skip.reason) });
      else if (steps[next]) rows.push({ step: steps[next++]! });
    });
  }

  const asNodes = async () => {
    setWorking(true);
    const ops = recordingOps(steps, flow.parts ?? {}, place.position);
    const ok = await applyOps(ops);
    setWorking(false);
    if (ok) {
      if (steps[0]?.id) select({ kind: "step", stepId: steps[0].id });
      onClose();
    }
  };
  const askAi = async () => {
    setWorking(true);
    try {
      const after = place.after;
      const where = after ? t.recording.askWhereAfter(after.name || plain(sentence(after, defs.get(after.type)))) : t.recording.askWhereEnd;
      const text = tidyRequest(recording, flow.name, path, where);
      if (agentAvailable) {
        const sent = await askAgent(text, { id: flow.id, name: flow.name, stepId: after?.id ?? null }, `${flow.name} ・ ${t.recording.title}`);
        if (sent) return onClose();
        setTold(t.recording.notSent(agentName));
      } else {
        setTold(await clipboardAi.ask(text));
      }
    } catch (e) {
      setTold(t.recording.notSent(e instanceof Error ? e.message : String(e)));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30">
      <div role="dialog" aria-label={t.recording.title} className="flex max-h-[85vh] w-[520px] flex-col rounded-lg border border-slate-200 bg-sheet shadow-dialog">
        <div className="flex items-baseline gap-2 border-b border-slate-200 px-5 pt-4 pb-3">
          <h2 className="text-lg font-bold">{t.recording.title}</h2>
          <span className="text-[12px] text-slate-600">{t.recording.count(recording.actions.length)}</span>
          {recording.status === "timedOut" && <span className="ml-auto text-[12px] text-shu-600">{t.recording.timedOut}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-600">{t.recording.empty}</p>
          ) : (
            <ol className="space-y-1">
              {rows.map((row, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-snug">
                  <span className="w-5 shrink-0 text-right text-[11px] text-slate-500 tabular-nums">{i + 1}</span>
                  {"step" in row ? (
                    <span className="min-w-0">
                      {row.step.name ? (
                        <span className="font-medium">
                          {row.step.name}
                          {locale === "ja" ? "：" : ": "}
                        </span>
                      ) : null}
                      <Sentence parts={sentence(row.step, defs.get(row.step.type))} />
                    </span>
                  ) : (
                    <span className="text-slate-500 line-through decoration-slate-300">{row.skipped}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="space-y-2 border-t border-slate-200 px-5 py-3">
          {rows.length > 0 && <p className="text-[12px] text-slate-600">{t.recording.lead}</p>}
          {path && <p className="text-[11px] text-slate-500">{t.recording.savedAt(path)}</p>}
          {told && (
            <p role="status" className="text-[12px] text-shu-600">
              {told}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button type="button" className="rounded px-3 py-1 text-sm text-slate-600 hover:bg-slate-100" onClick={onClose}>
              {t.recording.discard}
            </button>
            <span className="ml-auto" />
            <button
              type="button"
              disabled={working || recording.actions.length === 0}
              className="rounded border border-slate-300 px-3 py-1 text-sm text-ink hover:bg-slate-50 disabled:opacity-50"
              onClick={() => void askAi()}
            >
              {t.recording.askAi}
            </button>
            <button
              type="button"
              disabled={working || steps.length === 0}
              className="rounded bg-primary px-3 py-1 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:bg-slate-300"
              onClick={() => void asNodes()}
            >
              {t.recording.asNodes}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
