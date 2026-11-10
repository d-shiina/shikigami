import { useId } from "react";

/**
 * A sheet's heading with a highlighter stroke drawn under it: barely
 * slanted, its edges a little uneven as a real marker leaves them. Only the stroke
 * is drawn; the words keep their own colour.
 */
export function Highlight({ children }: { children: React.ReactNode }) {
  const id = useId().replace(/:/g, "");
  return (
    <span className="relative inline-block">
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <filter id={`marker-${id}`} x="-10%" y="-30%" width="120%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.08 0.6" numOctaves="2" seed="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.2" />
        </filter>
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-x-[-3px] bottom-[1px] h-[0.55em] -skew-x-3 rounded-[2px] bg-(--sheet-marker)"
        style={{ filter: `url(#marker-${id})` }}
      />
      <span className="relative">{children}</span>
    </span>
  );
}
