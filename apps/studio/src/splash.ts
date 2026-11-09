// The start-up screen's words (splash.html). Kept apart from the app's
// bundle so the screen shows at once: only the fonts and three strings.
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-sans-jp";
import { splashText } from "./lib/splashText";

const text = splashText(
  (() => {
    try {
      return globalThis.localStorage?.getItem("shikigami.studio.locale");
    } catch {
      return null;
    }
  })(),
  globalThis.navigator?.language,
  new URLSearchParams(location.search).get("v"),
);
document.documentElement.lang = text.lang;
const set = (id: string, value: string) => {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
};
set("tagline", text.tagline);
set("status", text.status);
set("version", text.version);
// Nothing on it to use: no right-click menu either.
document.addEventListener("contextmenu", (e) => e.preventDefault());
