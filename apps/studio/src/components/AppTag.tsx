import type { StepTypeDef } from "@shikigami/schema";
import { appTag } from "../lib/palette";

/** Where a node works ("ブラウザ", "Excel"), as a small tag before its name. */
export function AppTag({ def, title, color }: { def: Pick<StepTypeDef, "type" | "category"> | undefined; title: string; color: string | undefined }) {
  const tag = appTag(def, title);
  if (!tag) return null;
  return (
    <span
      className="shrink-0 rounded-[3px] border px-1 text-[10.5px] leading-4 font-semibold whitespace-nowrap"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}
    >
      {tag}
    </span>
  );
}
