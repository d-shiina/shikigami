import type { CSSProperties } from "react";

/**
 * The number of a section or step on a sheet (業務の棚卸し, 実行結果, 変更の確認,
 * 手順書): a square with the number in its very middle, the same on every
 * sheet. Light: outlined, white inside. Dark: the other way round, filled with
 * the number in the sheet's colour.
 * `className` sets the size; `color` the line (light) and the fill (dark).
 */
export function SheetNumber({ n, className = "size-5 text-[11.5px]", color = "var(--color-ink)" }: { n: number; className?: string; color?: string }) {
  return (
    <span
      style={{ "--sheet-no": color } as CSSProperties}
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] border-[1.5px] pt-px border-(--sheet-no) bg-sheet leading-none font-semibold text-(--sheet-no) tabular-nums dark:bg-(--sheet-no) dark:text-sheet ${className}`}
    >
      {n}
    </span>
  );
}
