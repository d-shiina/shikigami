/**
 * The number of a section or step on a sheet (業務の棚卸し, 実行結果, 変更の確認,
 * 手順書): a square outline with the number in its very middle, the same on
 * every sheet. Only the line and the number are drawn, in the text colour
 * (black, or white in dark), with nothing filled behind them.
 * `className` sets the size.
 */
export function SheetNumber({ n, className = "size-5 text-[11.5px]" }: { n: number; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-[5px] border-[1.5px] border-ink leading-none font-semibold text-ink ${className}`}>
      {/* Trimmed to the digits' own height (cap height to baseline), so the box centres the ink, not the line with its room for accents and descenders. */}
      <span className="[text-box:trim-both_cap_alphabetic]">{n}</span>
    </span>
  );
}
