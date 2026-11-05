// A file of the scenario's folder, opened in a sheet over the right of the
// chart. A settings file (format shikigami.config) is a form: one card per
// setting with its type, value, description and the nodes that use it, so
// people change values without touching JSON or the flow. Other text files
// (CSV, notes, run logs) are plain text.
import type { ConfigFile, ConfigItem, ConfigType } from "@shikigami/schema";
import { Calendar, FileCog, FileText, Hash, List, type LucideIcon, Plus, ScrollText, ToggleLeft, Trash2, Type, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { t } from "../lib/i18n";
import { itemUsers, roleOf, useProject } from "../project";
import { stepName } from "./ProjectPanel";

const TYPES: { type: ConfigType; icon: LucideIcon }[] = [
  { type: "text", icon: Type },
  { type: "number", icon: Hash },
  { type: "boolean", icon: ToggleLeft },
  { type: "date", icon: Calendar },
  { type: "list", icon: List },
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

const field = "w-full rounded-[4px] border border-slate-200 bg-sheet px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-brand-500";

function ValueInput({ item, onChange }: { item: ConfigItem; onChange: (value: unknown) => void }) {
  const value = item.value as unknown;
  switch (item.type ?? "text") {
    case "number":
      return (
        <input
          type="number"
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
              onClick={() => onChange(b)}
              className={`rounded-[4px] border px-3 py-1 text-[12.5px] ${value === b ? "border-brand-500 bg-brand-50 font-semibold text-brand-500" : "border-slate-200 text-slate-600"}`}
            >
              {b ? t.project.sheet.yes : t.project.sheet.no}
            </button>
          ))}
        </div>
      );
    case "date":
      return <input type="date" className={field} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
    case "list":
      return <ListInput values={Array.isArray(value) ? value.map(String) : []} onChange={onChange} />;
    default:
      return <input className={field} value={typeof value === "string" ? value : String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
}

function ListInput({ values, onChange }: { values: string[]; onChange: (value: unknown) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    onChange([...values, draft.trim()]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-[4px] border border-slate-200 px-1.5 py-1">
      {values.map((v, i) => (
        <span key={`${v}-${i}`} className="flex items-center gap-1 rounded-[3px] bg-slate-100 px-2 text-[12px] leading-6">
          {v}
          <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} className="text-slate-400 hover:text-ink">
            <X size={11} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        className="min-w-24 flex-1 bg-transparent px-1 text-[12.5px] outline-none"
        value={draft}
        placeholder="＋"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

function ConfigForm({ path, config }: { path: string; config: ConfigFile }) {
  const editConfig = useProject((s) => s.editConfig);
  const scenario = useStudio((s) => s.scenario);
  const types = useStudio((s) => s.stepTypes);
  const select = useStudio((s) => s.select);
  const items = config.items ?? [];
  const users = itemUsers(scenario, path, items);
  const update = (i: number, patch: Partial<ConfigItem>) =>
    editConfig({ ...config, items: items.map((item, j) => (j === i ? { ...item, ...patch } : item)) });
  const names = items.map((i) => i.name);
  return (
    <div className="flex flex-col gap-2 p-3">
      {items.map((item, i) => {
        const type = (item.type ?? "text") as ConfigType;
        const TypeIcon = TYPES.find((x) => x.type === type)?.icon ?? Type;
        const used = users.get(item.name) ?? [];
        const duplicate = item.name && names.indexOf(item.name) !== i;
        return (
          <div key={i} className="group rounded-[4px] border border-slate-200 bg-sheet p-3 focus-within:border-brand-500 focus-within:shadow-[0_0_0_3px_rgb(10_111_168/0.12)]">
            <div className="mb-1.5 flex items-center gap-2">
              <input
                className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-slate-400"
                value={item.name}
                placeholder={t.project.sheet.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <label className="flex items-center gap-1 text-[11px] text-slate-500">
                <TypeIcon size={13} strokeWidth={1.75} aria-hidden="true" />
                <select
                  className="bg-transparent text-[11px] outline-none"
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
                onClick={() => editConfig({ ...config, items: items.filter((_, j) => j !== i) })}
                className="text-slate-300 opacity-0 group-hover:opacity-100 hover:text-shu-500"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            <ValueInput item={item} onChange={(value) => update(i, { value: value as ConfigItem["value"] })} />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <input
                className="min-w-0 flex-1 bg-transparent text-[11.5px] text-slate-500 outline-none placeholder:text-slate-400"
                value={item.description ?? ""}
                placeholder={t.project.sheet.description}
                onChange={(e) => update(i, { description: e.target.value || undefined })}
              />
              {duplicate ? (
                <span className="rounded-[3px] bg-shu-50 px-1.5 text-[11px] leading-[18px] text-shu-500">{t.project.sheet.duplicate(item.name)}</span>
              ) : used.length === 0 ? (
                <span className="rounded-[3px] bg-accent-500/12 px-1.5 text-[11px] leading-[18px] text-accent-500">{t.project.unused}</span>
              ) : (
                used.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => step.id && select({ kind: "step", stepId: step.id })}
                    className="rounded-[3px] bg-brand-50 px-1.5 text-[11px] leading-[18px] text-brand-500 hover:underline"
                  >
                    {stepName(step, types)}
                  </button>
                ))
              )}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => editConfig({ ...config, items: [...items, { name: "", type: "text", value: "" as unknown as ConfigItem["value"] }] })}
        className="flex items-center gap-2 rounded-[4px] border-[1.5px] border-dashed border-slate-300 px-3 py-2 text-[12.5px] text-slate-600 hover:border-brand-500 hover:text-brand-500"
      >
        <Plus size={14} aria-hidden="true" />
        {t.project.sheet.addItem}
        <span className="ml-auto text-[11.5px] text-slate-400">{t.project.sheet.itemHint}</span>
      </button>
      <p className="px-1 pt-1 text-[11.5px] leading-relaxed text-slate-500">{t.project.sheet.howToRead(path)}</p>
    </div>
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
    if (!dirty || window.confirm(t.project.sheet.discard)) p.closeSheet();
  };
  return (
    <aside
      aria-label={sheet.path}
      className="absolute top-3 right-3 bottom-3 z-20 flex w-[460px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[4px] border border-slate-200 bg-sheet shadow-lifted"
    >
      <header className="shrink-0 border-b border-slate-100 px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <Icon size={16} strokeWidth={1.75} className={sheet.config ? "text-role-config" : "text-slate-500"} aria-hidden="true" />
          <b className="min-w-0 truncate text-[15px] font-semibold text-ink">
            {sheet.config ? t.project.sheet.settings : isLog ? t.project.sheet.log : sheet.path.split("/").pop()}
          </b>
          <span className="ml-auto flex items-center gap-1">
            {sheet.config !== null || sheet.raw ? (
              <span className="flex rounded-[4px] bg-slate-100 p-0.5 text-[11.5px]">
                {([false, true] as const).map((raw) => (
                  <button
                    key={String(raw)}
                    type="button"
                    disabled={!raw && parseConfigSafe(sheet.text) === null}
                    onClick={() => p.setRaw(raw)}
                    className={`rounded-[3px] px-2.5 py-0.5 ${sheet.raw === raw ? "bg-sheet font-semibold text-ink shadow-sheet" : "text-slate-500"}`}
                  >
                    {raw ? t.project.sheet.json : t.project.sheet.form}
                  </button>
                ))}
              </span>
            ) : null}
            <button type="button" onClick={close} title={t.close} className="grid h-7 w-7 place-items-center rounded-[4px] text-slate-500 hover:bg-slate-100 hover:text-ink">
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
      {!isLog && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-slate-100 px-4 py-2 text-[11.5px] text-slate-500">
          <span className={`h-1.5 w-1.5 rounded-full ${dirty ? "bg-accent-500" : "bg-moegi-500"}`} />
          <span className="min-w-0 flex-1 truncate">{dirty ? t.project.sheet.unsaved : t.project.sheet.saved}</span>
          <button
            type="button"
            disabled={!dirty}
            onClick={() => void p.saveSheet()}
            className="rounded-[4px] bg-brand-700 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-40"
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
    return v && v.format === "shikigami.config" ? v : null;
  } catch {
    return null;
  }
}
