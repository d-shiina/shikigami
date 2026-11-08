import { ChevronRight } from "lucide-react";
// The building blocks of the inspector and the node editor: a "項目 | 値" row,
// a collapsible section, a text field that commits on blur, a path field.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { CircleHelp, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectMaybe } from "../../project";
import { t } from "../../lib/i18n";
import { useFileDropTarget } from "../FileDrag";
























export type JsonSchema = {
  type?: string;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | { type?: string | string[] };
};

export const inputClass =
  "w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs focus:border-primary focus:bg-sheet focus:outline-none";

/** Text field that commits on blur / Enter, so each edit is one undoable change. */
export function CommitInput(props: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
  /** A <datalist> id offering values to pick. */
  list?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  const commit = () => draft !== props.value && props.onCommit(draft);
  const common = {
    value: draft,
    placeholder: props.placeholder,
    className: `${inputClass} ${props.mono ? "font-mono text-xs" : ""}`,
    onBlur: commit,
  };
  return props.multiline ? (
    <textarea {...common} rows={4} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...common}
      list={props.list}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/**
 * A file or folder of the flow: the files in its folder to choose from while
 * typing, and "参照…" to pick one in Explorer. A file from elsewhere is
 * copied onto its shelf (input/, templates/…) so the flow keeps working on
 * another PC; a folder elsewhere is kept as its full path.
 */
export function PathField({ value, folder, onChange }: { value: string; folder: boolean; onChange: (value: unknown) => void }) {
  const files = useProjectMaybe((s) => s.files, null);
  const copyIn = useProjectMaybe((s) => s.copyIn, null);
  const listId = useMemo(() => `files-${Math.random().toString(36).slice(2)}`, []);
  const browse = async () => {
    const dir = files?.dir ?? "";
    const picked = await invoke<string | null>("runner_pick", { kind: folder ? "folder" : "file", start: dir || null }).catch(() => null);
    if (!picked) return;
    const norm = (p: string) => p.replace(/\\/g, "/");
    const inside = dir && norm(picked).toLowerCase().startsWith(`${norm(dir).toLowerCase()}/`);
    if (inside) return onChange(norm(picked).slice(norm(dir).length + 1));
    if (folder || !copyIn) return onChange(picked);
    // Only once the copy is there: a file of the same name already on the
    // shelf, or a failed copy, would otherwise point the node at other contents.
    const [copied] = await copyIn([picked], null);
    if (copied) onChange(copied.path);
  };
  // A file dragged from the project panel or Explorer lands here too.
  const drop = useFileDropTarget(folder ? "folder" : "file", (paths) => onChange(paths[0]));
  return (
    <div
      {...drop.attrs}
      title={drop.armed ? undefined : t.fileDrop.fieldHint}
      className={`flex gap-1 rounded-lg ${drop.over ? "bg-brand-50 outline-2 outline-brand-500" : drop.armed ? "outline-1 outline-dashed outline-brand-500/60" : ""}`}
    >
      <CommitInput value={value} list={listId} placeholder={drop.over ? t.fileDrop.putHere : t.props.pathPlaceholder} onCommit={(text) => onChange(text === "" ? null : text)} />
      <datalist id={listId}>
        {(folder ? (files?.folders ?? []) : (files?.files ?? []).map((f) => f.path))
          .filter((p) => !p.startsWith("work/") && !p.startsWith("logs/"))
          .map((p) => (
            <option key={p} value={p} />
          ))}
      </datalist>
      <button
        type="button"
        title={t.props.browseTitle}
        onClick={() => void browse()}
        className="flex shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-sheet px-2 text-[11px] text-slate-700 hover:bg-slate-50"
      >
        <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
        {t.props.browse}
      </button>
    </div>
  );
}

/**
 * Rows with the name above the value instead of left of it: in the right
 * pane (about 420px) a name column would leave the value two thirds of it.
 */
export const StackedRows = createContext(false);

/** One "項目 | 値" row, Blender-style: the label sits left of its value (or above it, in StackedRows). */
export function Row({
  label,
  hint,
  help,
  title,
  socket,
  onRemove,
  children,
}: {
  label: string;
  /** Shown under the value, always (a preview of what the row will do). */
  hint?: string;
  /**
   * What the setting means: behind a ? beside the label, so a form of four
   * settings is four rows and not four rows with a paragraph under each.
   */
  help?: string;
  title?: string;
  socket?: string;
  /** An optional setting: × clears it and takes the row away. */
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  const stacked = useContext(StackedRows);
  const helpMark = help && help !== label && (
    <span title={help} aria-label={help} className="ml-1 shrink-0 cursor-help text-slate-400 hover:text-slate-600">
      <CircleHelp size={11} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
  const remove = onRemove && (
    <button
      type="button"
      title={t.props.removeSetting}
      aria-label={t.props.removeSetting}
      className="rounded-md px-1 text-[12px] leading-none text-slate-400 hover:bg-slate-100 hover:text-ink"
      onClick={(e) => {
        e.preventDefault();
        onRemove();
      }}
    >
      ×
    </button>
  );
  if (stacked)
    return (
      <label className="block py-1.5">
        <span className="flex min-h-[18px] items-center pb-1 text-[11.5px] leading-tight text-slate-600" title={title}>
          {socket && <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: socket }} />}
          {label}
          {helpMark}
          {remove && <span className="ml-auto">{remove}</span>}
        </span>
        {children}
        {hint && <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">{hint}</span>}
      </label>
    );
  return (
    <label className={`grid ${onRemove ? "grid-cols-[84px_1fr_auto] [[data-wide]_&]:grid-cols-[132px_1fr_auto]" : "grid-cols-[84px_1fr] [[data-wide]_&]:grid-cols-[132px_1fr]"} items-start gap-x-2 py-1`}>
      <span className="relative flex min-h-[26px] items-center justify-end text-right text-[11px] leading-tight text-slate-500" title={title}>
        {socket && <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-white" style={{ background: socket }} />}
        {label}
        {helpMark}
      </span>
      <span className="min-w-0">
        {children}
        {hint && <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">{hint}</span>}
      </span>
      {remove && <span className="mt-1">{remove}</span>}
    </label>
  );
}

/**
 * 「＋ 設定を追加」: the settings not on screen, by name. Only the required
 * ones and those with a value are shown, so a node starts with one or two
 * rows instead of every setting it could take.
 */
export type AddChoice = { key: string; label: string; /** The heading it is listed under (設定・出力・実行の設定). */ group?: string };

export function AddRow({ choices, onAdd }: { choices: AddChoice[]; onAdd: (key: string) => void }) {
  const stacked = useContext(StackedRows);
  if (choices.length === 0) return null;
  const groups = [...new Set(choices.map((c) => c.group ?? ""))];
  const option = (c: AddChoice) => (
    <option key={c.key} value={c.key}>
      {c.label}
    </option>
  );
  return (
    <div className={stacked ? "py-1.5" : "grid grid-cols-[84px_1fr] gap-x-2 py-1 [[data-wide]_&]:grid-cols-[132px_1fr]"}>
      {!stacked && <span />}
      <select
        className="w-full cursor-pointer rounded-lg border border-dashed border-slate-300 bg-transparent px-2 py-1 text-[11px] text-slate-500 hover:border-brand-500 hover:text-brand-600 focus:outline-none"
        value=""
        aria-label={t.props.addSetting}
        onChange={(e) => e.target.value && onAdd(e.target.value)}
      >
        <option value="">{t.props.addSetting}</option>
        {groups.length <= 1
          ? choices.map(option)
          : groups.map((g) =>
              g === "" ? (
                choices.filter((c) => !c.group).map(option)
              ) : (
                <optgroup key={g} label={g}>
                  {choices.filter((c) => c.group === g).map(option)}
                </optgroup>
              ),
            )}
      </select>
    </div>
  );
}

/** A collapsible group of rows, like a Blender properties panel. */
export function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <details open className="group border-t border-slate-100 px-4 py-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-1 py-1 text-[12px] font-medium text-slate-500 select-none hover:text-ink">
        <ChevronRight size={13} strokeWidth={2} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
        {title}
        {aside && <span className="ml-auto font-normal tracking-normal">{aside}</span>}
      </summary>
      <div className="pt-1">{children}</div>
    </details>
  );
}

