// A run value laid out for reading: an object as a 項目 | 値 table, a list
// of records as a table with one row per record, a plain list as numbered
// lines. Display only.
import type { VariableChange } from "../store";

const MAX_ROWS = 8;
const MAX_COLS = 6;

type Plain = Record<string, unknown>;
const isRecord = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** One value on one line: numbers grouped, lists counted, records as "key: value". */
export function shortText(v: unknown): string {
  if (v === null || v === undefined) return "（なし）";
  if (typeof v === "number") return v.toLocaleString("ja-JP");
  if (typeof v === "string") return v === "" ? "（空）" : v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `${v.length}件`;
  if (isRecord(v)) {
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${shortText(x)}`)
      .join("、");
  }
  return String(v);
}

function Cell({ value }: { value: unknown }) {
  const text = shortText(value);
  return (
    <td className={`max-w-[160px] truncate px-1.5 py-0.5 ${typeof value === "number" ? "text-right tabular-nums" : ""}`} title={text}>
      {text}
    </td>
  );
}

function More({ count }: { count: number }) {
  return count > 0 ? <div className="mt-0.5 text-[10px] text-slate-400">…ほか {count} 件</div> : null;
}

export function ValueView({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    const cols = [...new Set(value.flatMap((r) => Object.keys(r)))].slice(0, MAX_COLS);
    return (
      <div>
        <div className="mb-0.5 text-[10px] text-slate-400">{value.length}件</div>
        <table className="border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[10px] text-slate-500">
              <th className="px-1.5 py-0.5 font-medium">#</th>
              {cols.map((c) => (
                <th key={c} className="px-1.5 py-0.5 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.slice(0, MAX_ROWS).map((r, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="px-1.5 py-0.5 text-slate-400">{i + 1}</td>
                {cols.map((c) => (
                  <Cell key={c} value={r[c]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <More count={value.length - MAX_ROWS} />
      </div>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="text-slate-400">（0件）</div>;
    return (
      <div>
        <div className="mb-0.5 text-[10px] text-slate-400">{value.length}件</div>
        <ol className="space-y-0.5">
          {value.slice(0, MAX_ROWS).map((x, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-4 shrink-0 text-right text-slate-400">{i + 1}</span>
              <span className="truncate">{shortText(x)}</span>
            </li>
          ))}
        </ol>
        <More count={value.length - MAX_ROWS} />
      </div>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      <div>
        <table className="border-collapse text-[11px]">
          <tbody>
            {entries.slice(0, MAX_ROWS).map(([k, x]) => (
              <tr key={k} className="border-b border-slate-100 last:border-0">
                <th className="py-0.5 pr-3 text-left font-normal text-slate-500">{k}</th>
                <Cell value={x} />
              </tr>
            ))}
          </tbody>
        </table>
        <More count={entries.length - MAX_ROWS} />
      </div>
    );
  }
  return <div className={`text-[13px] font-semibold ${typeof value === "number" ? "tabular-nums" : ""}`}>{shortText(value)}</div>;
}

/** A reported change as it should read: masked, cut short, or laid out. */
export function ChangeView({ change }: { change: VariableChange }) {
  if (change.secret) return <div className="text-[13px] font-semibold">***</div>;
  if (change.truncated) return <div className="break-all">{String(change.value)}…</div>;
  return <ValueView value={change.value} />;
}

export const changeText = (c: VariableChange) => (c.secret ? "***" : c.truncated ? String(c.value) : shortText(c.value));
