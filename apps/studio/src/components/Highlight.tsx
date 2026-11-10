/** Where a highlighter is used: as usual, or on what the person has to answer. */
export type HighlightTone = "plain" | "check";

const BAND: Record<HighlightTone, string> = { plain: "bg-(--sheet-marker)", check: "bg-(--sheet-marker-check)" };

/**
 * A sheet's heading with a highlighter band under its lower half: a plain
 * band, straight and even, in a soft colour that changes with what the
 * section asks of the person. Only the band is drawn; the words keep their
 * own colour.
 */
export function Highlight({ tone = "plain", children }: { tone?: HighlightTone; children: React.ReactNode }) {
  return (
    <span className="relative inline-block">
      <span aria-hidden="true" className={`absolute inset-x-[-2px] bottom-[1px] h-[0.5em] rounded-[1px] ${BAND[tone]}`} />
      <span className="relative">{children}</span>
    </span>
  );
}
