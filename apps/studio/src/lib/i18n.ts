// The display language: Japanese or English, or follow the OS. Components read
// strings from `t`, a live binding that switches with the language; Studio
// re-mounts its shell on a switch so everything on screen is redrawn
// (unsent input kept with useKeptState).
import { type Dispatch, type SetStateAction, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { en } from "./locales/en";
import { type Dict, ja } from "./locales/ja";

export type { Dict };
export type Locale = "ja" | "en";
export type LocaleChoice = "system" | Locale;

const KEY = "shikigami.studio.locale";
const DICTS: Record<Locale, Dict> = { ja, en };
const listeners = new Set<() => void>();

function stored(): LocaleChoice {
  try {
    const value = globalThis.localStorage?.getItem(KEY);
    return value === "ja" || value === "en" ? value : "system";
  } catch {
    return "system";
  }
}

/** The OS language: Japanese when it is Japanese, English otherwise. */
function system(): Locale {
  const lang = globalThis.navigator?.language ?? "ja";
  return lang.toLowerCase().startsWith("ja") ? "ja" : "en";
}

let choice: LocaleChoice = stored();
export let locale: Locale = choice === "system" ? system() : choice;
export let t: Dict = DICTS[locale];

function apply() {
  locale = choice === "system" ? system() : choice;
  t = DICTS[locale];
  const root = globalThis.document?.documentElement;
  if (root) root.lang = locale;
  for (const l of listeners) l();
}

/** Applies the saved choice. Call once, before the first render. */
export function initLocale() {
  apply();
}

export function setLocale(next: LocaleChoice, remember = true) {
  choice = next;
  if (remember) {
    try {
      globalThis.localStorage?.setItem(KEY, next);
    } catch {
      // Only a remembered preference.
    }
  }
  apply();
}

export function useLocale(): { choice: LocaleChoice; locale: Locale } {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => `${choice}:${locale}`,
  );
  const [c, l] = value.split(":") as [LocaleChoice, Locale];
  return { choice: c, locale: l };
}

/**
 * A step type's name in the current language. The registry (Rust, plugins)
 * names steps in Japanese; English names live in the dictionary and fall
 * back to the registry's label for types it does not know.
 */
export function stepLabel(type: string, label?: string): string {
  if (locale === "ja") return label ?? type;
  return (t.stepTypes as Record<string, string>)[type] ?? label ?? type;
}

/** A block's name (then / else / body …) in the current language. */
export function blockName(type: string, block: string, label: string): string {
  if (locale === "ja") return label;
  return (t.blockNames as Record<string, string>)[`${type}:${block}`] ?? (t.blockNames as Record<string, string>)[block] ?? label;
}

const kept = new Map<string, unknown>();

/**
 * useState for unsent input (a message to the AI, a send-back reason) that
 * survives the shell re-mount on a language switch. On any other unmount the
 * value is dropped as usual.
 */
export function useKeptState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  // The new shell renders before the old one's effects are cleaned up, so the
  // value is recorded as it changes rather than on unmount.
  const [value, setValue] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial));
  const mountedIn = useRef(locale);
  useEffect(() => {
    kept.set(key, value);
  }, [key, value]);
  useEffect(
    () => () => {
      if (locale === mountedIn.current) kept.delete(key);
    },
    [key],
  );
  return [value, setValue];
}
