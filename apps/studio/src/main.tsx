// First: settings saved under the old name move before anything reads them.
import "./lib/legacyStorage";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ImageViewerHost } from "./components/ImageViewer";
import { RunBand } from "./runband/RunBand";
import { Runner } from "./runner/Runner";
// Bundled so Japanese never falls back to Chinese glyph shapes, offline too.
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-sans-jp";
import "./index.css";
import { initLocale, onLocaleChange, t } from "./lib/i18n";
import { initTheme } from "./lib/theme";
import { setTrayLabels } from "./runner/api";

initTheme();
initLocale();
// The tray menu (src-tauri/src/tray.rs) speaks the language the screens do.
const trayLabels = () => void setTrayLabels(t.tray).catch(() => {});
if ("__TAURI_INTERNALS__" in globalThis) {
  trayLabels();
  onLocaleChange(trayLabels);
}

const view = new URLSearchParams(location.search).get("view");
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      {/* The run window (src-tauri/src/runner.rs) and the run band (run_band.rs) are the same app on other pages. */}
      {view === "runner" ? <Runner /> : view === "band" ? <RunBand /> : <App />}
      <ImageViewerHost />
    </StrictMode>,
  );
}
