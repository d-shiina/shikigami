// The inspector for a named screen part (`flow.parts`).
import type { Part } from "@shikigami/schema";
import { useStudio } from "../../context";
import { Boxes, Image as ImageIcon, Pencil } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { stepLabel, t } from "../../lib/i18n";
import { outline } from "../../lib/outline";
import { imageOf, imagePathFor, partKind } from "../../lib/imageParts";
import { useProjectMaybe } from "../../project";
import { partUses } from "../../lib/parts";
import { targetText } from "../../lib/sentence";
import { CATEGORY_COLOR } from "../CommandPalette";
import { type JsonSchema, CommitInput, Section } from "./fields";
import { ImagePartEditor, Picture, savePicture, SnipButton, useProjectImage } from "./ImagePart";
import { PointTools, ObjectFields, POINTERS, partContext } from "./params";

/** A named part: its name, its target (pick it again, highlight it) and the nodes that use it. */
export function PartInspector({ name }: { name: string }) {
  const flow = useStudio((s) => s.flow);
  const stepTypes = useStudio((s) => s.stepTypes);
  const applyOps = useStudio((s) => s.applyOps);
  const goTo = useStudio((s) => s.goTo);
  const select = useStudio((s) => s.select);
  const part = flow?.parts?.[name];
  const [editing, setEditing] = useState(false);
  const image = imageOf(part);
  const picture = useProjectImage(image?.path);
  const files = useProjectMaybe((s) => s.files, null);
  if (!flow || !part)
    return (
      <p className="p-4 text-sm text-slate-400">{t.parts.missing(name)}</p>
    );
  // The widest target of the app: the one nodes that may point at a place take.
  const def = stepTypes.find(
    (d) =>
      d.type ===
      (part.app === "desktop" ? "desktop.mouseClick" : "browser.click"),
  );
  const wide = ((def?.paramsSchema as JsonSchema | undefined)?.properties
    ?.target ?? {}) as JsonSchema;
  // The usual fields, and the others only when the part has them (a place, a picture…).
  const has = new Set([
    "window",
    "element",
    "role",
    "name",
    "label",
    "text",
    "placeholder",
    ...Object.keys(part.target ?? {}),
  ]);
  const schema: JsonSchema = {
    ...wide,
    properties: Object.fromEntries(
      Object.entries(wide.properties ?? {}).filter(
        ([k]) => part.app === "browser" || has.has(k),
      ),
    ),
  };
  const uses = partUses(flow.steps ?? [], name);
  // The node numbers people see in the status bar ("ノード 3 / 5").
  const order = outline(
    flow.steps ?? [],
    new Map(stepTypes.map((d) => [d.type, d] as const)),
  ).map((i) => i.id);
  const set = (patch: Partial<Part>) =>
    void applyOps([{ op: "setPart", name, part: { ...part, ...patch } }]);
  const color =
    CATEGORY_COLOR[part.app === "desktop" ? "windows" : "browser"] ??
    CATEGORY_COLOR.other;
  const pointer = POINTERS.has(part.app) ? part.app : undefined;
  const kind = partKind(part);
  const KindIcon = image ? ImageIcon : Boxes;
  // An image part is found within its window (and a region of it, if given).
  const scope: JsonSchema = {
    ...schema,
    properties: Object.fromEntries(Object.entries(wide.properties ?? {}).filter(([k]) => k === "window" || k === "region")),
  };

  const usedBy = (
    <Section title={t.parts.usedBy}>
      {uses.length === 0 ? (
        <p className="text-[12px] text-slate-500">{t.parts.unused}</p>
      ) : (
        <ul className="space-y-0.5">
          {uses.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-slate-100"
                onClick={() => s.id && goTo(s.id)}
              >
                <span className="w-7 shrink-0 text-right font-mono text-[11px] text-slate-400">
                  {order.indexOf(s.id ?? "") + 1}
                </span>
                <span className="truncate">
                  {s.name ||
                    stepLabel(
                      s.type,
                      stepTypes.find((d) => d.type === s.type)?.label,
                    )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );

  // The inspector says what the part is; changing it happens on its own screen.
  return (
    <div className="pb-6">
      <div className="px-4 pt-4 pb-3">
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
            }}
          >
            <KindIcon
              size={14}
              strokeWidth={1.75}
              style={{ color }}
              aria-hidden="true"
            />
            <span className="text-sm font-bold" style={{ color }}>
              {t.parts.app[kind] ?? t.parts.title}
            </span>
          </div>
          <div className="space-y-1 px-3 py-2">
            <div className="text-[13px] leading-snug">{part.label || name}</div>
            {image && (
              <Picture
                src={picture}
                alt={part.label || name}
                maxHeight={96}
                offset={(part.target as { offset?: { x: number; y: number } } | null)?.offset}
              />
            )}
            <p className="text-[11px] text-slate-500">
              {targetText(part.target)}
            </p>
          </div>
        </div>
        {!part.target && (
          <p
            role="status"
            className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-700"
          >
            {t.todos.notPicked}
          </p>
        )}
        {uses.length > 1 && (
          <p className="mt-2 text-[11px] text-slate-500">
            {t.parts.shared(uses.length)}
          </p>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-paper px-3 text-[13px] text-ink hover:bg-slate-100"
        >
          <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
          {t.parts.edit}
        </button>
      </div>
      {usedBy}
      {/* On the body: the inspector is its own layer and would put the chart's panels above it. */}
      {editing &&
        createPortal(
          <div
            className="fixed inset-0 z-40 grid place-items-center bg-ink/30"
            onMouseDown={() => setEditing(false)}
          >
            <div
              role="dialog"
              aria-label={t.parts.editTitle(part.label || name)}
              className="max-h-[85vh] w-[560px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-slate-200 bg-sheet shadow-xl"
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            >
              <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
                <KindIcon
                  size={15}
                  strokeWidth={1.75}
                  style={{ color }}
                  aria-hidden="true"
                />
                <h2 className="text-sm font-bold">
                  {t.parts.editTitle(part.label || name)}
                </h2>
              </div>
              <div className="space-y-4 px-4 py-4">
                <label className="grid grid-cols-[120px_1fr] items-center gap-x-3">
                  <span className="text-[12px] text-slate-600">
                    {t.parts.label}
                  </span>
                  <CommitInput
                    value={part.label ?? ""}
                    onCommit={(text) =>
                      set({ label: text.trim() || undefined })
                    }
                  />
                </label>
                {image ? (
                  <>
                    <ImagePartEditor
                      name={name}
                      part={part}
                      set={(next) => void applyOps([{ op: "setPart", name, part: next }])}
                      scopeFields={
                        <ObjectFields
                          schema={scope}
                          value={(part.target ?? undefined) as Record<string, unknown> | undefined}
                          onChange={(next) =>
                            next &&
                            set({
                              target: {
                                ...Object.fromEntries(
                                  Object.entries(
                                    part.target as Record<string, unknown>,
                                  ).filter(
                                    ([k]) => k !== "window" && k !== "region",
                                  ),
                                ),
                                ...(next as Record<string, unknown>),
                              } as Part["target"],
                            })
                          }
                        />
                      }
                    />
                    {picture && (
                      <div className="flex flex-wrap items-center gap-2">
                        <PointTools
                          large
                          pick={false}
                          adapter="desktop"
                          schema={schema}
                          value={part.target}
                          onChange={() => {}}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <>
                {pointer && (
                    <div className="flex flex-wrap items-center gap-2">
                      <PointTools
                        large
                        adapter={pointer}
                        schema={schema}
                        value={part.target}
                        context={partContext(uses)}
                        stepId={uses[0]?.id}
                        onChange={(target) =>
                          target && set({ target: target as Part["target"] })
                        }
                        more={
                          // A desktop part not picked yet may be a picture
                          // (a screen with nothing to pick): cut it out.
                          part.app === "desktop" &&
                          !part.target && (
                            <SnipButton
                              large
                              onCut={async (cut) => {
                                if (!flow) return;
                                const path = imagePathFor(name, files);
                                await savePicture(flow.id, path, cut);
                                set({
                                  target: {
                                    window: cut.window,
                                    image: { path },
                                  } as Part["target"],
                                });
                              }}
                            />
                          )
                        }
                      />
                    </div>
                  )}
                  <section>
                    <h3 className="text-[12px] font-semibold text-slate-700">
                      {t.parts.howFound}
                    </h3>
                    <p className="mb-1.5 text-[11px] text-slate-500">
                      {t.parts.howFoundHint}
                    </p>
                    <ObjectFields
                      schema={schema}
                      value={
                        (part.target ?? undefined) as
                          | Record<string, unknown>
                          | undefined
                      }
                      onChange={(target) =>
                        target && set({ target: target as Part["target"] })
                      }
                    />
                  </section>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 border-t border-slate-200 px-4 py-3">
                <button
                  type="button"
                  disabled={uses.length > 0}
                  title={
                    uses.length > 0
                      ? t.parts.removeBlocked(uses.length)
                      : undefined
                  }
                  className="rounded-md px-2 py-1 text-[12px] text-shu-600 hover:bg-shu-50 disabled:text-slate-400 disabled:hover:bg-transparent"
                  onClick={() => {
                    void applyOps([{ op: "removePart", name }]).then(
                      (ok) => ok && select(null),
                    );
                  }}
                >
                  {t.parts.remove}
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={() => setEditing(false)}
                  className="ml-auto h-8 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:bg-primary-hover"
                >
                  {t.close}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
