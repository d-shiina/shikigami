// A file of the flow's folder, opened in a sheet over the right of the
// chart. A settings file (format spellsheet.config) is a form: one card per
// setting with its type, value, description and the nodes that use it, so
// people change values without touching JSON or the flow. Other text files
// (CSV, notes, run logs) are plain text.
import type { ConfigFile, ConfigItem, ConfigType, Flow, Step } from "@spellsheet/schema";
import { Calendar, FileCog, FileText, Folder, Hash, List, type LucideIcon, Plus, ScrollText, ToggleLeft, Type, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { portable } from "../lib/filePlaces";
import { useBusy } from "../lib/busy";
import { pickPath, usePickerOpen } from "../lib/picker";
import { useEffect, useRef, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { CONFIG_FORMAT, itemUsers, roleOf, useProject } from "../project";
import { isFormat } from "../lib/legacyStorage";
import { stepName } from "./ProjectPanel";

const TYPES: { type: ConfigType; icon: LucideIcon }[] = [
  { type: "text", icon: Type },
  { type: "number", icon: Hash },
  { type: "boolean", icon: ToggleLeft },
  { type: "date", icon: Calendar },
  { type: "list", icon: List },
  { type: "folder", icon: Folder },
];

/** A value that fits the type, keeping what it can of the old one. */
function convert(value: unknown, type: ConfigType): unknown {
  switch (type) {
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case "boolean":
      return value === true || value === "true";
    case "list":
      return Array.isArray(value) ? value : value === undefined || value === "" ? [] : [String(value)];
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 10);
    default:
      return Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value);
  }
}

const field = "h-8 w-full min-w-0 rounded-lg border border-slate-200 bg-sheet px-2 text-[13px] text-ink outline-none placeholder:text-slate-400 focus:border-primary";

function ValueInput({ item, onChange }: { item: ConfigItem; onChange: (value: unknown) => void }) {
  const value = item.value as unknown;
  switch (item.type ?? "text") {
    case "number":
      return (
        <input
          type="number"
          data-value
          className={field}
          value={typeof value === "number" ? value : Number(value ?? 0)}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
      );
    case "boolean":
      return (
        <div className="flex gap-1">
          {[true, false].map((b) => (
            <button
              key={String(b)}
              type="button"
              data-value={b ? "" : undefined}
              onClick={() => onChange(b)}
              className={`h-8 rounded-lg border px-3 text-[12.5px] ${value === b ? "border-brand-500 bg-brand-50 font-semibold text-brand-500" : "border-slate-200 text-slate-600"}`}
            >
              {b ? t.project.sheet.yes : t.project.sheet.no}
            </button>
          ))}
        </div>
      );
    case "date":
      return <input type="date" data-value className={field} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
    case "list":
      return <ListInput values={Array.isArray(value) ? value.map(String) : []} onChange={onChange} />;
    case "folder":
      return <FolderInput value={typeof value === "string" ? value : ""} onChange={onChange} />;
    default:
      return (
        <input
          data-value
          className={field}
          placeholder={t.project.sheet.valuePlaceholder}
          value={typeof value === "string" ? value : String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/**
 * A folder: typed, or picked in Explorer. A folder inside the user's own
 * profile (a Box Drive, OneDrive or Dropbox folder) is kept as %USERPROFILE%\…, so
 * the setting fits everyone who runs the flow.
 */
function FolderInput({ value, onChange }: { value: string; onChange: (value: unknown) => void }) {
  const picking = usePickerOpen();
  const [busy, once] = useBusy();
  const browse = () =>
    once(async () => {
      const picked = await pickPath("folder", value);
      if (!picked) return;
      const sync = await invoke<{ profile: string | null }>("sync_folders").catch(() => ({ profile: null }));
      onChange(portable(picked, sync.profile));
    });
  return (
    <div className="flex gap-1">
      <input data-value className={field} placeholder="\\server\\share" value={value} onChange={(e) => onChange(e.target.value)} />
      <button
        type="button"
        title={t.props.browseTitle}
        aria-label={t.props.browseTitle}
        disabled={picking || busy}
        onClick={() => void browse()}
        className="h-8 shrink-0 rounded-lg border border-slate-200 px-2 text-[12px] text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {t.props.browse}
      </button>
    </div>
  );
}

function ListInput({ values, onChange }: { values: string[]; onChange: (value: unknown) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    onChange([...values, draft.trim()]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 px-1.5 py-1">
      {values.map((v, i) => (
        <span key={`${v}-${i}`} className="flex items-center gap-1 rounded-md bg-slate-100 px-2 text-[12px] leading-6">
          {v}
          <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} className="text-slate-400 hover:text-ink">
            <X size={11} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        data-value
        className="min-w-24 flex-1 bg-transparent px-1 text-[12.5px] outline-none"
        value={draft}
        placeholder="＋"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          // Enter adds what was typed as one element; the table's Enter (next row)
          // only when there is nothing to add, else the row would be rebuilt from the old list.
          if (!draft.trim()) return;
          e.preventDefault();
          e.stopPropagation();
          add();
        }}
        onBlur={add}
      />
    </div>
  );
}

/** The node of this flow that reads the settings file `path`, and the name it saves them under. */
export function readerOf(flow: Flow | null, path: string): { step: Step; variable: string } | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const find = (list: Step[]): Step | null => {
    for (const s of list) {
      if (s.type === "config.read" && typeof s.params?.path === "string" && norm(s.params.path) === norm(path)) return s;
      for (const children of Object.values(s.blocks ?? {})) {
        const found = find(children);
        if (found) return found;
      }
    }
    return null;
  };
  const step = find(flow?.steps ?? []);
  return step ? { step, variable: step.saveAs || "settings" } : null;
}

const cell = "h-8 w-full min-w-0 rounded-lg border border-slate-200 bg-sheet px-2 text-[13px] text-ink outline-none placeholder:text-slate-400 focus:border-primary";

/**
 * The settings as a table, one row per setting: name | value | type | ×.
 * Typing saves; Enter moves on (name → value → next row). The description
 * and the nodes that use a setting sit under its row only when there is
 * something to say.
 */
function ConfigForm({ path, config }: { path: string; config: ConfigFile }) {
  const editConfig = useProject((s) => s.editConfig);
  const flow = useStudio((s) => s.flow);
  const types = useStudio((s) => s.stepTypes);
  const select = useStudio((s) => s.select);
  const items = config.items ?? [];
  const users = itemUsers(flow, path, items);
  const update = (i: number, patch: Partial<ConfigItem>) =>
    editConfig({ ...config, items: items.map((item, j) => (j === i ? { ...item, ...patch } : item)) });
  const names = items.map((i) => i.name);
  // A sheet that opens with only a blank row starts in its name field.
  const [focusRow, setFocusRow] = useState<number | null>(items.length === 1 && !items[0]?.name ? 0 : null);
  const table = useRef<HTMLDivElement>(null);
  const add = () => {
    editConfig({ ...config, items: [...items, { name: "", type: "text", value: "" as unknown as ConfigItem["value"] }] });
    setFocusRow(items.length);
  };
  useEffect(() => {
    if (focusRow === null) return;
    table.current?.querySelector<HTMLInputElement>(`[data-row="${focusRow}"] input`)?.focus();
    setFocusRow(null);
  }, [focusRow, items.length]);
  const onEnter = (e: React.KeyboardEvent, next: () => void) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    next();
  };
  const reader = readerOf(flow, path);
  return (
    <div className="p-3" ref={table}>
      {items.length > 0 && (
        <div className="grid grid-cols-[1fr_1.3fr_28px_24px] gap-x-2 px-1 pb-1 text-[11px] text-slate-500">
          <span>{t.project.sheet.headers.name}</span>
          <span>{t.project.sheet.headers.value}</span>
          <span />
          <span />
        </div>
      )}
      <div className="space-y-1">
        {items.map((item, i) => {
          const type = (item.type ?? "text") as ConfigType;
          const TypeIcon = TYPES.find((x) => x.type === type)?.icon ?? Type;
          const used = users.get(item.name) ?? [];
          const duplicate = item.name && names.indexOf(item.name) !== i;
          return (
            <div key={i} data-row={i} className="group rounded-lg py-0.5 focus-within:bg-slate-50">
              <div className="grid grid-cols-[1fr_1.3fr_28px_24px] items-center gap-x-2">
                <input
                  className={`${cell} font-medium`}
                  value={item.name}
                  placeholder={t.project.sheet.namePlaceholder}
                  aria-label={t.project.sheet.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  onKeyDown={(e) => onEnter(e, () => table.current?.querySelector<HTMLElement>(`[data-row="${i}"] [data-value]`)?.focus())}
                />
                <span data-value-cell onKeyDown={(e) => onEnter(e, () => (i === items.length - 1 ? add() : setFocusRow(i + 1)))}>
                  <ValueInput item={item} onChange={(value) => update(i, { value: value as ConfigItem["value"] })} />
                </span>
                <label className="relative grid h-8 w-7 cursor-pointer place-items-center rounded-lg text-slate-500 hover:bg-slate-100" title={t.project.sheet.types[type]}>
                  <TypeIcon size={14} strokeWidth={1.75} aria-hidden="true" />
                  <select
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label={t.project.sheet.headers.type}
                    value={type}
                    onChange={(e) => {
                      const next = e.target.value as ConfigType;
                      update(i, { type: next, value: convert(item.value, next) as ConfigItem["value"] });
                    }}
                  >
                    {TYPES.map((x) => (
                      <option key={x.type} value={x.type}>
                        {t.project.sheet.types[x.type]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  title={t.project.sheet.removeItem}
                  aria-label={t.project.sheet.removeItem}
                  onClick={() => editConfig({ ...config, items: items.filter((_, j) => j !== i) })}
                  className="grid h-8 w-6 place-items-center rounded-lg text-slate-300 hover:bg-slate-100 hover:text-shu-500"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 px-2 empty:hidden">
                <input
                  className="hidden min-w-0 bg-transparent text-[11.5px] text-slate-500 outline-none placeholder:text-slate-400 group-focus-within:block [&:not(:placeholder-shown)]:block"
                  value={item.description ?? ""}
                  placeholder={t.project.sheet.description}
                  onChange={(e) => update(i, { description: e.target.value || undefined })}
                />
                {duplicate ? (
                  <span className="text-[11px] text-shu-500">{t.project.sheet.duplicate(item.name)}</span>
                ) : used.length > 0 ? (
                  <span className="flex flex-wrap gap-1 py-0.5">
                    {used.map((step) => (
                      <button
                        key={step.id}
                        type="button"
                        onClick={() => step.id && select({ kind: "step", stepId: step.id })}
                        className="rounded-md bg-brand-50 px-1.5 text-[11px] leading-[18px] text-brand-500 hover:underline"
                      >
                        {stepName(step, types)}
                      </button>
                    ))}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-1 flex w-full items-center gap-2 rounded-lg border-[1.5px] border-dashed border-slate-300 px-3 py-1.5 text-[12.5px] text-slate-600 hover:border-brand-500 hover:text-brand-500"
      >
        <Plus size={14} aria-hidden="true" />
        {t.project.sheet.addItem}
      </button>
      <p className="px-1 pt-3 text-[11.5px] leading-relaxed text-slate-500">
        {reader ? t.project.sheet.useHint(reader.variable) : <AddReader path={path} />}
      </p>
    </div>
  );
}

/** The flow has no node reading this file yet: one click puts 「設定ファイル読み込み」 at its start. */
function AddReader({ path }: { path: string }) {
  const applyOps = useStudio((s) => s.applyOps);
  return (
    <>
      {t.project.sheet.noReader}{" "}
      <button
        type="button"
        className="text-brand-600 hover:underline"
        onClick={() => void applyOps([{ op: "addStep", step: { type: "config.read", params: { path }, saveAs: "settings" }, position: { index: 0 } }])}
      >
        {t.project.sheet.addReader}
      </button>
    </>
  );
}

export function FileSheet() {
  const sheet = useProject((s) => s.sheet);
  const p = useProject((s) => s);
  const dirty = sheet !== null && sheet.text !== sheet.saved;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && sheet) {
        e.preventDefault();
        void p.saveSheet();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, p]);
  if (!sheet) return null;
  const role = roleOf(sheet.path);
  const isLog = role === "logs";
  const asForm = sheet.config !== null && !sheet.raw;
  const Icon = sheet.config ? FileCog : isLog ? ScrollText : FileText;
  const close = () => {
    if (asForm && dirty) void p.saveSheet();
    if (asForm || !dirty) return p.closeSheet();
    void p.leaveSheet();
  };
  return (
    <aside
      aria-label={sheet.path}
      className="absolute top-3 right-3 bottom-3 z-20 flex w-[460px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-slate-200 bg-sheet shadow-lifted"
    >
      <header className="shrink-0 border-b border-slate-100 px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <Icon size={16} strokeWidth={1.75} className={sheet.config ? "text-role-config" : "text-slate-500"} aria-hidden="true" />
          <b className="min-w-0 truncate text-[15px] font-semibold text-ink">
            {sheet.config ? t.project.sheet.settings : isLog ? t.project.sheet.log : sheet.path.split("/").pop()}
          </b>
          <span className="ml-auto flex items-center gap-1">
            {sheet.config !== null || sheet.raw ? (
              <span className="flex rounded-lg bg-slate-100 p-0.5 text-[11.5px]">
                {([false, true] as const).map((raw) => (
                  <button
                    key={String(raw)}
                    type="button"
                    disabled={!raw && parseConfigSafe(sheet.text) === null}
                    onClick={() => p.setRaw(raw)}
                    className={`rounded-md px-2.5 py-0.5 ${sheet.raw === raw ? "bg-sheet font-semibold text-ink shadow-sheet" : "text-slate-500"}`}
                  >
                    {raw ? t.project.sheet.json : t.project.sheet.form}
                  </button>
                ))}
              </span>
            ) : null}
            <button type="button" onClick={close} title={t.close} className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-ink">
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          <span className="font-mono">{sheet.path}</span>
          {sheet.config && ` · ${t.project.sheet.readsEachRun}`}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-paper/40">
        {asForm && sheet.config ? (
          <ConfigForm path={sheet.path} config={sheet.config} />
        ) : (
          <textarea
            spellCheck={false}
            readOnly={isLog}
            wrap={isLog ? "off" : "soft"}
            value={sheet.text}
            onChange={(e) => p.editSheet(e.target.value)}
            className="h-full w-full resize-none bg-sheet p-4 font-mono text-[12px] leading-relaxed text-ink outline-none"
          />
        )}
      </div>
      {!isLog && asForm && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-slate-100 px-4 py-2 text-[11.5px] text-slate-500">
          <span className={`h-1.5 w-1.5 rounded-full ${dirty ? "bg-accent-500" : "bg-moegi-500"}`} />
          <span className="min-w-0 flex-1 truncate">{t.project.sheet.autosaved}</span>
        </footer>
      )}
      {!isLog && !asForm && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-slate-100 px-4 py-2 text-[11.5px] text-slate-500">
          <span className={`h-1.5 w-1.5 rounded-full ${dirty ? "bg-accent-500" : "bg-moegi-500"}`} />
          <span className="min-w-0 flex-1 truncate">{dirty ? t.project.sheet.unsaved : t.project.sheet.saved}</span>
          <button
            type="button"
            disabled={!dirty}
            onClick={() => void p.saveSheet()}
            className="rounded-lg bg-brand-700 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-40"
          >
            {t.project.sheet.save}
            <kbd className="ml-1.5 font-sans text-[10px] opacity-70">Ctrl+S</kbd>
          </button>
        </footer>
      )}
    </aside>
  );
}

function parseConfigSafe(text: string): unknown {
  try {
    const v = JSON.parse(text) as { format?: unknown };
    return v && isFormat(v.format, CONFIG_FORMAT) ? v : null;
  } catch {
    return null;
  }
}
