// What a node shows inside: its settings as rows, the variables it reads
// and writes as chips, and the values they had in the last runs.
import { READING } from "../../lib/reading";
import { rowHeight, VALUE_LINE_H } from "../../lib/nodeRows";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "../../context";
import { t } from "../../lib/i18n";
import { useProjectMaybe } from "../../project";
import type { Flow } from "@spellsheet/schema";
import { inHandle, outHandle } from "../../lib/dataFlow";
import { focus, useFocus, varFocus } from "../../lib/focus";
import { rootOf, splitRefs, ROW_H, type Row, TYPE_COLOR } from "../../lib/nodeRows";
import { secretName } from "../../lib/sentence";
import { HALF, HoverPreview } from "../HoverPreview";
import { openImageValue } from "../ImageViewer";
import { previewSource } from "../../lib/preview";
import type { StepStart, VariableChange } from "../../store";
import { ChangeView, changeText } from "../ValueView";
import { menuFor } from "../../lib/contextMenu";
import { useVariableMenu } from "../menus";
import { valuesSeenBy } from "../../lib/runValues";
import { Socket } from "./handles";

export type RunValues = { changes: VariableChange[]; starts: StepStart[] };

export const NO_RUN: RunValues = { changes: [], starts: [] };

/** The values a chip's popover lists: the last few, newest last. */
export const MAX_RUNS = 5;

/**
 * What this step saw (or wrote) for one variable, once per time it ran:
 * a single value for a plain step, one line per pass inside a loop.
 */
export function ValuePopover({ name, color, values, side, anchor, what }: { name: string; color: string; values: VariableChange[]; side: "in" | "out"; anchor: DOMRect; what?: string }) {
  const below = anchor.top < window.innerHeight / 2;
  const many = values.length > 1;
  // Kept inside the window: a picture makes the popover wide.
  const left = Math.min(Math.max(anchor.left + anchor.width / 2, HALF + 8), Math.max(HALF + 8, window.innerWidth - HALF - 8));
  return createPortal(
    <div
      // Above the chip, or below it when there is no room up top.
      style={{ left, top: below ? anchor.bottom + 6 : anchor.top - 6 }}
      className={`pointer-events-none fixed z-50 max-w-[min(600px,calc(100vw-16px))] -translate-x-1/2 ${below ? "" : "-translate-y-full"} rounded-lg border border-slate-200 bg-sheet px-2.5 py-1.5 text-[11px] shadow-lifted`}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="font-mono font-semibold">{name}</span>
        <span className="text-slate-400">
          {what ?? (side === "in" ? t.flow.valuesIn : t.flow.valuesOut)}
          {many && t.flow.runs(values.length)}
        </span>
      </div>
      {values.length === 0 ? (
        <div className="mt-0.5 text-slate-400">{t.flow.valuesEmpty}</div>
      ) : (
        <ol className="mt-1.5 space-y-1">
          {values.slice(0, MAX_RUNS).map((w, i) => (
            <li key={`${w.seq}-${i}`} className="flex items-start gap-2">
              {many && <span className="w-9 shrink-0 pt-1 text-[10px] text-slate-400">{t.flow.nth(i + 1)}</span>}
              <div className="min-w-0 flex-1 rounded-md border border-slate-100 bg-paper px-2 py-1">
                <ChangeView change={w} />
              </div>
            </li>
          ))}
          {values.length > MAX_RUNS && <li className="text-[10px] text-slate-400">{t.flow.moreRuns(values.length - MAX_RUNS)}</li>}
        </ol>
      )}
    </div>,
    document.body,
  );
}

/**
 * A variable as a small token inside a value ("今の行.金額"), the way Linear
 * shows a mention: a dot in the variable's type colour and its name. Hovering
 * lights every token of the same variable, draws where its value comes from,
 * and lists the values it had in the last run.
 */
/** `what`: what its values are, when they are not a node's (the flow's start and end). */
export function VarChip({ name, label, color, values, side, owner, what }: { name: string; label?: string; color: string; values: VariableChange[]; side: "in" | "out"; owner: string; what?: string }) {
  const focused = useFocus() === varFocus(name);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const variableMenu = useVariableMenu();
  const flowId = useStudio((s) => s.flow?.id);
  const last = values.at(-1);
  return (
    <span
      // The popover does not take the pointer; pressing the chip opens its picture large.
      onClick={(e) => {
        if (!last || last.secret || last.truncated) return;
        if (openImageValue(last.value, flowId)) {
          e.stopPropagation();
          setAnchor(null);
        }
      }}
      onContextMenu={menuFor(() => {
        setAnchor(null);
        return variableMenu(name);
      })}
      className={`nodrag inline-flex h-[20px] max-w-[150px] shrink-0 items-center gap-1.5 rounded-md border bg-sheet px-1.5 text-[11.5px] leading-none text-ink ${
        focused ? "" : "border-slate-200"
      }`}
      style={focused ? { borderColor: color, background: `color-mix(in srgb, ${color} 10%, var(--color-sheet))` } : undefined}
      onMouseEnter={(e) => {
        focus.set(varFocus(name));
        setAnchor(e.currentTarget.getBoundingClientRect());
      }}
      onMouseLeave={() => {
        // Back to the step the chip belongs to; leaving the step clears it.
        focus.set(owner);
        setAnchor(null);
      }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{side === "out" && last ? changeText(last) : (label ?? name)}</span>
      {anchor && <ValuePopover name={name} color={color} values={values} side={side} anchor={anchor} what={what} />}
    </span>
  );
}

/** A value's text with each `{{ variable… }}` hole as a token. */
export function ValueText({ value, refs, color, run, stepId }: { value: string; refs: string[]; color: (name: string) => string; run: RunValues; stepId: string }) {
  const parts = value.split(/\{\{\s*(.*?)\s*\}\}/g);
  const holes = parts.filter((_, i) => i % 2 === 1).length;
  // An expression param (a condition, a list) names its variables without
  // holes: each variable in it, with its fields ("response.rows"), is a token.
  if (holes === 0 && refs.length > 0) {
    const pieces = splitRefs(value, refs);
    return (
      <>
        {pieces.map((piece, i) => {
          if (i % 2 === 0) return piece ? <span key={i} className="truncate">{piece}</span> : null;
          const root = rootOf(piece, refs) ?? piece;
          return <VarChip key={i} side="in" owner={stepId} name={root} label={piece} color={color(root)} values={valuesSeenBy(run.changes, run.starts, root, stepId)} />;
        })}
      </>
    );
  }
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part ? <span key={i} className="truncate">{part}</span> : null;
        const root = refs.find((r) => part === r || part.startsWith(`${r}.`) || part.startsWith(`${r}[`));
        if (!root) return <span key={i} className="truncate">{`{{ ${part} }}`}</span>;
        return <VarChip key={i} side="in" owner={stepId} name={root} label={part} color={color(root)} values={valuesSeenBy(run.changes, run.starts, root, stepId)} />;
      })}
    </>
  );
}

export function NodeRow({ row, vars, run, stepId, sheet }: { row: Row; vars: Map<string, string | undefined>; run: RunValues; stepId: string; sheet?: string }) {
  const focused = useFocus();
  const parts = useStudio((s) => s.flow?.parts);
  const typeColor = (name: string): string => TYPE_COLOR[vars.get(name) ?? "any"] ?? "var(--cat-other)";
  if (row.kind === "more") {
    return <div style={{ height: ROW_H }} className="flex items-center px-3 text-[11px] text-slate-400">{t.flow.moreRows(row.count)}</div>;
  }
  if (row.kind === "output") {
    const color = typeColor(row.variable);
    const lit = focused === varFocus(row.variable);
    return (
      <div style={{ height: ROW_H }} className="relative flex items-center justify-end gap-2 px-3 text-[12px]">
        <span className="text-slate-500">{row.label}</span>
        <VarChip
          side="out"
          owner={stepId}
          name={row.variable}
          color={color}
          values={run.changes.filter((c) => c.variable === row.variable && c.stepId === stepId)}
        />
        <Socket side="out" id={outHandle(row.variable)} color={color} title={t.flow.writes(row.variable)} lit={lit} />
      </div>
    );
  }
  if (READING && !row.unset) {
    // To read: the whole value, on as many lines as it takes.
    const text = row.file ? row.file.path : (row.full ?? row.value);
    return (
      <div style={{ height: rowHeight(row), paddingBlock: (ROW_H - VALUE_LINE_H) / 2 }} className="flex gap-2 px-3 text-[12.5px]">
        <span style={{ lineHeight: `${VALUE_LINE_H}px` }} className="w-[72px] shrink-0 truncate text-[12px] text-slate-500">
          {row.label}
        </span>
        <span style={{ lineHeight: `${VALUE_LINE_H}px` }} className="flow-read-value min-w-0 flex-1 overflow-hidden [overflow-wrap:anywhere] text-ink">
          {row.file && <span className="mr-1.5 inline-block h-2 w-2 rounded-[2px]" style={{ background: ROLE_VAR[row.file.role] ?? "var(--color-slate-400)" }} />}
          {secretName(row.raw) && <KeyRound size={12} className="mr-1 inline-block align-[-1px] text-slate-500" aria-label={t.flow.secretMark} />}
          <ValueText value={text} refs={row.refs} color={typeColor} run={run} stepId={stepId} />
        </span>
      </div>
    );
  }
  const first = typeColor(row.refs[0] ?? "");
  const lit = row.refs.some((r) => focused === varFocus(r));
  return (
    <div style={{ height: ROW_H }} className="relative flex items-center gap-2 px-3 text-[12.5px]">
      {row.refs.length > 0 && <Socket side="in" id={inHandle(row.key)} color={first} title={t.flow.reads(row.refs.join(", "))} lit={lit} />}
      <span className="w-[72px] shrink-0 truncate text-[12px] text-slate-500" title={row.key}>
        {row.label}
      </span>
      {row.unset ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-amber-700">
          <span className="h-[10px] w-[10px] shrink-0 rounded-full border-[1.5px] border-dashed border-amber-600" />
          {t.flow.unsetValue}
        </span>
      ) : row.file ? (
        <FileValue file={row.file} sheet={sheet} />
      ) : (
        <ParamValue row={row} parts={parts}>
          {secretName(row.raw) && <KeyRound size={12} className="shrink-0 text-slate-500" aria-label={t.flow.secretMark} />}
          <ValueText value={row.value} refs={row.refs} color={typeColor} run={run} stepId={stepId} />
        </ParamValue>
      )}
    </div>
  );
}

/**
 * A setting's value on the node. Resting the pointer on it shows what it
 * names (a picture by its path, the picture of a part) or the whole text
 * when it is cut short; otherwise the tooltip has the text.
 */
export function ParamValue({ row, parts, children }: { row: Extract<Row, { kind: "param" }>; parts: Flow["parts"]; children: React.ReactNode }) {
  const className = "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-ink";
  // A node pointing at a named part shows the part's picture.
  const raw = row.raw && typeof row.raw === "object" && typeof (row.raw as { part?: unknown }).part === "string" ? (parts?.[(row.raw as { part: string }).part]?.target ?? row.raw) : row.raw;
  const source = previewSource(raw) ?? (row.full ? { kind: "text" as const, text: row.full } : null);
  if (!source) {
    return (
      <span className={className} title={row.value}>
        {children}
      </span>
    );
  }
  return (
    <HoverPreview source={source} className={className}>
      {children}
    </HoverPreview>
  );
}

export const ROLE_VAR: Record<string, string> = {
  input: "var(--color-role-input)",
  config: "var(--color-role-config)",
  templates: "var(--color-role-templates)",
  output: "var(--color-role-output)",
};

/**
 * A path param naming a file of the flow's folder: tinted in its shelf's
 * colour, marked when Excel has it open (a write would fail), and opened in
 * its sheet or app on double-click.
 */
export function FileValue({ file, sheet }: { file: NonNullable<Extract<Row, { kind: "param" }>["file"]>; sheet?: string }) {
  const color = ROLE_VAR[file.role] ?? "var(--color-slate-400)";
  const entry = useProjectMaybe((s) => s.files?.files.find((f) => f.path.toLowerCase() === file.path.toLowerCase()) ?? null, null);
  const known = useProjectMaybe((s) => s.files !== null, false);
  const openFile = useProjectMaybe((s) => s.openFile, null);
  const missing = known && !entry && file.role !== "output" && file.role !== "work" && !file.path.includes("{{");
  const source = previewSource(file.path, { sheet });
  return (
    <HoverPreview
      source={source}
      className="flex h-[20px] min-w-0 flex-1 items-center gap-1.5 leading-[20px] text-ink"
      title={source ? (entry?.inUse ? t.project.inUse : undefined) : entry?.inUse ? `${file.path} · ${t.project.inUse}` : file.path}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (entry && openFile) void openFile(file.path);
      }}
    >
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color }} />
      <span className={`min-w-0 flex-1 truncate text-[12px] ${missing ? "text-shu-500 line-through decoration-1" : ""}`}>{file.path}</span>
      {entry?.inUse && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-shu-500" />}
    </HoverPreview>
  );
}
