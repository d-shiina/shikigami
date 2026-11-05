import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Bundled so Japanese never falls back to Chinese glyph shapes, offline too.
import "@fontsource-variable/noto-sans-jp";
import "./index.css";
import { initLocale } from "./lib/i18n";
import { initTheme } from "./lib/theme";

initTheme();
initLocale();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
