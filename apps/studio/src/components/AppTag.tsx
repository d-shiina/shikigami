import type { StepTypeDef } from "@spellsheet/schema";
import { appTag } from "../lib/palette";

/** Where a node works ("ブラウザ", "Excel"), as a quiet grey tag after its name. */
export function AppTag({ def, title }: { def: Pick<StepTypeDef, "type" | "category"> | undefined; title: string }) {
  const tag = appTag(def, title);
  if (!tag) return null;
  return <span className="shrink-0 rounded-sm border border-slate-200 px-1 text-[10.5px] leading-4 whitespace-nowrap text-slate-500">{tag}</span>;
}
