// Studio draws its own title bar (the window has no decorations): the top bar
// drags the window, double-click maximizes, and these are the caption buttons.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { t } from "../lib/i18n";

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

// Sized and coloured like Windows 11's own caption buttons: 46px wide, the
// bar's full height, 10px glyphs drawn with 1px lines, a faint see-through
// fill on hover (so it suits either theme) and red for Close. The row sits
// flush with the window's right edge, so Close's hover reaches the corner.
const BUTTON =
  "grid h-full w-[46px] place-items-center text-ink transition-colors duration-100 hover:bg-black/[0.06] active:bg-black/[0.04] dark:hover:bg-white/[0.08] dark:active:bg-white/[0.05]";
const CLOSE = "hover:bg-[#c42b1c]! hover:text-white! active:bg-[#c42b1c]/90! dark:active:bg-[#c42b1c]/90!";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!inTauri()) return;
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized, () => {});
    sync();
    const off = win.onResized(sync);
    return () => void off.then((f) => f(), () => {});
  }, []);
  if (!inTauri()) return null;
  const win = getCurrentWindow();
  return (
    <div className="flex shrink-0 self-stretch">
      <button type="button" title={t.window.minimize} className={BUTTON} onClick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" shapeRendering="crispEdges" />
        </svg>
      </button>
      <button type="button" title={maximized ? t.window.restore : t.window.maximize} className={BUTTON} onClick={() => void win.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          {maximized ? (
            <>
              <rect x=".5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
              <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
            </>
          ) : (
            <rect x=".5" y=".5" width="9" height="9" rx="1" stroke="currentColor" />
          )}
        </svg>
      </button>
      <button type="button" title={t.close} className={`${BUTTON} ${CLOSE}`} onClick={() => void win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
