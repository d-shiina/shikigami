// One field of a form made from a flow's inputs: the run window's, and
// Studio's ask before a run when an input has no default.
import { FileText, FolderOpen } from "lucide-react";
import { t } from "../lib/i18n";
import { choiceLabel, type Field } from "./form";

const INPUT = "w-full rounded-lg border border-slate-300 bg-sheet px-2.5 text-[13px] focus:border-primary focus:outline-none";

export function FieldRow({
  field,
  value,
  error,
  onChange,
  onPick,
  autoFocus,
}: {
  field: Field;
  value: string | boolean;
  error?: string;
  onChange: (v: string | boolean) => void;
  onPick: (kind: "file" | "folder", start: string) => Promise<string | null>;
  autoFocus?: boolean;
}) {
  const id = `in-${field.name}`;
  if (field.kind === "checkbox") {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-[13px]">
        <input id={id} autoFocus={autoFocus} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-brand-500" />
        {field.label}
      </label>
    );
  }
  const text = String(value);
  const kind = field.kind;
  let control: React.ReactNode;
  if (kind === "lines" || kind === "json") {
    control = <textarea id={id} autoFocus={autoFocus} value={text} rows={4} onChange={(e) => onChange(e.target.value)} className={`${INPUT} py-1.5 font-mono text-[12.5px]`} />;
  } else if (kind === "select") {
    control = (
      <select id={id} autoFocus={autoFocus} value={text} onChange={(e) => onChange(e.target.value)} className={`${INPUT} h-8 max-w-[360px]`}>
        {text === "" && (
          <option value="" disabled>
            {t.runner.choose}
          </option>
        )}
        {(field.choices ?? []).map((c, i) => (
          <option key={JSON.stringify(c)} value={String(i)}>
            {choiceLabel(c)}
          </option>
        ))}
      </select>
    );
  } else if (kind === "date" || kind === "month") {
    control = <input id={id} autoFocus={autoFocus} type={kind} value={text} onChange={(e) => onChange(e.target.value)} className={`${INPUT} h-8 max-w-[200px]`} />;
  } else if (kind === "file" || kind === "folder") {
    control = (
      <div className="flex gap-2">
        <input id={id} autoFocus={autoFocus} type="text" value={text} onChange={(e) => onChange(e.target.value)} spellCheck={false} className={`${INPUT} h-8 min-w-0 flex-1`} />
        <button
          type="button"
          title={kind === "file" ? t.runner.browseFile : t.runner.browseFolder}
          onClick={() =>
            void onPick(kind, text).then(
              (path) => path && onChange(path),
              () => {},
            )
          }
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-sheet px-3 text-[12.5px] font-semibold hover:bg-slate-50"
        >
          {kind === "file" ? <FileText size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
          {t.runner.browse}
        </button>
      </div>
    );
  } else {
    control = (
      <input
        id={id}
        autoFocus={autoFocus}
        type={kind === "password" ? "password" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} h-8 ${kind === "number" ? "max-w-[200px] text-right" : ""}`}
      />
    );
  }
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12.5px] font-semibold">
        {field.label}
        {field.required && <span className="ml-1 text-shu-600">*</span>}
      </label>
      {control}
      {error ? (
        <div className="mt-1 text-[11.5px] text-shu-600">{error}</div>
      ) : (
        kind === "lines" && <div className="mt-1 text-[11.5px] text-slate-500">{t.runner.linesHint}</div>
      )}
    </div>
  );
}

