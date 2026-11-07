// The inspector for a named screen part (`flow.parts`).
import type { Part } from "@shikigami/schema";
import { useStudio } from "../../context";
import { Boxes } from "lucide-react";
import { stepLabel, t } from "../../lib/i18n";
import { outline } from "../../lib/outline";
import { partUses } from "../../lib/parts";
import { targetText } from "../../lib/sentence";
import { CATEGORY_COLOR } from "../CommandPalette";
import { type JsonSchema, CommitInput, Section } from "./fields";
import { PointTools, ObjectFields, POINTERS, partContext } from "./params";

/** A named part: its name, its target (pick it again, highlight it) and the nodes that use it. */
export function PartInspector({ name }: { name: string }) {
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
              stepId={uses[0]?.id}
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

