import type { Part, Step, StepPatch, StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../context";
import { Boxes, Crosshair, FolderOpen, ScanSearch } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectMaybe } from "../project";
import { api, type SecretField } from "../lib/api";
import { locale, stepLabel, t } from "../lib/i18n";
import { type DataLink, dataLinks, INPUT_NODE, OUTPUT_NODE } from "../lib/dataFlow";
import { stepSummary } from "../lib/palette";
import { issueText } from "../lib/issueText";
import { CALL, callMap, choiceLabel, knownVariables, outputs, paramLabel, plainHint, referencedVariables, TYPE_COLOR } from "../lib/nodeRows";
import { outline } from "../lib/outline";
import { appOf, detachOps, makePartOps, newPartName, partRef, partUses } from "../lib/parts";
import { runScope } from "../lib/runScope";
import { describeWhen } from "../lib/schedule";
import { sentence, targetText, typeTitle } from "../lib/sentence";
import { findStep, isActive, revertBlocker, touchedSteps } from "../store";
import { CATEGORY_COLOR } from "./CommandPalette";
import { Sentence } from "./StoryView";
import { openNewSchedule, useSchedulesOf } from "./RunsPage";
import { ActorMark, usePendingReview } from "./Timeline";
import { ExpressionField } from "./ExpressionField";
import { VariableSetForm } from "./TransformForm";
import { VarIcon } from "./VarIcon";
import { VariablesPanel } from "./VariablesPanel";
import { listToText, textToList } from "../lib/listText";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | { type?: string | string[] };
};

const inputClass =
  "w-full rounded-[4px] border border-slate-200 bg-slate-50 px-2 py-1 text-xs focus:border-brand-500 focus:bg-sheet focus:outline-none";

/** Text field that commits on blur / Enter, so each edit is one undoable change. */
function CommitInput(props: {
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
function PathField({ value, folder, onChange }: { value: string; folder: boolean; onChange: (value: unknown) => void }) {
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
function Row({
  label,
  hint,
  title,
  socket,
  children,
}: {
  label: string;
  hint?: string;
  title?: string;
  socket?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid grid-cols-[84px_1fr] items-start gap-x-2 py-1">
      <span className="relative flex min-h-[26px] items-center justify-end text-right text-[11px] leading-tight text-slate-500" title={title}>
        {socket && <span className="mr-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-white" style={{ background: socket }} />}
        {label}
      </span>
      <span className="min-w-0">
        {children}
        {hint && <span className="mt-0.5 block text-[10px] leading-snug text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

/** A collapsible group of rows, like a Blender properties panel. */
function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
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

type SecretRef = { secret: string; field: SecretField };

/** The `field` enum of the secret reference in a text-or-secret param schema. */
function secretFieldsOf(schema: JsonSchema): string[] | undefined {
  return schema.oneOf?.find((v) => v.properties?.field?.enum)?.properties?.field?.enum?.map(String);
}

const isSecretRef = (v: unknown): v is SecretRef =>
  typeof v === "object" && v !== null && "secret" in v && "field" in v;

/**
 * Text, or a registered secret picked by name. The value itself is never
 * shown or stored in the flow: only `{ secret, field }`.
 */
function TextOrSecretField({
  label,
  schema,
  value,
  onChange,
}: {
  label: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const secrets = useStudio((s) => s.secrets);
  const openSecrets = useStudio((s) => s.setSecretsOpen);
  const ref = isSecretRef(value) ? value : null;
  const [mode, setMode] = useState<"text" | "secret">(ref ? "secret" : "text");
  useEffect(() => setMode(ref ? "secret" : "text"), [ref]);
  // The param's schema lists the fields it takes (http.request auth also takes the OAuth access token).
  const fields = (secretFieldsOf(schema) ?? ["username", "password", "totp"]) as SecretField[];

  // A <div>, not Field's <label>: a label would forward clicks to its first button.
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <div className="flex gap-1 text-xs">
        {(["text", "secret"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-[3px] px-2 py-0.5 ${mode === m ? "bg-ink text-paper" : "text-slate-500 hover:bg-slate-100"}`}
          >
            {m === "text" ? t.secretText : `🔑 ${t.secretUse}`}
          </button>
        ))}
      </div>
      {mode === "text" ? (
        <CommitInput value={typeof value === "string" ? value : ""} onCommit={(text) => onChange(text === "" ? null : text)} />
      ) : (
        <div className="flex items-center gap-1">
          <select
            className={inputClass}
            aria-label={t.secretUse}
            value={ref?.secret ?? ""}
            onChange={(e) =>
              e.target.value && onChange({ secret: e.target.value, field: ref?.field ?? "password" })
            }
          >
            <option value="">{t.secretChoose}</option>
            {secrets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
            {ref && !secrets.some((s) => s.name === ref.secret) && <option value={ref.secret}>{t.props.unregistered(ref.secret)}</option>}
          </select>
          <select
            className={`${inputClass} w-36`}
            aria-label={t.secretFieldLabel}
            value={ref?.field ?? "password"}
            disabled={!ref}
            onChange={(e) => ref && onChange({ secret: ref.secret, field: e.target.value as SecretField })}
          >
            {fields.map((f) => (
              <option key={f} value={f}>
                {t.secretField[f]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="whitespace-nowrap text-xs text-brand-600 hover:underline"
            onClick={() => openSecrets(true)}
          >
            ＋{t.secretRegister}
          </button>
        </div>
      )}
    </div>
  );
}

/** An array of strings, numbers and booleans, held as such (not yet something else). */
function isScalarList(schema: JsonSchema, value: unknown): boolean {
  const items = schema.items?.type;
  const types = Array.isArray(items) ? items : items ? [items] : [];
  const scalar = types.length > 0 && types.every((ty) => ["string", "number", "integer", "boolean", "null"].includes(ty));
  return scalar && (value === undefined || value === null || (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")));
}

function ParamField({
  name,
  stepType,
  schema,
  value,
  required,
  socket,
  secretCapable,
  pointer,
  isPath,
  onChange,
}: {
  name: string;
  stepType: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  socket?: string;
  secretCapable: boolean;
  /** The adapter that can pick this target on screen and highlight it. */
  pointer?: string;
  /** A file or folder of the flow's folder (`input/orders.xlsx`). */
  isPath?: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = `${paramLabel(name, stepType)}${required ? " *" : ""}`;
  if (secretCapable) {
    return <TextOrSecretField label={label} schema={schema} value={value} onChange={onChange} />;
  }
  let hint = plainHint(schema.description);
  let editor: React.ReactNode;
  // A choice that can also be written out in full (a dialog's answer): the
  // choice, unless the value is already the long form.
  const choices = schema.oneOf?.find((branch) => branch.enum)?.enum;
  if (choices && !isRecord(value)) {
    editor = (
      <select className={inputClass} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{t.props.unset}</option>
        {choices.map((v) => (
          <option key={String(v)} value={String(v)}>
            {choiceLabel(name, v)}
          </option>
        ))}
      </select>
    );
  } else if (schema.enum) {
    editor = (
      <select className={inputClass} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{t.props.unset}</option>
        {schema.enum.map((v) => (
          <option key={String(v)} value={String(v)}>
            {choiceLabel(name, v)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "boolean") {
    editor = <input type="checkbox" className="mt-1.5" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  } else if (schema.type === "integer" || schema.type === "number" || (schema.oneOf && !choices)) {
    // number | expression string (oneOf), or plain number
    hint ??= t.props.numberHint;
    editor = (
      <CommitInput
        value={value === undefined ? "" : String(value)}
        onCommit={(text) => {
          const trimmed = text.trim();
          if (trimmed === "") return onChange(null);
          const n = Number(trimmed);
          onChange(Number.isFinite(n) ? n : trimmed);
        }}
      />
    );
  } else if (schema.type === "string" && isPath) {
    editor = <PathField value={String(value ?? "")} folder={name === "folder"} onChange={onChange} />;
  } else if (schema.type === "string") {
    editor = <CommitInput value={String(value ?? "")} onCommit={(text) => onChange(text === "" ? null : text)} />;
  } else if (schema.type === "array" && isScalarList(schema, value)) {
    // A few plain values (a case's values): one line, comma-separated.
    hint = t.props.listHint;
    editor = (
      <CommitInput
        value={listToText(value)}
        onCommit={(text) => {
          const list = textToList(text);
          onChange(list.length === 0 ? null : list);
        }}
      />
    );
  } else if (isForm(schema, value)) {
    // A target and other small records: one field per item, never JSON by hand.
    return (
      <div className="py-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 pl-1 text-[11px] text-slate-500" title={schema.description ?? name}>
          {socket && <span className="h-2 w-2 shrink-0 rounded-full ring-2 ring-white" style={{ background: socket }} />}
          {label}
          {pointer && <PointTools adapter={pointer} schema={schema} value={value} onChange={onChange} />}
        </div>
        <ObjectFields schema={schema} value={value as Record<string, unknown> | undefined} onChange={onChange} />
      </div>
    );
  } else {
    // Anything else (objects, arrays, untyped values): edit as JSON.
    hint = t.props.jsonHint;
    editor = (
      <CommitInput
        mono
        value={value === undefined ? "" : JSON.stringify(value)}
        onCommit={(text) => {
          try {
            onChange(text.trim() === "" ? null : JSON.parse(text));
          } catch {
            onChange(text);
          }
        }}
      />
    );
  }
  return (
    <Row label={label} title={schema.description ? `${schema.description}（${name}）` : name} socket={socket} hint={hint}>
      {editor}
    </Row>
  );
}

/** Items set rarely: shown under "詳しく指定" unless they hold a value. */
const RARE = new Set(["testId", "css", "exact", "nth", "className", "placeholder", "frame"]);
/** ARIA roles offered for a browser target, whose role is free text. */
const BROWSER_ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "listitem", "menuitem", "tab", "heading", "cell", "row", "image"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An object param with declared items, holding nothing or a plain object (not an expression). */
/**
 * The target of a browser or desktop node: its own fields, or a named part
 * of the flow (`{ part: "<name>" }`), with "部品にする" to share it.
 */
function TargetField({
  step,
  schema,
  value,
  required,
  onChange,
}: {
  step: Step;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
}) {
  const flow = useStudio((s) => s.flow);
  const applyOps = useStudio((s) => s.applyOps);
  const select = useStudio((s) => s.select);
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const app = appOf(step.type)!;
  const all = flow?.parts ?? {};
  const choices = Object.entries(all).filter(([, p]) => p.app === app);
  const ref = partRef(value);
  const part = ref ? all[ref] : undefined;
  const pointer = pointerOf(step.type);
  const title = `${paramLabel("target")}${required ? " *" : ""}`;

  const choose = (name: string) => {
    setNote(null);
    if (name === "") {
      if (part) void applyOps(detachOps(step, part));
      return;
    }
    onChange({ part: name });
  };
  const make = async () => {
    const name = newPartName(value, Object.keys(all));
    const made = makePartOps(flow?.steps ?? [], step, name, label || name);
    if (!made) return;
    if (await applyOps(made.ops)) {
      setNote(t.parts.made(made.others));
      setMaking(false);
      setLabel("");
    }
  };

  return (
    <div className="py-1">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 pl-1 text-[11px] text-slate-500" title={schema.description ?? "target"}>
        {title}
        {!ref && pointer && (
          <PointTools
            adapter={pointer}
            schema={schema}
            value={value}
            context={typeof step.params?.context === "string" ? step.params.context : undefined}
            onChange={onChange}
          />
        )}
      </div>
      {(choices.length > 0 || ref) && (
        <div className="mb-1 flex items-center gap-1.5">
          <Boxes size={13} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
          <select className={inputClass} value={ref ?? ""} onChange={(e) => choose(e.target.value)} aria-label={t.parts.usePart}>
            <option value="">{ref ? t.parts.direct : t.parts.choose}</option>
            {choices.map(([name, p]) => (
              <option key={name} value={name}>
                {p.label ? `${p.label}（${name}）` : name}
              </option>
            ))}
            {ref && !part && <option value={ref}>{t.parts.missing(ref)}</option>}
          </select>
        </div>
      )}
      {ref ? (
        part ? (
          <div className={`rounded-[4px] border px-2.5 py-2 text-[12px] ${part.target ? "border-slate-200 bg-paper" : "border-amber-300 bg-amber-50"}`}>
            <div className="flex items-center gap-2">
              <span className={`min-w-0 flex-1 truncate ${part.target ? "" : "text-amber-700"}`}>
                {part.target ? targetText(part.target) : t.todos.notPickedNode(part.label || ref)}
              </span>
              <button type="button" className="shrink-0 text-[11px] text-brand-600 hover:underline" onClick={() => select({ kind: "part", name: ref })}>
                {t.parts.open}
              </button>
            </div>
            <p className="pt-1 text-[11px] text-slate-500">{t.parts.shared(partUses(flow?.steps ?? [], ref).length)}</p>
          </div>
        ) : (
          <p className="px-1 text-[11px] text-shu-600">{t.parts.missing(ref)}</p>
        )
      ) : (
        <>
          <ObjectFields schema={schema} value={value as Record<string, unknown> | undefined} onChange={onChange} />
          {isRecord(value) &&
            (making ? (
              <div className="mt-1 flex items-center gap-1">
                <input
                  autoFocus
                  className={inputClass}
                  placeholder={t.parts.makeLabel}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void make();
                    if (e.key === "Escape") setMaking(false);
                  }}
                />
                <button type="button" className="shrink-0 rounded-[3px] bg-ink px-2.5 py-1 text-[11px] text-paper" onClick={() => void make()}>
                  {t.parts.create}
                </button>
              </div>
            ) : (
              <button
                type="button"
                title={t.parts.makeHint}
                className="mt-1 inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50"
                onClick={() => setMaking(true)}
              >
                <Boxes size={13} strokeWidth={1.75} />
                {t.parts.make}
              </button>
            ))}
        </>
      )}
      {note && (
        <p role="status" className="px-1 pt-1 text-[11px] text-slate-600">
          {note}
        </p>
      )}
    </div>
  );
}

/** A named part: its name, its target (pick it again, highlight it) and the nodes that use it. */
function PartInspector({ name }: { name: string }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const applyOps = useStudio((s) => s.applyOps);
  const goTo = useStudio((s) => s.goTo);
  const select = useStudio((s) => s.select);
  const part = flow?.parts?.[name];
  if (!flow || !part) return <p className="p-4 text-sm text-slate-400">{t.parts.missing(name)}</p>;
  // The widest target of the app: the one nodes that may point at a place take.
  const def = stepTypes.find((d) => d.type === (part.app === "desktop" ? "desktop.mouseClick" : "browser.click"));
  const wide = ((def?.paramsSchema as JsonSchema | undefined)?.properties?.target ?? {}) as JsonSchema;
  // The usual fields, and the others only when the part has them (a place, a picture…).
  const has = new Set(["window", "element", "role", "name", "label", "text", "placeholder", ...Object.keys(part.target ?? {})]);
  const schema: JsonSchema = {
    ...wide,
    properties: Object.fromEntries(Object.entries(wide.properties ?? {}).filter(([k]) => part.app === "browser" || has.has(k))),
  };
  const uses = partUses(flow.steps ?? [], name);
  // The node numbers people see in the status bar ("ノード 3 / 5").
  const order = outline(flow.steps ?? [], new Map(stepTypes.map((d) => [d.type, d] as const))).map((i) => i.id);
  const set = (patch: Partial<Part>) => void applyOps([{ op: "setPart", name, part: { ...part, ...patch } }]);
  const color = CATEGORY_COLOR[part.app === "desktop" ? "windows" : "browser"] ?? CATEGORY_COLOR.other;
  const pointer = POINTERS.has(part.app) ? part.app : undefined;

  return (
    <div className="pb-6">
      <div className="px-4 pt-4 pb-3">
        <div className="overflow-hidden rounded-[4px] border border-slate-200">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
            <Boxes size={14} strokeWidth={1.75} style={{ color }} aria-hidden="true" />
            <span className="text-sm font-bold" style={{ color }}>
              {t.parts.title}
            </span>
            <span className="ml-auto font-mono text-[10px] text-slate-400">{name}</span>
          </div>
          <div className="space-y-1 px-3 py-2">
            <div className="text-[13px] leading-snug">{part.label || name}</div>
            <p className="text-[11px] text-slate-500">{targetText(part.target)}</p>
          </div>
        </div>
      </div>
      <Section title={t.props.basics}>
        <div className="space-y-1.5">
          <label className="grid grid-cols-[76px_1fr] items-center gap-x-2">
            <span className="text-right text-[11px] text-slate-500">{t.parts.label}</span>
            <CommitInput value={part.label ?? ""} onCommit={(text) => set({ label: text.trim() || undefined })} />
          </label>
          <div className="grid grid-cols-[76px_1fr] items-center gap-x-2" title={t.parts.keyHint}>
            <span className="text-right text-[11px] text-slate-500">{t.parts.key}</span>
            <span className="font-mono text-[12px] text-slate-600">{name}</span>
          </div>
          <div className="grid grid-cols-[76px_1fr] items-center gap-x-2">
            <span className="text-right text-[11px] text-slate-500">{t.parts.kind}</span>
            <span className="text-[12px] text-slate-600">{t.parts.app[part.app] ?? part.app}</span>
          </div>
        </div>
      </Section>
      <Section title={t.parts.target}>
        {!part.target && (
          <p role="status" className="mb-1.5 rounded-[4px] border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700">
            {t.todos.notPicked}
          </p>
        )}
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          {uses.length > 1 && <span>{t.parts.shared(uses.length)}</span>}
          {pointer && (
            <PointTools
              adapter={pointer}
              schema={schema}
              value={part.target}
              context={partContext(uses)}
              onChange={(target) => target && set({ target: target as Part["target"] })}
            />
          )}
        </div>
        <ObjectFields schema={schema} value={(part.target ?? undefined) as Record<string, unknown> | undefined} onChange={(target) => target && set({ target: target as Part["target"] })} />
      </Section>
      <Section title={t.parts.usedBy}>
        {uses.length === 0 ? (
          <p className="text-[12px] text-slate-500">{t.parts.unused}</p>
        ) : (
          <ul className="space-y-0.5">
            {uses.map((s) => (
              <li key={s.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-[3px] px-1.5 py-1 text-left text-[12px] hover:bg-slate-100" onClick={() => s.id && goTo(s.id)}>
                  <span className="w-7 shrink-0 text-right font-mono text-[11px] text-slate-400">{order.indexOf(s.id ?? "") + 1}</span>
                  <span className="truncate">{s.name || stepLabel(s.type, stepTypes.find((d) => d.type === s.type)?.label)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          disabled={uses.length > 0}
          title={uses.length > 0 ? t.parts.removeBlocked(uses.length) : undefined}
          className="mt-2 rounded-[3px] px-1.5 py-0.5 text-[11px] text-shu-600 hover:bg-shu-50 disabled:text-slate-400 disabled:hover:bg-transparent"
          onClick={() => {
            void applyOps([{ op: "removePart", name }]).then((ok) => ok && select(null));
          }}
        >
          {t.parts.remove}
        </button>
      </Section>
    </div>
  );
}

/** The browser context the nodes using a part run in (the first one that names one). */
const partContext = (uses: readonly Step[]) =>
  uses.map((u) => u.params?.context).find((c): c is string => typeof c === "string" && c !== "");

/** The adapters whose targets can be picked on screen from Studio. */
const POINTERS = new Set(["desktop", "browser"]);
const pointerOf = (type: string) => {
  const adapter = type.split(".")[0] ?? "";
  return POINTERS.has(adapter) ? adapter : undefined;
};

/**
 * "画面から選ぶ" and "光らせる" beside a target: the adapter builds the
 * target from what the user clicks, and frames the current one on screen.
 */
function PointTools({
  adapter,
  schema,
  value,
  context,
  onChange,
}: {
  adapter: string;
  schema: JsonSchema;
  value: unknown;
  /** The browser context the node uses (`context` param). */
  context?: string;
  onChange: (value: unknown) => void;
}) {
  const run = useStudio((s) => s.run);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const canPoint = Boolean(schema.properties?.point);
  // A browser part is picked in the browser a run opened: there is none
  // until the flow runs (or is paused at a node).
  const browser = adapter === "browser";
  const session = browser && run && isActive(run) ? run.runId : undefined;
  const unavailable = browser && !session;
  const extra = browser && context ? { context } : {};
  const pick = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.pointAt(adapter, { action: "pick", message: t.picker.banner, ...extra }, session);
      if (result.cancelled || result.status === "cancelled") {
        setNote({ text: t.picker.cancelled });
      } else if (result.how === "point" && !canPoint) {
        setNote({ text: t.picker.pointNotAllowed, warn: true });
      } else {
        onChange(result.target);
        const label = String(result.label ?? result.text ?? "");
        setNote(result.how === "point" ? { text: t.picker.byPoint, warn: true } : { text: label ? t.picker.picked(label) : t.picker.pickedPlain });
      }
    } catch (e) {
      setNote({ text: t.picker.failed(e instanceof Error ? e.message : String(e)), warn: true });
    } finally {
      setBusy(false);
    }
  };
  const highlight = async () => {
    setNote(null);
    try {
      const result = await api.pointAt(adapter, { action: "highlight", target: value, ...extra }, session);
      const found = browser ? Number(result.shown ?? 0) > 0 : Boolean(result.found);
      setNote(!found ? { text: t.picker.notFound, warn: true } : result.visible === false ? { text: t.picker.hidden, warn: true } : { text: t.picker.found });
    } catch (e) {
      setNote({ text: t.picker.failed(e instanceof Error ? e.message : String(e)), warn: true });
    }
  };
  const button = "inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50 disabled:opacity-50";
  return (
    <>
      <span className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          className={button}
          title={unavailable ? t.picker.needsRun : browser ? t.picker.pickBrowserTitle : t.picker.pickTitle}
          disabled={busy || unavailable}
          onClick={() => void pick()}
        >
          <Crosshair size={13} strokeWidth={1.75} />
          {t.picker.pick}
        </button>
        <button
          type="button"
          className={button}
          title={unavailable ? t.picker.needsRun : t.picker.highlightTitle}
          disabled={busy || unavailable || !isRecord(value)}
          onClick={() => void highlight()}
        >
          <ScanSearch size={13} strokeWidth={1.75} />
          {t.picker.highlight}
        </button>
      </span>
      {note && (
        <span role="status" className={`basis-full pt-0.5 text-[11px] ${note.warn ? "text-shu-600" : "text-slate-600"}`}>
          {note.text}
        </span>
      )}
    </>
  );
}

function isForm(schema: JsonSchema, value: unknown): boolean {
  return schema.type === "object" && Object.keys(schema.properties ?? {}).length > 0 && (value === undefined || value === null || isRecord(value));
}

const fieldLabel = (key: string) => t.targetFields[key] ?? key;
const roleLabel = (role: string) => (!t.roles[role] ? role : locale === "ja" ? `${t.roles[role]}（${role}）` : `${t.roles[role]} (${role})`);

/**
 * An object param as fields: what to click as kind + name, a window as app +
 * title. Nested records (window, element) get their own box; rarely used
 * items fold away. Empty items are dropped, an empty record becomes unset.
 */
function ObjectFields({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: Record<string, unknown> | undefined;
  onChange: (value: unknown) => void;
}) {
  const props = schema.properties ?? {};
  const current = value ?? {};
  const keys = Object.keys(props);
  const rare = keys.filter((k) => RARE.has(k));
  const [more, setMore] = useState(() => rare.some((k) => current[k] !== undefined));
  const set = (key: string, v: unknown) => {
    const next = { ...current };
    if (v === null || v === undefined || v === "" || v === false || (isRecord(v) && Object.keys(v).length === 0)) delete next[key];
    else next[key] = v;
    onChange(Object.keys(next).length === 0 ? null : next);
  };
  const shown = keys.filter((k) => more || !RARE.has(k));
  return (
    <div className="space-y-1 rounded-[4px] border border-slate-200 bg-paper px-2 py-1.5">
      {shown.map((key) => {
        const sub = props[key]!;
        const v = current[key];
        if (isForm(sub, v)) {
          return (
            <div key={key} className="pt-0.5">
              <div className="mb-1 text-[11px] font-semibold text-slate-600" title={sub.description}>
                {fieldLabel(key)}
              </div>
              <ObjectFields schema={sub} value={v as Record<string, unknown> | undefined} onChange={(next) => set(key, next)} />
            </div>
          );
        }
        let editor: React.ReactNode;
        if (sub.enum) {
          editor = (
            <select className={inputClass} value={String(v ?? "")} onChange={(e) => set(key, e.target.value || null)}>
              <option value="">{t.props.unset}</option>
              {sub.enum.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {key === "role" ? roleLabel(String(option)) : choiceLabel(key, option)}
                </option>
              ))}
            </select>
          );
        } else if (sub.type === "boolean") {
          editor = <input type="checkbox" className="mt-1.5" checked={v === true} onChange={(e) => set(key, e.target.checked)} />;
        } else if (sub.type === "integer" || sub.type === "number") {
          editor = (
            <CommitInput
              value={v === undefined ? "" : String(v)}
              onCommit={(text) => {
                const n = Number(text.trim());
                set(key, text.trim() === "" || !Number.isFinite(n) ? null : n);
              }}
            />
          );
        } else if (key === "role") {
          editor = <RoleField value={typeof v === "string" ? v : ""} onChange={(role) => set(key, role || null)} />;
        } else {
          editor = <CommitInput mono={key === "css"} value={typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v)} onCommit={(text) => set(key, text)} />;
        }
        return (
          <label key={key} className="grid grid-cols-[76px_1fr] items-center gap-x-2" title={sub.description}>
            <span className="truncate text-right text-[11px] text-slate-500">{fieldLabel(key)}</span>
            <span className="min-w-0">{editor}</span>
          </label>
        );
      })}
      {rare.length > 0 && (
        <button type="button" className="ml-[84px] text-[11px] text-brand-600 hover:underline" onClick={() => setMore(!more)}>
          {more ? t.targetFields.less : t.targetFields.more}
        </button>
      )}
    </div>
  );
}

/**
 * The browser's role is free text: offer the common ones in words, and let
 * any other role (dialog, slider…) be typed in.
 */
function RoleField({ value, onChange }: { value: string; onChange: (role: string) => void }) {
  const [typing, setTyping] = useState(false);
  const custom = typing || (value !== "" && !BROWSER_ROLES.includes(value));
  return (
    <div className={custom ? "grid min-w-0 grid-cols-2 gap-1" : "min-w-0"}>
      <select
        className={inputClass}
        value={custom ? OTHER_ROLE : value}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER_ROLE) {
            setTyping(true);
            return;
          }
          setTyping(false);
          onChange(next);
        }}
      >
        <option value="">{t.props.unset}</option>
        {BROWSER_ROLES.map((role) => (
          <option key={role} value={role}>
            {roleLabel(role)}
          </option>
        ))}
        <option value={OTHER_ROLE}>{t.targetFields.otherRole}</option>
      </select>
      {custom && <CommitInput mono value={BROWSER_ROLES.includes(value) ? "" : value} onCommit={(text) => onChange(text.trim())} />}
    </div>
  );
}
const OTHER_ROLE = "\u0000other";

function ParamsEditor({
  step,
  def,
  vars,
  update,
}: {
  step: Step;
  def?: StepTypeDef;
  vars: Map<string, string | undefined>;
  update: (p: StepPatch) => void;
}) {
  const schema = (def?.paramsSchema ?? {}) as JsonSchema;
  const props = schema.properties ?? {};
  const params = step.params ?? {};
  const known = new Set(vars.keys());
  const run = useStudio((s) => s.run);
  const flowId = useStudio((s) => s.flow?.id);
  const scope = useMemo(() => runScope(run, flowId), [run, flowId]);
  const expressionParams = new Set(def?.expressionParams ?? []);
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(JSON.stringify(params, null, 2));
    setError(null);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (
    <button
      type="button"
      className="text-[10px] text-brand-600 hover:underline"
      onClick={(e) => {
        e.preventDefault();
        setRaw(!raw);
      }}
    >
      {raw ? t.props.form : t.rawJson}
    </button>
  );

  return (
    <Section title={t.params} aside={toggle}>
      {raw || Object.keys(props).length === 0 ? (
        <div className="space-y-1">
          <textarea className={`${inputClass} font-mono`} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          {error && <div className="text-xs text-shu-600">{error}</div>}
          <button
            type="button"
            className="rounded-[3px] bg-ink px-2.5 py-0.5 text-xs text-paper"
            onClick={() => {
              try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                setError(null);
                update({ replaceParams: parsed });
              } catch {
                setError(t.invalidJson);
              }
            }}
          >
            {t.apply}
          </button>
        </div>
      ) : step.type === "variable.set" && params.value === undefined ? (
        <VariableSetForm step={step} types={vars} scope={scope} update={update} />
      ) : (
        Object.entries(props).map(([key, propSchema]) => {
          const ref = referencedVariables(params[key], known)[0];
          const setParam = (value: unknown) => {
            const next = { ...params };
            if (value === null || value === undefined) delete next[key];
            else next[key] = value;
            update({ replaceParams: next });
          };
          if (expressionParams.has(key) && (params[key] === undefined || typeof params[key] === "string")) {
            const required = schema.required?.includes(key) ?? false;
            return (
              <Row key={key} label={`${paramLabel(key, step.type)}${required ? " *" : ""}`} title={key} socket={ref ? TYPE_COLOR[vars.get(ref) ?? "any"] : undefined}>
                <ExpressionField
                  value={typeof params[key] === "string" ? params[key] : ""}
                  onCommit={(text) => setParam(text.trim() === "" ? null : text)}
                  types={vars}
                  scope={scope}
                  label={paramLabel(key, step.type)}
                />
              </Row>
            );
          }
          if (key === "target" && appOf(step.type)) {
            return (
              <TargetField
                key={key}
                step={step}
                schema={propSchema}
                value={params[key]}
                required={schema.required?.includes(key) ?? false}
                onChange={setParam}
              />
            );
          }
          return (
            <ParamField
              key={key}
              name={key}
              stepType={step.type}
              schema={propSchema}
              value={params[key]}
              required={schema.required?.includes(key) ?? false}
              socket={ref ? TYPE_COLOR[vars.get(ref) ?? "any"] : undefined}
              secretCapable={def?.secretParams?.includes(key) ?? false}
              pointer={key === "target" ? pointerOf(step.type) : undefined}
              isPath={def?.pathParams?.includes(key) ?? false}
              // The whole params, not a merge patch: a merge would keep the
              // fields an object (a target) no longer has. null removes the key.
              onChange={setParam}
            />
          );
        })
      )}
    </Section>
  );
}

/** Where this step's variables come from and go to, matching the links on the chart. */
function Connections({ stepId, links, vars }: { stepId: string; links: DataLink[]; vars: Map<string, string | undefined> }) {
  const flow = useStudio((s) => s.flow);
  const goTo = useStudio((s) => s.goTo);
  const incoming = links.filter((l) => l.to === stepId);
  const outgoing = links.filter((l) => l.from === stepId);
  if (incoming.length === 0 && outgoing.length === 0) return null;
  const nameOf = (id: string) => {
    if (id === INPUT_NODE) return t.props.flowInput;
    if (id === OUTPUT_NODE) return t.props.flowOutput;
    const s = findStep(flow?.steps ?? [], id);
    return s?.name || s?.type || id;
  };
  const item = (l: DataLink, other: string, arrow: string) => (
    <li key={`${l.from}${l.to}${l.variable}${l.toHandle}`} className="flex items-center gap-1.5 py-0.5 text-[11px]">
      <span style={{ color: TYPE_COLOR[vars.get(l.variable) ?? "any"] }}>
        <VarIcon size={11} />
      </span>
      <span className="font-mono font-semibold">{l.variable}</span>
      <span className="text-slate-400">{arrow}</span>
      {other.startsWith("@") ? (
        <span className="truncate text-slate-600">{nameOf(other)}</span>
      ) : (
        <button type="button" className="truncate text-brand-600 hover:underline" onClick={() => goTo(other)}>
          {nameOf(other)}
        </button>
      )}
    </li>
  );
  return (
    <Section title={t.props.links}>
      {incoming.length > 0 && (
        <Row label={t.props.receives}>
          <ul className="pt-1">{incoming.map((l) => item(l, l.from, "←"))}</ul>
        </Row>
      )}
      {outgoing.length > 0 && (
        <Row label={t.props.passes}>
          <ul className="pt-1">{outgoing.map((l) => item(l, l.to, "→"))}</ul>
        </Row>
      )}
    </Section>
  );
}

/** Which flow a call runs, what it passes in and where its outputs go. */
function CallEditor({
  step,
  vars,
  update,
}: {
  step: Step;
  vars: Map<string, string | undefined>;
  update: (p: StepPatch) => void;
}) {
  const flow = useStudio((s) => s.flow);
  const summaries = useStudio((s) => s.summaries);
  const called = useStudio((s) => s.called);
  const open = useStudio((s) => s.open);
  const target = typeof step.params?.flow === "string" ? step.params.flow : "";
  const callee = called[target];
  const inputs = callMap(step, "inputs");
  const outs = callMap(step, "outputs");
  const known = new Set(vars.keys());
  const choices = summaries.filter((s) => s.id !== flow?.id);
  const calleeVars = callee?.variables ?? [];
  const ins = calleeVars.filter((v) => v.direction === "input" || v.direction === "inOut");
  const results = calleeVars.filter((v) => v.direction === "output" || v.direction === "inOut");
  return (
    <>
      <Section
        title={t.props.callee}
        aside={
          callee && (
            <button
              type="button"
              className="text-[10px] text-brand-600 hover:underline"
              onClick={(e) => {
                e.preventDefault();
                void open(target);
              }}
            >
              {t.flow.open} ↗
            </button>
          )
        }
      >
        <Row label={`${t.props.flow} *`} hint={target !== "" && !callee ? t.props.notInWorkspace : undefined}>
          <select
            className={inputClass}
            value={target}
            // Inputs and outputs belong to the old target: start over.
            onChange={(e) => update({ replaceParams: { flow: e.target.value } })}
          >
            <option value="">{t.props.choose}</option>
            {target !== "" && !choices.some((c) => c.id === target) && <option value={target}>{target}</option>}
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Row>
      </Section>
      {callee && (
        <Section title={t.props.inputs}>
          {ins.length === 0 && <p className="py-1 text-[11px] text-slate-400">{t.props.noInputs}</p>}
          {ins.map((v) => {
            const value = inputs[v.name];
            const ref = referencedVariables(value, known)[0];
            const required = v.default === undefined || v.default === null;
            return (
              <Row
                key={v.name}
                label={`${v.name}${required ? " *" : ""}`}
                title={v.description ?? v.name}
                socket={ref ? TYPE_COLOR[vars.get(ref) ?? "any"] : TYPE_COLOR[v.type ?? "any"]}
                hint={v.secret ? t.props.secretInput : required ? undefined : t.props.defaultIs(JSON.stringify(v.default))}
              >
                <CommitInput
                  mono
                  value={value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)}
                  placeholder={`{{ ${v.name} }}`}
                  onCommit={(text) => {
                    const trimmed = text.trim();
                    let next: unknown = trimmed === "" ? null : trimmed;
                    if (trimmed !== "" && !trimmed.includes("{{")) {
                      try {
                        next = JSON.parse(trimmed);
                      } catch {
                        next = trimmed;
                      }
                    }
                    update({ params: { inputs: { [v.name]: next } } });
                  }}
                />
              </Row>
            );
          })}
        </Section>
      )}
      {callee && (
        <Section title={t.props.outputs}>
          {results.length === 0 && <p className="py-1 text-[11px] text-slate-400">{t.props.noOutputs}</p>}
          {results.map((v) => {
            const into = typeof outs[v.name] === "string" ? (outs[v.name] as string) : "";
            return (
              <Row key={v.name} label={v.name} title={v.description ?? v.name} socket={into ? TYPE_COLOR[vars.get(into) ?? v.type ?? "any"] : undefined}>
                <CommitInput
                  mono
                  value={into}
                  placeholder={t.props.ignoreOutput}
                  onCommit={(text) => update({ params: { outputs: { [v.name]: text.trim() === "" ? null : text.trim() } } })}
                />
              </Row>
            );
          })}
        </Section>
      )}
    </>
  );
}

/** The selected step and the ones after it, in the same block. */
function siblingsFrom(steps: Step[], id: string): Step[] | null {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) return steps.slice(i);
  for (const step of steps) {
    for (const children of Object.values(step.blocks ?? {})) {
      const found = siblingsFrom(children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Moves this step (and the next few) into a new flow called from here. */
/** Moves the selected step (and the ones after it) into a new sub-flow. Opened from the step's tools. */
export function ExtractForm({ step }: { step: Step }) {
  const flow = useStudio((s) => s.flow);
  const extract = useStudio((s) => s.extract);
  const after = useMemo(() => siblingsFrom(flow?.steps ?? [], step.id ?? "") ?? [step], [flow, step]);
  const [count, setCount] = useState(1);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCount(1);
    setName("");
  }, [step.id]);
  const picked = after.slice(0, Math.min(count, after.length));
  return (
    <div className="w-[320px] p-3">
      <div className="pb-1 text-[11px] font-bold tracking-wider text-slate-600">{t.props.extract}</div>
      <Row label={t.props.extractRange} hint={picked.map((s) => s.name || s.type).join(" → ")}>
        <select className={inputClass} value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {after.map((_, i) => (
            <option key={i} value={i + 1}>
              {i === 0 ? t.props.thisStep : t.props.stepsFromHere(i + 1)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t.props.newName}>
        <input className={inputClass} value={name} placeholder={t.props.newNamePlaceholder} onChange={(e) => setName(e.target.value)} />
      </Row>
      <div className="flex justify-end pt-1">
        <button
          type="button"
          disabled={busy || name.trim() === ""}
          className="rounded-[3px] bg-ink px-2.5 py-0.5 text-xs text-paper disabled:opacity-40"
          onClick={async (e) => {
            e.preventDefault();
            setBusy(true);
            await extract(
              picked.map((s) => s.id ?? ""),
              name.trim(),
            );
            setBusy(false);
          }}
        >
          {t.props.extractButton}
        </button>
      </div>
      <p className="pt-1 text-[10px] leading-snug text-slate-400">
        {t.props.extractHint}
      </p>
    </div>
  );
}

function StepInspector() {
  const flow = useStudio((s) => s.flow);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const validation = useStudio((s) => s.validation);
  const updateStep = useStudio((s) => s.updateStep);
  const approve = useStudio((s) => s.approve);
  const revert = useStudio((s) => s.revert);
  const pending = usePendingReview();
  const history = useStudio((s) => s.history);
  const vars = useMemo(() => knownVariables(flow?.variables, flow?.steps ?? []), [flow]);
  const links = useMemo(() => {
    const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
    return dataLinks(flow?.steps ?? [], flow?.variables, defs, new Set(vars.keys()));
  }, [flow, stepTypes, vars]);

  if (!flow) return null;
  if (selection?.kind !== "step") return <FlowInspector />;
  const step = findStep(flow.steps ?? [], selection.stepId);
  if (!step?.id) return <p className="p-4 text-sm text-slate-400">{t.selectStep}</p>;
  const id = step.id;
  const def = stepTypes.find((d) => d.type === step.type);
  const update = (patch: StepPatch) => updateStep(id, patch);
  const issues = validation?.issues.filter((i) => i.stepId === id) ?? [];
  const color = CATEGORY_COLOR[def?.category ?? step.type.split(".")[0] ?? "other"] ?? CATEGORY_COLOR.other;
  const outs = outputs(step);
  const isCall = step.type === CALL;

  return (
    <div className="pb-6">
      <div className="px-4 pt-4 pb-3">
        <div className="overflow-hidden rounded-[4px] border border-slate-200">
          <div className="flex items-center gap-2 px-3 py-2" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            <span className="text-sm font-bold" style={{ color }} title={`${step.type} · ID: ${id}`}>
              {typeTitle(step, def)}
            </span>
          </div>
          <div className="space-y-1 px-3 py-2">
            <div className="text-[13px] leading-snug">
              <Sentence parts={sentence(step, def)} />
            </div>
            {def && <p className="text-[11px] text-slate-500">{stepSummary(def.type, def.description)}</p>}
          </div>
        </div>
        {pending
          .filter((e) => touchedSteps(e).includes(id))
          .map((e) => (
            <div key={e.revision} className="mt-2 flex items-center gap-2 rounded-[4px] border border-shu-100 bg-shu-50 px-2 py-1.5 text-xs">
              <ActorMark entry={e} size={18} />
              <span className="flex-1">
                {t.props.changedBy(t.actor[e.actor.kind], e.revision)}
              </span>
              <button type="button" className="font-medium hover:underline" onClick={() => approve(e.revision)}>
                {t.approve}
              </button>
              <button
                type="button"
                className="font-medium text-shu-600 enabled:hover:underline disabled:text-slate-400"
                disabled={revertBlocker(e, history) !== null}
                title={revertBlocker(e, history) ?? undefined}
                onClick={() => revert(e)}
              >
                {t.revert}
              </button>
            </div>
          ))}
        {issues.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-[4px] border border-shu-100 bg-shu-50 p-2 text-xs text-shu-600">
            {issues.map((i) => (
              <li key={`${i.code}${i.path}${i.message}`}>
                {i.severity === "warning" ? "⚠" : "✕"} {issueText(i, flow)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Section title={t.props.basics}>
        <Row label={t.stepName}>
          <CommitInput value={step.name ?? ""} onCommit={(name) => update({ name })} />
        </Row>
      </Section>
      {isCall ? (
        <CallEditor step={step} vars={vars} update={update} />
      ) : (
        <ParamsEditor step={step} def={def} vars={vars} update={update} />
      )}
      {!isCall && (outs.length > 0 || def?.hasOutput) && (
        <Section title={t.props.output}>
          {def?.hasOutput && (
            <Row label={t.saveAs} socket={step.saveAs ? TYPE_COLOR[vars.get(step.saveAs) ?? "any"] : undefined}>
              <CommitInput
                mono
                value={step.saveAs ?? ""}
                placeholder={t.props.variableName}
                onCommit={(v) => update({ saveAs: v.trim() === "" ? null : v.trim() })}
              />
            </Row>
          )}
          {outs
            .filter((o) => o.variable !== step.saveAs)
            .map((o) => (
              <Row key={o.variable} label={o.label} socket={TYPE_COLOR[vars.get(o.variable) ?? "any"]}>
                <span className="block pt-1 font-mono text-xs font-semibold">{o.variable}</span>
              </Row>
            ))}
        </Section>
      )}
      <Connections stepId={id} links={links} vars={vars} />
      <Section title={t.props.execution}>
        <Row label={t.disabled}>
          <input type="checkbox" className="mt-1.5" checked={step.disabled ?? false} onChange={(e) => update({ disabled: e.target.checked })} />
        </Row>
        {!step.type.startsWith("control.") && (
          <>
          <Row label={t.timeoutMs}>
            <CommitInput
              value={step.timeoutMs?.toString() ?? ""}
              placeholder={isCall ? t.props.callTimeout : "30000"}
              onCommit={(v) => update({ timeoutMs: v.trim() === "" ? null : Number(v) })}
            />
          </Row>
          {!isCall && (
            <Row label={t.retry}>
              <CommitInput
                value={step.retry?.maxAttempts?.toString() ?? ""}
                placeholder="1"
                onCommit={(v) => {
                  const n = Number(v);
                  update({ retry: v.trim() === "" || n <= 1 ? null : { maxAttempts: n, backoffMs: 1000, backoffMultiplier: 2 } });
                }}
              />
            </Row>
          )}
          <Row label={t.onError}>
            <select
              className={inputClass}
              value={step.onError ?? ""}
              onChange={(e) => update({ onError: (e.target.value || null) as StepPatch["onError"] })}
            >
              <option value="">{t.props.followFlow}</option>
              <option value="fail">{t.onErrorFail}</option>
              <option value="continue">{t.onErrorContinue}</option>
            </select>
          </Row>
          </>
        )}
      </Section>
    </div>
  );
}

/** When this flow runs by itself on this PC; they are edited in 「自動実行」. */
function SchedulesSection({ flowId }: { flowId: string }) {
  const schedules = useSchedulesOf(flowId);
  const setPlace = useStudio((s) => s.setPlace);
  if (!schedules) return null;
  return (
    <Section title={t.runs.schedules}>
      <ul className="space-y-1 text-xs">
        {schedules.length === 0 && <li className="text-slate-500">{t.runs.none}</li>}
        {schedules.map((s) => (
          <li key={s.id} className={s.enabled ? "" : "text-slate-500"}>
            <button type="button" className="text-left hover:underline" onClick={() => setPlace("runs")}>
              {describeWhen(s.when)}
              {!s.enabled && `（${t.runs.paused}）`}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-1.5 text-xs text-brand-600 hover:underline"
        onClick={() => {
          openNewSchedule();
          setPlace("runs");
        }}
      >
        {t.runs.add}
      </button>
    </Section>
  );
}

/** With nothing selected, the inspector shows the flow itself: what it is, its variables, how it runs. */
function FlowInspector() {
  const flow = useStudio((s) => s.flow);
  const updateFlow = useStudio((s) => s.updateFlow);
  if (!flow) return null;
  const settings = flow.settings ?? {};
  const setSettings = (patch: Partial<typeof settings>) => updateFlow({ settings: { ...settings, ...patch } });
  return (
    <div className="pb-6">
      <Section title={t.props.basics}>
        <Row label={t.shell.name}>
          <CommitInput value={flow.name} onCommit={(name) => name.trim() && updateFlow({ name: name.trim() })} />
        </Row>
        <Row label={t.shell.description}>
          <CommitInput multiline value={flow.description ?? ""} placeholder={t.shell.descriptionPlaceholder} onCommit={(description) => updateFlow({ description })} />
        </Row>
      </Section>
      <Section title={t.variables}>
        <div className="-mx-4 -my-3">
          <VariablesPanel />
        </div>
      </Section>
      <Section title={t.shell.runSettings}>
        <Row label={t.shell.defaultTimeout}>
          <CommitInput
            value={settings.defaultTimeoutMs?.toString() ?? ""}
            placeholder="30000"
            onCommit={(v) => setSettings({ defaultTimeoutMs: v.trim() === "" ? null : Number(v) })}
          />
        </Row>
        <Row label={t.shell.onError}>
          <select className={inputClass} value={settings.onError ?? ""} onChange={(e) => setSettings({ onError: (e.target.value || null) as typeof settings.onError })}>
            <option value="">{t.shell.onErrorDefault}</option>
            <option value="fail">{t.onErrorFail}</option>
            <option value="continue">{t.onErrorContinue}</option>
          </select>
        </Row>
      </Section>
      <SchedulesSection flowId={flow.id} />
    </div>
  );
}

/**
 * The inspector: the properties of what is selected, and nothing else. A
 * step when one is selected, otherwise the flow. The path at the top says
 * which, and steps back up to the flow.
 */
export function Inspector() {
  const flow = useStudio((s) => s.flow);
  const selection = useStudio((s) => s.selection);
  const stepTypes = useStudio((s) => s.stepTypes);
  const select = useStudio((s) => s.select);
  if (!flow) return null;
  const step = selection?.kind === "step" ? findStep(flow.steps ?? [], selection.stepId) : undefined;
  const def = step ? stepTypes.find((d) => d.type === step.type) : undefined;
  const partName = selection?.kind === "part" ? selection.name : undefined;
  const part = partName ? flow.parts?.[partName] : undefined;
  return (
    <aside className="relative z-[1] flex h-full min-h-0 flex-col border-l border-slate-200 bg-sheet">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-slate-200 px-4 text-[12px]">
        {partName ? (
          <>
            <button type="button" onClick={() => select(null)} className="shrink-0 text-slate-500 hover:text-ink hover:underline" title={t.shell.toFlow}>
              {t.shell.flow}
            </button>
            <span className="text-slate-400">›</span>
            <span className="text-slate-500">{t.parts.title}</span>
            <span className="text-slate-400">›</span>
            <span className="truncate font-semibold">{part?.label || partName}</span>
          </>
        ) : step ? (
          <>
            {/* The flow's name is in the title bar; here it is the way back to its properties. */}
            <button type="button" onClick={() => select(null)} className="shrink-0 text-slate-500 hover:text-ink hover:underline" title={t.shell.toFlow}>
              {t.shell.flow}
            </button>
            <span className="text-slate-400">›</span>
            <span className="truncate font-semibold">{step.name || typeTitle(step, def)}</span>
          </>
        ) : (
          <span className="font-semibold">{t.shell.flow}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {partName ? <PartInspector name={partName} /> : step ? <StepInspector /> : <FlowInspector />}
      </div>
    </aside>
  );
}
