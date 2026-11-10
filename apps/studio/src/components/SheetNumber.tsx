/**
 * The number of a section or step on a sheet (業務の棚卸し, 実行結果, 変更の確認,
 * 手順書): two digits in the accent colour, no filled box, so the headings
 * read as one family across the sheets.
 */
export function SheetNumber({ n, className = "text-brand-600" }: { n: number; className?: string }) {
  return <span className={`shrink-0 font-semibold tracking-wider tabular-nums ${className}`}>{String(n).padStart(2, "0")}</span>;
}
