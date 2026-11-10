import { AppWindow, Globe, Loader2, MonitorSmartphone, X } from "lucide-react";
import { useState } from "react";
import { useStudio } from "../context";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { cleanTree, pagesOf, type Screen, useScreens } from "../lib/screenParts";

/** The browser Writer opens for picking and for reading pages, shared with 「画面から選ぶ」. */
const STUDIO_BROWSER = "studio-pick";
const NO_SCREENS: Screen[] = [];
const errorText = (e: unknown) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/**
 * The paste way's 「画面を添える」: the person shows the AI a window or a page,
 * and the next request carries the names and kinds of its parts (lib/screenParts.ts).
 */
export function ScreenAttach({ chatId }: { chatId: string }) {
  const add = useScreens((s) => s.add);
  const steps = useStudio((s) => s.flow?.steps);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const s = t.aiChat.screen;
  const pages = pagesOf(steps ?? []);

  const read = async (work: () => Promise<Screen | null>) => {
    setBusy(true);
    setNote(null);
    try {
      const screen = await work();
      if (!screen) return;
      if (screen.parts === 0) setNote(s.nothing);
      else {
        add(chatId, screen);
        setOpen(false);
      }
    } catch (e) {
      setNote(s.failed(errorText(e)));
    } finally {
      setBusy(false);
    }
  };
  const readApp = () =>
    read(async () => {
      const picked = await api.pointAt("desktop", { action: "pick", scope: "window", message: s.appBanner, labels: t.picker.windowTag });
      if (picked.cancelled || picked.status === "cancelled") return null;
      const window = (picked.target as { window?: Record<string, unknown> } | undefined)?.window;
      if (!window) return null;
      const ui = await api.pointAt("desktop", { window, maxNodes: 600 });
      const info = (ui.window ?? {}) as { title?: string; process?: string };
      return { kind: "app", title: info.title ?? String(window.title ?? ""), where: info.process ?? String(window.process ?? ""), window, ...cleanTree(String(ui.snapshot ?? ""), "app") };
    });
  const readWeb = (address: string) =>
    read(async () => {
      const page = await api.pointAt("browser", address ? { url: address } : {}, STUDIO_BROWSER);
      return { kind: "web", title: String(page.title ?? ""), where: String(page.url ?? address), ...cleanTree(String(page.snapshot ?? ""), "web") };
    });

  const field = "min-w-0 flex-1 rounded-md border border-slate-300 bg-paper px-2 py-1 text-[12px] outline-none focus:border-primary";
  const small = "inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-paper px-2 py-1 text-[11.5px] text-ink enabled:hover:bg-slate-100 disabled:opacity-50";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={s.attachTitle}
        className="ml-auto flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-slate-600 hover:bg-slate-100 hover:text-ink"
      >
        <MonitorSmartphone size={12} aria-hidden="true" />
        {s.attach}
      </button>
      {open && (
        <div className="absolute right-0 bottom-full left-0 mb-1.5 space-y-2 rounded-lg border border-slate-200 bg-paper p-3 text-[12px] text-ink shadow-lg" role="dialog" aria-label={s.attach}>
          <p className="leading-relaxed text-slate-600">{s.lead}</p>
          <button type="button" disabled={busy} onClick={() => void readApp()} className={small}>
            <AppWindow size={12} aria-hidden="true" />
            {s.app}
          </button>
          <div>
            <div className="mb-1 text-[11px] text-slate-500">{s.web}</div>
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void readWeb(url.trim());
              }}
            >
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className={field} aria-label={s.web} />
              <button type="submit" disabled={busy} className={small}>
                <Globe size={12} aria-hidden="true" />
                {s.webOpen}
              </button>
            </form>
            {pages.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-slate-500">{s.fromFlow}</span>
                {pages.map((page) => (
                  <button key={page} type="button" onClick={() => setUrl(page)} className="max-w-full truncate rounded-full bg-slate-100 px-2 py-0.5 text-[11px] hover:bg-slate-200">
                    {page}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{s.webHint}</p>
          </div>
          {busy && (
            <p className="flex items-center gap-1.5 text-slate-600" role="status">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              {s.reading}
            </p>
          )}
          {note && <p className="leading-relaxed text-shu-600">{note}</p>}
        </div>
      )}
    </>
  );
}

/** The screens that go with the next request, each with a way to take it off. */
export function AttachedScreens({ chatId }: { chatId: string }) {
  const screens = useScreens((s) => s.byChat[chatId] ?? NO_SCREENS);
  const remove = useScreens((s) => s.remove);
  const s = t.aiChat.screen;
  if (screens.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1 text-[11px]">
      {screens.map((screen, i) => (
        <span key={`${screen.kind}:${screen.where}:${screen.title}`} className="flex max-w-full min-w-0 items-center gap-1 rounded-full bg-brand-50 py-0.5 pr-1 pl-2 text-brand-700" title={`${screen.where}\n${s.parts(screen.parts)}`}>
          {screen.kind === "app" ? <AppWindow size={11} className="shrink-0" aria-hidden="true" /> : <Globe size={11} className="shrink-0" aria-hidden="true" />}
          <span className="truncate">{screen.title || screen.where}</span>
          <button type="button" onClick={() => remove(chatId, i)} className="grid h-4 w-4 shrink-0 place-items-center rounded-full hover:bg-brand-100" aria-label={s.remove} title={s.remove}>
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}
