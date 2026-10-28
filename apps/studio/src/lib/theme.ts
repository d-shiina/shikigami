// Light / dark / follow the OS. The choice is applied as `data-theme` on
// <html>, where index.css swaps the colour tokens.
import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "shikigami.studio.theme";
const media = () => globalThis.matchMedia?.("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): ThemeChoice {
  try {
    const value = globalThis.localStorage?.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = stored();

export function resolved(c: ThemeChoice = choice): "light" | "dark" {
  return c === "system" ? (media()?.matches ? "dark" : "light") : c;
}

function apply() {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.dataset.theme = resolved();
  root.style.colorScheme = resolved();
  for (const l of listeners) l();
}

/** Applies the saved choice and follows OS changes while it is "system". Call once, before the first render. */
export function initTheme() {
  apply();
  media()?.addEventListener("change", () => choice === "system" && apply());
}

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch {
    // Only a remembered preference.
  }
  apply();
}

export function useTheme(): { choice: ThemeChoice; mode: "light" | "dark" } {
  const mode = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => `${choice}:${resolved()}`,
  );
  const [c, m] = mode.split(":") as [ThemeChoice, "light" | "dark"];
  return { choice: c, mode: m };
}
