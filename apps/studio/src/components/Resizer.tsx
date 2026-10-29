import { useRef, useState } from "react";
import { t } from "../lib/i18n";

/**
 * The grip on a panel's edge. It lies over the border line, a few pixels
 * wide so it is easy to catch, and shows a brand-coloured line on hover and
 * while dragging. Double-click puts the panel back to its default size.
 *
 * `edge` is the side of the panel the grip is on: a panel on the left of the
 * chart has its grip on its right edge, and dragging that edge right widens it.
 */
export function Resizer({
  edge,
  size,
  min,
  max,
  onSize,
  onReset,
}: {
  edge: "left" | "right" | "top";
  size: number;
  min: number;
  max: number;
  onSize: (size: number) => void;
  onReset: () => void;
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = edge === "top";
  // Moving toward the panel's inside shrinks it.
  const sign = edge === "right" ? 1 : -1;
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { at: vertical ? e.clientY : e.clientX, size };
    setDragging(true);
    document.body.style.cursor = vertical ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const moved = (vertical ? e.clientY : e.clientX) - start.current.at;
    onSize(clamp(start.current.size + sign * moved));
  };
  const end = () => {
    start.current = null;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = vertical ? "ArrowUp" : edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = vertical ? "ArrowDown" : edge === "right" ? "ArrowLeft" : "ArrowRight";
    const step = e.shiftKey ? 40 : 8;
    if (e.key === grow) onSize(clamp(size + step));
    else if (e.key === shrink) onSize(clamp(size - step));
    else return;
    e.preventDefault();
  };

  const place =
    edge === "top" ? "inset-x-0 -top-[3px] h-[6px] cursor-row-resize" : `inset-y-0 w-[6px] cursor-col-resize ${edge === "right" ? "-right-[3px]" : "-left-[3px]"}`;
  const line = vertical ? "inset-x-0 top-[2px] h-[2px]" : "inset-y-0 left-[2px] w-[2px]";
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={t.shell.resize}
      title={t.shell.resize}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={`group absolute z-20 touch-none focus:outline-none ${place}`}
    >
      <span
        className={`pointer-events-none absolute ${line} transition-colors ${dragging ? "bg-brand-500" : "bg-transparent delay-150 group-hover:bg-brand-500 group-focus-visible:bg-brand-500"}`}
      />
    </div>
  );
}
