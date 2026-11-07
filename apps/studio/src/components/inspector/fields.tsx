// The building blocks of the inspector and the node editor: a "項目 | 値" row,
// a collapsible section, a text field that commits on blur, a path field.
import { useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectMaybe } from "../../project";
import { t } from "../../lib/i18n";
























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
  "w-full rounded-[4px] border border-slate-200 bg-slate-50 px-2 py-1 text-xs focus:border-brand-500 focus:bg-sheet focus:outline-none";

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
  return (
    <div className="flex gap-1">
      <CommitInput value={value} list={listId} placeholder={t.props.pathPlaceholder} onCommit={(text) => onChange(text === "" ? null : text)} />
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
        className="flex shrink-0 items-center gap-1 rounded-[3px] border border-slate-300 bg-sheet px-2 text-[11px] text-slate-700 hover:bg-slate-50"
      >
        <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
        {t.props.browse}
      </button>
    </div>
  );
}

/** One "項目 | 値" row, Blender-style: the label sits left of its value. */
export function Row({
  label,
  hint,
  title,
  socket,
  onRemove,
  children,
}: {
  label: string;
  hint?: string;
  title?: string;
  socket?: string;
  /** An optional setting: × clears it and takes the row away. */
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className={`grid ${onRemove ? "grid-cols-[84px_1fr_auto] [[data-wide]_&]:grid-cols-[132px_1fr_auto]" : "grid-cols-[84px_1fr] [[data-wide]_&]:grid-cols-[132px_1fr]"} items-start gap-x-2 py-1`}>
      <span className="relative flex min-h-[26px] items-center justify-end text-right text-[11px] leading-tight text-slate-500" title={title}>
        {socket && <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-white" style={{ background: socket }} />}
        {label}
      </span>
      <span className="min-w-0">
        {children}
        {hint && <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">{hint}</span>}
      </span>
      {onRemove && (
        <button
          type="button"
          title={t.props.removeSetting}
          aria-label={t.props.removeSetting}
          className="mt-1 rounded-[3px] px-1 text-[12px] leading-none text-slate-400 hover:bg-slate-100 hover:text-ink"
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </label>
  );
}

/**
 * 「＋ 設定を追加」: the settings not on screen, by name. Only the required
 * ones and those with a value are shown, so a node starts with one or two
 * rows instead of every setting it could take.
 */
export function AddRow({ choices, onAdd }: { choices: { key: string; label: string }[]; onAdd: (key: string) => void }) {
  if (choices.length === 0) return null;
  return (
    <div className="grid grid-cols-[84px_1fr] gap-x-2 py-1 [[data-wide]_&]:grid-cols-[132px_1fr]">
      <span />
      <select
        className="w-full cursor-pointer rounded-[4px] border border-dashed border-slate-300 bg-transparent px-2 py-1 text-[11px] text-slate-500 hover:border-brand-500 hover:text-brand-600 focus:outline-none"
        value=""
        aria-label={t.props.addSetting}
        onChange={(e) => e.target.value && onAdd(e.target.value)}
      >
        <option value="">{t.props.addSetting}</option>
        {choices.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A collapsible group of rows, like a Blender properties panel. */
export function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <details open className="group border-t border-slate-100 px-4 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-[11px] font-bold tracking-wider text-slate-600 select-none">
        <span className="text-[9px] text-slate-400 transition-transform group-open:rotate-90">▶</span>
        {title}
        {aside && <span className="ml-auto font-normal tracking-normal">{aside}</span>}
      </summary>
      <div className="pt-1">{children}</div>
    </details>
  );
}

