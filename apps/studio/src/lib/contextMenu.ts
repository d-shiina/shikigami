// Studio's own right-click menu. The browser's menu (back, reload, print,
// inspect…) means nothing in a desktop app, so it never shows: each place
// that has something to offer opens its own menu, text fields get cut / copy
// / paste, selected text gets copy, and everywhere else nothing opens.
// In a dev build, Shift + right-click still opens the browser's menu (with
// "Inspect"); F12 / Ctrl+Shift+I open the developer tools as before.
import { ClipboardPaste, Copy, type LucideIcon, Scissors, TextSelect } from "lucide-react";
import { createStore } from "zustand/vanilla";
import { t } from "./i18n";

export type MenuItem = {
  label: string;
  icon?: LucideIcon;
  /** Shown on the right, like the key the same action has elsewhere. */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Asks once more: the first press shows this label instead of running. */
  confirm?: string;
  run: () => void;
};

export type MenuEntry = MenuItem | "-";

/** An entry, or a falsy value for one left out where it does not apply. */
export type MenuSpec = MenuEntry | false | null | undefined | "";

export type OpenMenu = { x: number; y: number; items: MenuEntry[] };

export const menuStore = createStore<{ menu: OpenMenu | null }>(() => ({ menu: null }));

export const closeMenu = () => menuStore.setState({ menu: null });

/** Drops what is left out, and separators at either end or twice in a row. */
export function tidy(entries: readonly MenuSpec[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "-" && (out.length === 0 || out.at(-1) === "-")) continue;
    out.push(entry);
  }
  while (out.at(-1) === "-") out.pop();
  return out;
}

type PointerLike = { clientX: number; clientY: number; preventDefault(): void };

/** Opens a menu at the pointer, in place of the browser's. */
export function openMenu(e: PointerLike, entries: readonly MenuSpec[]) {
  e.preventDefault();
  const items = tidy(entries);
  menuStore.setState({ menu: items.length > 0 ? { x: e.clientX, y: e.clientY, items } : null });
}

const DEV = Boolean(import.meta.env?.DEV);

/** Dev builds keep the browser's menu on Shift + right-click, for "Inspect". */
export const wantsBrowserMenu = (e: { shiftKey: boolean }, dev = DEV) => dev && e.shiftKey;

const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

export type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/** The text field the pointer is in, if any. */
export function fieldOf(target: EventTarget | null): Field | null {
  const el = typeof Element !== "undefined" && target instanceof Element ? target : null;
  if (!el) return null;
  const input = el.closest("input, textarea, [contenteditable]:not([contenteditable=false])");
  if (!input) return null;
  if (input instanceof HTMLInputElement && !TEXT_INPUTS.has(input.type)) return null;
  return input as Field;
}

/**
 * A React onContextMenu handler for a place: builds its menu at the moment of
 * the click. Text fields inside the place keep their own text menu.
 */
export function menuFor(build: () => readonly MenuSpec[]) {
  return (e: PointerLike & { target: EventTarget | null; shiftKey: boolean; stopPropagation(): void }) => {
    if (wantsBrowserMenu(e) || fieldOf(e.target)) return;
    e.stopPropagation();
    openMenu(e, build());
  };
}

function hasSelection(field: Field): boolean {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    try {
      return (field.selectionStart ?? 0) !== (field.selectionEnd ?? 0);
    } catch {
      // number inputs have no selection range.
      return false;
    }
  }
  return Boolean(window.getSelection()?.toString());
}

function readOnly(field: Field): boolean {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) return field.readOnly || field.disabled;
  return !field.isContentEditable;
}

async function paste(field: Field) {
  field.focus();
  try {
    const text = await navigator.clipboard.readText();
    // insertText keeps the field's own undo and fires its input event.
    if (!document.execCommand("insertText", false, text)) throw new Error("insertText");
  } catch {
    document.execCommand("paste");
  }
}

/** Cut, copy, paste and select all, for a text field. */
export function textMenu(field: Field): MenuEntry[] {
  const selected = hasSelection(field);
  const locked = readOnly(field);
  const run = (command: string) => () => {
    field.focus();
    document.execCommand(command);
  };
  return [
    { label: t.menu.cut, icon: Scissors, shortcut: "Ctrl+X", disabled: locked || !selected, run: run("cut") },
    { label: t.menu.copy, icon: Copy, shortcut: "Ctrl+C", disabled: !selected, run: run("copy") },
    { label: t.menu.paste, icon: ClipboardPaste, shortcut: "Ctrl+V", disabled: locked, run: () => void paste(field) },
    "-",
    { label: t.menu.selectAll, icon: TextSelect, shortcut: "Ctrl+A", run: run("selectAll") },
  ];
}

/**
 * The window's right-click: places that opened their own menu have already
 * taken it; text fields and selected text get theirs; elsewhere nothing opens.
 */
export function onWindowContextMenu(e: MouseEvent, dev = DEV) {
  if (e.defaultPrevented || wantsBrowserMenu(e, dev)) return;
  const field = fieldOf(e.target);
  if (field) return openMenu(e, textMenu(field));
  const selected = window.getSelection()?.toString() ?? "";
  if (selected) {
    return openMenu(e, [{ label: t.menu.copy, icon: Copy, shortcut: "Ctrl+C", run: () => void navigator.clipboard.writeText(selected) }]);
  }
  e.preventDefault();
  closeMenu();
}

/** Replaces the browser's menu for the whole window. Returns the undo. */
export function installContextMenu(): () => void {
  const handler = (e: MouseEvent) => onWindowContextMenu(e);
  window.addEventListener("contextmenu", handler);
  return () => window.removeEventListener("contextmenu", handler);
}

export const copyText = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
