// The parts of the review report a person judges by, without reading the
// flow: the files the trial run wrote (their real content), the values it
// returned, and the table of files and systems the flow works with.
import { AlertTriangle, CloudUpload, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useStudio } from "../context";
import { formatValue } from "../lib/changes";
import { locale, t } from "../lib/i18n";
import { baseName, type FilePreview, loadPreview, type Picture } from "../lib/preview";
import type { UsedRow } from "../lib/reviewFiles";
import { projectApi } from "../project";

type Loaded = { preview: FilePreview; picture?: Picture };

function useFile(flowId: string | undefined, path: string, sheet: string | undefined, stamp: string): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    void loadPreview(flowId, path, sheet).then((l) => live && setLoaded(l));
    return () => {
      live = false;
    };
    // `stamp` changes when a new trial run finishes: the file is read again.
  }, [flowId, path, sheet, stamp]);
  return loaded;
}

const NUMBER = /^-?[\d,]+(\.\d+)?$/;

/** A file's content as it is on disk now: the first rows of each sheet, the start of a text, or a picture. */
export function FileBox({
  flowId,
  path,
  label,
  stamp,
  quiet = false,
  openLabel,
  note,
}: {
  flowId: string | undefined;
  path: string;
  label: string;
  stamp: string;
  quiet?: boolean;
  /** The open button's words, e.g. 「Excel で開く」 (default 「アプリで開く」). */
  openLabel?: string;
  /** A line under the head, e.g. whether the file is still as a run left it. */
  note?: React.ReactNode;
}) {
  const [sheet, setSheet] = useState<string | undefined>(undefined);
  const loaded = useFile(flowId, path, sheet, stamp);
  const preview = loaded?.preview;
  const sheets = preview?.kind === "table" ? (preview.sheets ?? []) : [];
  const current = preview?.kind === "table" ? (preview.sheet ?? sheets[0]) : undefined;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className={`flex flex-wrap items-center gap-x-2 border-b border-slate-200 px-3 py-1.5 text-[12.5px] ${quiet ? "bg-sheet" : "bg-paper"}`}>
        <b className="text-[13px]">{label}</b>
        <span className="min-w-0 font-mono text-[12px] break-all text-slate-500" title={path}>
          {path}
        </span>
        {flowId && preview && preview.kind !== "missing" && (
          <button
            type="button"
            onClick={() => void projectApi.open(flowId, path, false).catch(() => undefined)}
            className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] text-brand-600 hover:underline"
          >
            <ExternalLink size={13} aria-hidden="true" />
            {openLabel ?? t.desk.openFile}
          </button>
        )}
      </div>
      {note}
      {sheets.length > 1 && (
        <div className="flex gap-1 border-b border-slate-200 px-2.5 pt-1.5 text-[12px]" role="tablist">
          {sheets.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === current}
              onClick={() => setSheet(name)}
              className={`-mb-px rounded-t-md border px-2.5 py-1 ${name === current ? "border-slate-200 border-b-sheet bg-sheet font-bold text-ink" : "border-transparent text-slate-500 hover:text-ink"}`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {!preview ? (
        <p className="px-3 py-3 text-[12.5px] text-slate-400">{t.desk.fileLoading}</p>
      ) : preview.kind === "table" ? (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full border-collapse text-[12.5px]">
            {preview.columns.length > 0 && (
              <thead className="sticky top-0 bg-sheet text-left text-[12px] text-slate-500">
                <tr>
                  {preview.columns.map((c, i) => (
                    <th key={i} className={`border-b border-slate-200 px-3 py-1.5 font-semibold whitespace-nowrap ${preview.rows.every((r) => NUMBER.test(r[i] ?? "")) && preview.rows.length > 0 ? "text-right" : ""}`}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {preview.rows.map((row, r) => (
                <tr key={r} className="border-b border-slate-100 last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className={`px-3 py-1.5 ${NUMBER.test(cell) ? "text-right tabular-nums" : ""}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {preview.more && <p className="border-t border-slate-100 px-3 py-1.5 text-[11.5px] text-slate-500">{t.desk.fileMore}</p>}
        </div>
      ) : preview.kind === "text" ? (
        <pre className="max-h-[260px] overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap">
          {preview.text}
          {preview.more && <span className="block font-sans text-[11.5px] text-slate-500">{t.desk.fileMore}</span>}
        </pre>
      ) : preview.kind === "image" && loaded?.picture ? (
        <img src={loaded.picture.src} alt={baseName(path)} className="max-h-[320px] w-auto max-w-full" />
      ) : (
        <p className="px-3 py-3 text-[12.5px] text-slate-500">{preview.kind === "missing" ? t.desk.fileMissing : t.desk.fileNoPreview}</p>
      )}
    </div>
  );
}

/** The values the trial run returned, by what each one is. */
export function OutputValues({ outputs }: { outputs: [string, unknown][] }) {
  const variables = useStudio((s) => s.flow?.variables);
  if (outputs.length === 0) return null;
  const label = (name: string) => variables?.find((v) => v.name === name)?.description?.trim() || null;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className="border-b border-slate-200 bg-paper px-3 py-1.5 text-[13px] font-bold">{t.desk.outputValues}</div>
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {outputs.map(([name, value]) => (
            <tr key={name} className="border-b border-slate-100 last:border-0">
              <th scope="row" className="w-[45%] px-3 py-1.5 text-left align-top font-normal">
                {label(name) ?? name}
                {label(name) && <span className="ml-2 font-mono text-[11px] text-slate-400">{name}</span>}
              </th>
              <td className="px-3 py-1.5 align-top font-semibold break-all tabular-nums">
                {typeof value === "number" ? value.toLocaleString(locale === "ja" ? "ja-JP" : "en-US") : formatValue(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TAG: Record<UsedRow["status"], string> = {
  added: "bg-moegi-100 text-moegi-500",
  changed: "bg-amber-50 text-amber-700",
  removed: "bg-slate-100 text-slate-600",
  same: "",
};

/** The files and systems the flow works with: what kind each is, and what every run does to it. */
export function UsedTable({ rows, created }: { rows: UsedRow[]; created: boolean }) {
  const goTo = useStudio((s) => s.goTo);
  if (rows.length === 0) return <p className="text-[12.5px] text-slate-500">{t.desk.noEffects}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="bg-paper text-left text-[12px] text-slate-500">
          <tr>
            <th className="w-[9em] border-b border-slate-200 px-3 py-1.5 font-semibold">{t.desk.usedKind}</th>
            <th className="border-b border-slate-200 px-3 py-1.5 font-semibold">{t.desk.usedTarget}</th>
            <th className="border-b border-slate-200 px-3 py-1.5 font-semibold">{t.desk.usedEachRun}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.status}${row.target}${row.actions.join()}`}
              onClick={() => row.status !== "removed" && row.stepId && goTo(row.stepId)}
              className={`cursor-pointer border-b border-slate-100 align-top last:border-0 hover:bg-paper ${row.status === "removed" ? "text-slate-400 line-through" : ""}`}
            >
              <td className="px-3 py-2 whitespace-nowrap">
                {t.desk.usedKinds[row.kind]}
                {!created && row.status !== "same" && (
                  <span className={`ml-1.5 inline-block rounded-md px-1.5 text-[10px] leading-4 font-bold no-underline ${STATUS_TAG[row.status]}`}>{t.desk.effect[row.status]}</span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[12px] break-all" title={row.atRun ? row.target : undefined}>
                {row.atRun ? <span className="font-sans text-[12.5px] text-slate-500">{t.desk.usedAtRun}</span> : row.target || "—"}
              </td>
              <td className="px-3 py-2">
                {row.reads ? (
                  <span className="text-slate-600">{t.desk.usedReadOnly}</span>
                ) : (
                  <span className={`inline-flex items-start gap-1 font-semibold ${row.danger ? "text-shu-600" : ""}`}>
                    {row.danger && <AlertTriangle size={13} className="mt-[3px] shrink-0" aria-hidden="true" />}
                    {row.actions.join("、")}
                  </span>
                )}
                {row.external && (
                  <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-amber-700">
                    <CloudUpload size={12} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                    {t.desk.sentOutside(row.external.service, row.external.data)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
