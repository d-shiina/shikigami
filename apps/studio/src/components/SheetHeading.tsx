import { Highlight, type HighlightTone } from "./Highlight";
import { SheetNumber } from "./SheetNumber";

/**
 * The headings every sheet (業務の棚卸し, 実行結果, 変更の確認, 手順書) is made of,
 * so the four read as one set:
 * - a section (or a 手順書 chapter): its number in an outlined square, the
 *   words in the text colour with a highlighter band under them, the band's
 *   colour saying what the section asks of the person;
 * - a heading inside a section: smaller, a short line before it, no band.
 * Colour is only ever in the band; the number and the words stay black (white
 * in dark), so the words never sit on a band of their own hue.
 */
export function SheetHeading({
  n,
  tone = "plain",
  size = "section",
  aside,
  children,
}: {
  n?: number;
  tone?: HighlightTone;
  size?: "section" | "chapter";
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const chapter = size === "chapter";
  return (
    <span className={`flex min-w-0 items-center text-ink ${chapter ? "gap-3 text-[19px] font-semibold" : "gap-2 text-[15px] font-bold"}`}>
      {n !== undefined && <SheetNumber n={n} className={chapter ? "size-[26px] text-[14px]" : "size-5 text-[11.5px]"} />}
      <Highlight tone={tone}>{children}</Highlight>
      {aside && <span className="ml-auto text-[12px] font-normal text-slate-500">{aside}</span>}
    </span>
  );
}

/** A heading inside a section of a sheet. */
export function SheetSubheading({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={`flex items-center gap-2 text-[13px] font-semibold text-ink ${className}`}>
      <span aria-hidden="true" className="h-[2px] w-3 shrink-0 rounded-full bg-slate-400" />
      {children}
    </span>
  );
}
