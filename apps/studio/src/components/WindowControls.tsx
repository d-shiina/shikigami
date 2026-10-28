// Studio draws its own title bar (the window has no decorations): the top bar
// drags the window, double-click maximizes, and these are the caption buttons.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { t } from "../lib/i18n";

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

const BUTTON = "grid h-10 w-11 place-items-center text-slate-500 hover:bg-slate-100 hover:text-ink";

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
    <div className="-mr-3 flex self-stretch">
      <button type="button" title={t.window.minimize} className={BUTTON} onClick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button type="button" title={maximized ? t.window.restore : t.window.maximize} className={BUTTON} onClick={() => void win.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          {maximized ? (
            <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" stroke="currentColor" />
          ) : (
            <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" />
          )}
        </svg>
      </button>
      <button type="button" title={t.close} className={`${BUTTON} hover:bg-[#c42b1c]! hover:text-white!`} onClick={() => void win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
