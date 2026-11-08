import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ImageViewerHost } from "./components/ImageViewer";
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

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      {/* The run window (src-tauri/src/runner.rs) is the same app on another page. */}
      {new URLSearchParams(location.search).get("view") === "runner" ? <Runner /> : <App />}
      <ImageViewerHost />
    </StrictMode>,
  );
}
