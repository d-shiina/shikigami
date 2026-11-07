// The value-handling forms (lib/transforms.ts) as palette entries: each adds
// one "変数への代入" whose expression the form then edits, so the flow keeps a
// single way to say it (the AI writes the same thing) and the person chooses
// the variables in the form.
import { defaultExpression, TRANSFORMS, wordsOf } from "./transforms";

export type Preset = {
  key: string;
  /** Palette category id; labels live with the step categories. */
  category: "text" | "number" | "date" | "list";
  label: string;
  /** The function it shows off, for searching and the keyword hint. */
  keyword: string;
  description: string;
  /** The variable written, and the expression written to it. */
  name: string;
  expression: string;
};

/** The presets in the current language. */
export function presets(): Preset[] {
  return TRANSFORMS.map((def) => {
    const words = wordsOf(def);
    return {
      key: `preset:${def.category}:${def.key}`,
      category: def.category,
      label: words.label,
      keyword: def.keyword,
      description: words.description,
      name: def.name,
      expression: defaultExpression(def),
    };
  });
}
