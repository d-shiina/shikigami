// The one right-click menu of the window (lib/contextMenu.ts): a lifted
// sheet (8dp) at the pointer, kept inside the window. Focus stays where it
// was, so a text field keeps its selection for cut / copy / paste; the keys
// ↑ ↓ Enter Esc still work while the menu is open.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { closeMenu, type MenuItem, menuStore } from "../lib/contextMenu";

const EDGE = 6;

export function ContextMenu() {
  const menu = useStore(menuStore, (s) => s.menu);
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  const [armed, setArmed] = useState(-1);

  // Inside the window: flipped to the left / above the pointer when it would run off.
  useLayoutEffect(() => {
    setActive(-1);
    setArmed(-1);
    if (!menu || !box.current) return setAt(null);
    const { width, height } = box.current.getBoundingClientRect();
    const left = menu.x + width + EDGE > window.innerWidth ? Math.max(EDGE, menu.x - width) : menu.x;
    const top = menu.y + height + EDGE > window.innerHeight ? Math.max(EDGE, window.innerHeight - height - EDGE) : menu.y;
    setAt({ left, top });
  }, [menu]);

  const items = menu?.items ?? [];
  const press = (i: number) => {
    const item = items[i];
    if (!item || item === "-" || item.disabled) return;
    if (item.confirm && armed !== i) return setArmed(i);
    closeMenu();
    item.run();
  };

  useLayoutEffect(() => {
    if (!menu) return;
    const usable = items.flatMap((item, i) => (item !== "-" && !item.disabled ? [i] : []));
    const onKey = (e: KeyboardEvent) => {
      const move = (delta: number) => {
        const at = usable.indexOf(active);
        const next = at < 0 ? (delta > 0 ? 0 : usable.length - 1) : (at + delta + usable.length) % usable.length;
        setActive(usable[next] ?? -1);
      };
      if (e.key === "Escape") closeMenu();
      else if (e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowUp") move(-1);
      else if (e.key === "Home") setActive(usable[0] ?? -1);
      else if (e.key === "End") setActive(usable.at(-1) ?? -1);
      else if (e.key === "Enter" && active >= 0) press(active);
      else {
        closeMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) closeMenu();
    };
    const close = () => closeMenu();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  });

  if (!menu) return null;
  return createPortal(
    <div
      ref={box}
      role="menu"
      data-context-menu
      // Keeps focus (and a text field's selection) where it was.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      style={at ?? { left: menu.x, top: menu.y, visibility: "hidden" }}
      className="fixed z-[100] min-w-[208px] max-w-[320px] rounded-lg border border-slate-200 bg-sheet py-1 text-[12.5px] shadow-lifted select-none"
    >
      {items.map((item, i) =>
        item === "-" ? (
          <div key={i} role="separator" className="my-1 border-t border-slate-200" />
        ) : (
          <Row key={i} item={item} active={active === i} armed={armed === i} onHover={() => setActive(item.disabled ? -1 : i)} onPress={() => press(i)} />
        ),
      )}
    </div>,
    document.body,
  );
}

function Row({ item, active, armed, onHover, onPress }: { item: MenuItem; active: boolean; armed: boolean; onHover: () => void; onPress: () => void }) {
  const Icon = item.icon;
  const tone = item.disabled ? "text-slate-400" : item.danger || armed ? "text-shu-600" : "text-ink";
  const bg = item.disabled ? "" : armed ? "bg-shu-50" : active ? (item.danger ? "bg-shu-50" : "bg-slate-100") : "";
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onMouseEnter={onHover}
      onClick={onPress}
      className={`flex h-7 w-full items-center gap-2 px-2.5 text-left ${tone} ${bg}`}
    >
      <span className="grid w-4 shrink-0 place-items-center">{Icon && <Icon size={14} strokeWidth={1.75} aria-hidden="true" />}</span>
      <span className="min-w-0 flex-1 truncate">{armed && item.confirm ? item.confirm : item.label}</span>
      {item.shortcut && <span className="shrink-0 pl-4 text-[11px] text-slate-500">{item.shortcut}</span>}
    </button>
  );
}
