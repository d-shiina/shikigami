// Reading the clipboard for Studio's paste. In WebView2,
// navigator.clipboard.readText first asks the person "tauri.localhost wants
// to see text and images copied to the clipboard", which looks alarming in a
// desktop app, so inside Studio the text comes from Windows instead. The
// browser API is kept only for the plain-browser dev page.
import { api } from "./api";

export function readClipboardText(): Promise<string> {
  if ("__TAURI_INTERNALS__" in globalThis) return api.readClipboardText();
  return navigator.clipboard.readText();
}
