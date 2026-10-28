// Steps in reading order (the order they run, blocks in registry order), for
// the outline and for moving between steps with the keyboard.
import type { Step, StepTypeDef } from "@shikigami/schema";
import { blockLabel } from "./keywords";

export type OutlineItem = {
  id: string;
  step: Step;
  depth: number;
  /** Label of the block this step opens, when it is the first one in it. */
  block?: string;
};

export function outline(steps: Step[], defs: Map<string, StepTypeDef>): OutlineItem[] {
  const items: OutlineItem[] = [];
  const walk = (list: Step[], depth: number, block?: string) => {
    list.forEach((step, i) => {
      if (!step.id) return;
      items.push({ id: step.id, step, depth, ...(i === 0 && block ? { block } : {}) });
      const declared = defs.get(step.type)?.blocks ?? [];
      const lanes = [
        ...declared.map((b) => [b.name, blockLabel(step, b.name, b.label)] as const),
        ...Object.keys(step.blocks ?? {})
          .filter((name) => !declared.some((b) => b.name === name))
          .map((name) => [name, name] as const),
      ];
      for (const [name, label] of lanes) walk(step.blocks?.[name] ?? [], depth + 1, label);
    });
  };
  walk(steps, 0);
  return items;
}

/**
 * The id `delta` places from `current` in `ids`, clamped; the first or last
 * when nothing is current. ±Infinity is the last / first.
 */
export function neighbor(ids: string[], current: string | null | undefined, delta: number): string | undefined {
  if (ids.length === 0) return undefined;
  if (!Number.isFinite(delta)) return delta > 0 ? ids.at(-1) : ids[0];
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return delta > 0 ? ids[0] : ids.at(-1);
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))];
}
