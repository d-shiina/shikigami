// What 「文字認識（OCR）」 read, laid out to check by eye: which engine read
// it, each line with the characters it was unsure of highlighted, and how
// sure it was. Display only; the raw value stays a click away.
import { t } from "../lib/i18n";
import { ValueView } from "./ValueView";

type Line = { text: string; confidence?: number; unsure?: number[] };
type Read = { text?: string; lines: Line[]; engine?: string; warning?: string; cells?: string[][]; rows?: unknown[] };

const isRead = (v: unknown): v is Read =>
  typeof v === "object" && v !== null && Array.isArray((v as Read).lines) && (v as Read).lines.every((l) => typeof l?.text === "string");

/** Whether `value` is desktop.readText's output. */
export function isOcrOutput(stepType: string | undefined, value: unknown): boolean {
  return stepType === "desktop.readText" && isRead(value);
}

/** One line, its unsure characters marked. */
function LineText({ line }: { line: Line }) {
  const unsure = new Set(line.unsure ?? []);
  if (unsure.size === 0) return <>{line.text}</>;
  const parts: { text: string; unsure: boolean }[] = [];
  [...line.text].forEach((ch, i) => {
    const u = unsure.has(i);
    const last = parts[parts.length - 1];
    if (last && last.unsure === u) last.text += ch;
    else parts.push({ text: ch, unsure: u });
  });
  return (
    <>
      {parts.map((p, i) =>
        p.unsure ? (
          <mark key={i} data-unsure className="rounded-sm bg-accent-500/25 px-px text-inherit underline decoration-accent-500 decoration-2 underline-offset-2">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** `table: true`'s cells, the header row first. */
function CellTable({ cells }: { cells: string[][] }) {
  if (cells.length === 0) return <p className="text-slate-500">{t.ocr.noTable}</p>;
  const cols = Math.max(...cells.map((r) => r.length));
  return (
    <div>
      <div className="pb-1 text-[11px] font-semibold text-slate-600">{t.ocr.table(cells.length, cols)}</div>
      <div className="overflow-x-auto">
        <table data-ocr-table className="border-collapse text-[11px]">
          <tbody>
            {cells.map((row, i) => (
              <tr key={i} className={i === 0 ? "bg-slate-50 font-semibold" : ""}>
                {row.map((c, j) => (
                  <td key={j} className="whitespace-nowrap border border-slate-200 px-1.5 py-0.5">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function OcrResult({ value }: { value: unknown }) {
  if (!isRead(value)) return <ValueView value={value} />;
  const { lines, engine, warning, cells } = value;
  const unsure = lines.reduce((n, l) => n + (l.unsure?.length ?? 0), 0);
  const rated = lines.some((l) => typeof l.confidence === "number");
  return (
    <div className="space-y-2 text-[12px]">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
        {engine && (
          <span>
            {t.ocr.engine}: <span className="font-semibold">{t.ocr.engines[engine] ?? engine}</span>
          </span>
        )}
        <span>{t.ocr.lines(lines.length)}</span>
        {unsure > 0 && <span className="font-semibold text-accent-600">{t.ocr.unsure(unsure)}</span>}
      </div>
      {warning && <p className="text-[11.5px] leading-relaxed text-accent-600">{warning}</p>}
      {cells && <CellTable cells={cells} />}
      {lines.length === 0 ? (
        <p className="text-slate-500">{t.ocr.noText}</p>
      ) : (
        <ol className="divide-y divide-slate-100 rounded border border-slate-200">
          {lines.map((l, i) => (
            <li key={i} className="flex items-baseline gap-2 px-2 py-1">
              <span className="min-w-0 flex-1 break-all">
                <LineText line={l} />
              </span>
              {typeof l.confidence === "number" && (
                <span
                  title={t.ocr.confidence}
                  className={`shrink-0 tabular-nums text-[10.5px] ${l.unsure?.length ? "text-accent-600" : "text-slate-500"}`}
                >
                  {Math.round(l.confidence * 100)}%
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {unsure > 0 && <p className="text-[11px] leading-relaxed text-slate-500">{t.ocr.unsureHint}</p>}
      {!rated && lines.length > 0 && <p className="text-[11px] text-slate-500">{t.ocr.noConfidence}</p>}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-slate-500">{t.ocr.raw}</summary>
        <div className="pt-1">
          <ValueView value={value} />
        </div>
      </details>
    </div>
  );
}
