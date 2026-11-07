// The settings form of a node: one field per param of its definition, the
// screen target fields (with 画面から選ぶ / 光らせる), secrets and lists.
import type { Step, StepPatch, StepTypeDef } from "@shikigami/schema";
import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../../context";
import { Boxes, Crosshair, ScanSearch } from "lucide-react";
import { api, type SecretField } from "../../lib/api";
import { locale, t } from "../../lib/i18n";
import { choiceLabel, paramLabel, plainHint, referencedVariables, TYPE_COLOR } from "../../lib/nodeRows";
import { appOf, detachOps, makePartOps, newPartName, partRef, partUses } from "../../lib/parts";
import { runScope } from "../../lib/runScope";
import { targetText } from "../../lib/sentence";
import { isActive } from "../../store";
import { ExpressionField } from "../ExpressionField";
import { VariableSetForm } from "../TransformForm";
import { columnsByVariable, InsertProvider, ListSourceField, TemplateInput, useInsertChoices } from "../InsertVariable";
import { listToText, textToList } from "../../lib/listText";
import { pageAbove } from "../../lib/loopScope";
import { credentialFor } from "../../lib/extensions";
import { fieldLabel as secretFieldLabel } from "../../lib/secretKinds";
import { FOR_EACH } from "../../lib/stepTypes";
import { type JsonSchema, inputClass, CommitInput, PathField, Row, AddRow, Section } from "./fields";

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
  stepType,
  param,
  onChange,
}: {
  label: string;
  schema: JsonSchema;
  value: unknown;
  stepType: string;
  param: string;
  onChange: (value: unknown) => void;
}) {
  const allSecrets = useStudio((s) => s.secrets);
  const openSecrets = useStudio((s) => s.setSecretsOpen);
  const openSecretForm = useStudio((s) => s.openSecretForm);
  const def = useStudio((s) => s.stepTypes.find((d) => d.type === stepType));
  // An extension's setting says which kind of secret it takes (an API key…): offer those, and register one of that kind.
  const credential = credentialFor(def, param);
  const secrets = credential ? allSecrets.filter((s) => (s.kind ?? "login") === credential.kind) : allSecrets;
  const register = () =>
    credential && def?.plugin
      ? openSecretForm({ name: credential.label, sites: [`plugin:${def.plugin.name}`], fields: ["password"], kind: credential.kind })
      : openSecrets(true);
  const ref = isSecretRef(value) ? value : null;
  const [mode, setMode] = useState<"text" | "secret">(ref ? "secret" : "text");
  useEffect(() => setMode(ref ? "secret" : "text"), [ref]);
  // The param's schema lists the fields it takes (http.request auth also takes the OAuth access token).
  const all = (secretFieldsOf(schema) ?? ["username", "password", "totp"]) as SecretField[];
  // An API key is one value; other kinds keep the fields the param takes.
  const fields = credential?.kind === "apiKey" ? (["password"] as SecretField[]) : all;

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
            className={`rounded-md px-2 py-0.5 ${mode === m ? "bg-slate-100 font-medium text-ink ring-1 ring-slate-300" : "text-slate-500 hover:bg-slate-100"}`}
          >
            {m === "text" ? t.secretText : `🔑 ${t.secretUse}`}
          </button>
        ))}
      </div>
      {mode === "text" ? (
        <TemplateInput value={typeof value === "string" ? value : ""} label={label} onCommit={(text) => onChange(text === "" ? null : text)} />
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
                {credential ? secretFieldLabel(credential.kind, f) : t.secretField[f]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="whitespace-nowrap text-xs text-brand-600 hover:underline"
            onClick={register}
          >
            ＋{t.secretRegister}
          </button>
        </div>
      )}
      {credential && <span className="block text-[11px] text-slate-500">{t.extensions.secretHint(credential.label, t.secretKinds[credential.kind])}</span>}
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
  stepId,
  isPath,
  binds,
  onRemove,
  onChange,
}: {
  name: string;
  stepType: string;
  schema: JsonSchema;
  onRemove?: () => void;
  value: unknown;
  required: boolean;
  socket?: string;
  secretCapable: boolean;
  /** The adapter that can pick this target on screen and highlight it. */
  pointer?: string;
  /** The node, for the picker to find its 「ページを開く」. */
  stepId?: string;
  /** A file or folder of the flow's folder (`input/orders.xlsx`). */
  isPath?: boolean;
  /** A variable name the node defines (a repeat's 要素): plain text, nothing to insert. */
  binds?: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = `${paramLabel(name, stepType)}${required ? " *" : ""}`;
  if (secretCapable) {
    return <TextOrSecretField label={label} schema={schema} value={value} stepType={stepType} param={name} onChange={onChange} />;
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
            {choiceLabel(name, v, stepType)}
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
            {choiceLabel(name, v, stepType)}
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
  } else if (schema.type === "string" && binds) {
    editor = <CommitInput value={String(value ?? "")} onCommit={(text) => onChange(text === "" ? null : text)} />;
  } else if (schema.type === "string") {
    editor = <TemplateInput value={String(value ?? "")} label={paramLabel(name, stepType)} onCommit={(text) => onChange(text === "" ? null : text)} />;
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
          {pointer && <PointTools adapter={pointer} schema={schema} value={value} stepId={stepId} onChange={onChange} />}
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
    <Row label={label} title={schema.description ? `${schema.description}（${name}）` : name} socket={socket} hint={hint} onRemove={onRemove}>
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
            stepId={step.id}
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
          <div className={`rounded-lg border px-2.5 py-2 text-[12px] ${part.target ? "border-slate-200 bg-paper" : "border-amber-300 bg-amber-50"}`}>
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
                <button type="button" className="shrink-0 rounded-md border border-slate-300 bg-paper text-ink hover:bg-slate-100 px-2.5 py-1 text-[11px]" onClick={() => void make()}>
                  {t.parts.create}
                </button>
              </div>
            ) : (
              <button
                type="button"
                title={t.parts.makeHint}
                className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50"
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

/** The browser context the nodes using a part run in (the first one that names one). */
export const partContext = (uses: readonly Step[]) =>
  uses.map((u) => u.params?.context).find((c): c is string => typeof c === "string" && c !== "");

/** The browser Studio opens to pick parts with no run going (the adapter keeps it by this name). */
const STUDIO_BROWSER = "studio-pick";
/** The adapters whose targets can be picked on screen from Studio. */
export const POINTERS = new Set(["desktop", "browser"]);
const pointerOf = (type: string) => {
  const adapter = type.split(".")[0] ?? "";
  return POINTERS.has(adapter) ? adapter : undefined;
};

/**
 * "画面から選ぶ" and "光らせる" beside a target: the adapter builds the
 * target from what the user clicks, and frames the current one on screen.
 */
export function PointTools({
  adapter,
  schema,
  value,
  context,
  stepId,
  onChange,
  large = false,
}: {
  adapter: string;
  schema: JsonSchema;
  value: unknown;
  /** As the main action of the place (a part's screen), not a small link by a field. */
  large?: boolean;
  /** The browser context the node uses (`context` param). */
  context?: string;
  /** The node, to find the 「ページを開く」 above it. */
  stepId?: string;
  onChange: (value: unknown) => void;
}) {
  const run = useStudio((s) => s.run);
  const flow = useStudio((s) => s.flow);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const canPoint = Boolean(schema.properties?.point);
  // A browser part is picked in the browser a run opened. With no run going,
  // Studio opens the page of the nearest 「ページを開く」 above in a browser of
  // its own, which stays open for the next pick.
  const browser = adapter === "browser";
  const running = browser && run && isActive(run) ? run.runId : undefined;
  const page = browser && !running && stepId ? pageAbove(flow?.steps ?? [], stepId, context) : null;
  const session = running ?? (browser ? STUDIO_BROWSER : undefined);
  const unavailable = browser && !running && !page?.url;
  const extra = browser ? { ...(context ? { context } : {}), ...(page?.url ? { url: page.url } : {}) } : {};
  const why = !browser || running || page?.url ? undefined : page ? t.picker.urlIsExpression : t.picker.needsOpen;
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
  const button = large
    ? "inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-paper px-3 text-[13px] text-ink hover:bg-slate-100 disabled:opacity-50"
    : "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50 disabled:opacity-50";
  return (
    <>
      <span className={large ? "flex items-center gap-2" : "ml-auto flex items-center gap-0.5"}>
        <button
          type="button"
          className={button}
          title={why ?? (running ? t.picker.pickBrowserTitle : page?.url ? t.picker.pickOpensTitle(page.url) : t.picker.pickTitle)}
          disabled={busy || unavailable}
          onClick={() => void pick()}
        >
          <Crosshair size={13} strokeWidth={1.75} />
          {t.picker.pick}
        </button>
        <button
          type="button"
          className={button}
          title={why ?? t.picker.highlightTitle}
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
export function ObjectFields({
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
    <div className="space-y-1 rounded-lg border border-slate-200 bg-paper px-2 py-1.5">
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

export function ParamsEditor({
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
  const baseScope = useMemo(() => runScope(run, flowId), [run, flowId]);
  const choices = useInsertChoices(step, baseScope);
  const scope = useMemo(() => ({ ...baseScope, columns: columnsByVariable(choices) }), [baseScope, choices]);
  const stepTypes = useStudio((s) => s.stepTypes);
  const expressionParams = new Set(def?.expressionParams ?? []);
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Optional settings opened with 「＋ 設定を追加」 but still empty.
  const [added, setAdded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setText(JSON.stringify(params, null, 2));
    setError(null);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setAdded(new Set()), [step.id]);
  const isRequired = (key: string) => schema.required?.includes(key) ?? false;
  const shown = (key: string) => isRequired(key) || params[key] !== undefined || added.has(key);
  const hidden = Object.keys(props)
    .filter((key) => !shown(key))
    .map((key) => ({ key, label: paramLabel(key, step.type) }));
  const remove = (key: string) => {
    setAdded((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (params[key] !== undefined) {
      const next = { ...params };
      delete next[key];
      update({ replaceParams: next });
    }
  };

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
    <InsertProvider value={choices}>
      <Section title={t.params} aside={toggle}>
      {raw || Object.keys(props).length === 0 ? (
        <div className="space-y-1">
          <textarea className={`${inputClass} font-mono`} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          {error && <div className="text-xs text-shu-600">{error}</div>}
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-paper text-ink hover:bg-slate-100 px-2.5 py-0.5 text-xs"
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
        <>
        {Object.entries(props).filter(([key]) => shown(key)).map(([key, propSchema]) => {
          const ref = referencedVariables(params[key], known)[0];
          const onRemove = isRequired(key) ? undefined : () => remove(key);
          const setParam = (value: unknown) => {
            const next = { ...params };
            if (value === null || value === undefined) delete next[key];
            else next[key] = value;
            update({ replaceParams: next });
          };
          if (expressionParams.has(key) && (params[key] === undefined || typeof params[key] === "string")) {
            const required = schema.required?.includes(key) ?? false;
            const field = (
              <ExpressionField
                value={typeof params[key] === "string" ? params[key] : ""}
                onCommit={(text) => setParam(text.trim() === "" ? null : text)}
                types={vars}
                scope={scope}
                label={paramLabel(key, step.type)}
              />
            );
            return (
              <Row key={key} label={`${paramLabel(key, step.type)}${required ? " *" : ""}`} title={key} socket={ref ? TYPE_COLOR[vars.get(ref) ?? "any"] : undefined} onRemove={onRemove}>
                {step.type === FOR_EACH && key === "items" ? (
                  <ListSourceField step={step} defs={stepTypes} value={typeof params[key] === "string" ? params[key] : ""} onChange={setParam} expression={field} />
                ) : (
                  field
                )}
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
              onRemove={onRemove}
              key={key}
              name={key}
              stepType={step.type}
              schema={propSchema}
              value={params[key]}
              required={schema.required?.includes(key) ?? false}
              socket={ref ? TYPE_COLOR[vars.get(ref) ?? "any"] : undefined}
              secretCapable={def?.secretParams?.includes(key) ?? false}
              pointer={key === "target" ? pointerOf(step.type) : undefined}
              stepId={step.id}
              isPath={def?.pathParams?.includes(key) ?? false}
              binds={def?.bindsVariables?.includes(key) ?? false}
              // The whole params, not a merge patch: a merge would keep the
              // fields an object (a target) no longer has. null removes the key.
              onChange={setParam}
            />
          );
        })}
        <AddRow choices={hidden} onAdd={(key) => setAdded((prev) => new Set(prev).add(key))} />
        </>
      )}
      </Section>
    </InsertProvider>
  );
}

