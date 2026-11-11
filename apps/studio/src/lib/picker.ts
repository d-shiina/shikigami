// The file and folder dialogs behind every 「参照…」 button (runner_pick in
// src-tauri/src/runner.rs). The dialog is a process of its own, not modal to
// Writer's window, so a second click on 「参照…」 opened a second dialog, and
// a third. One dialog at a time: while one is open — opened here, or in the
// other window (Writer or Runner) — every 「参照…」 button is off and
// pickPath answers null without opening another.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";

/** A dialog this window opened, from the click until it closes. */
let here = false;
/** A dialog open in any window, as the backend tells (`picker-open`). */
let anywhere = false;
let listening = false;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** Whether a file or folder dialog is open now. */
export const pickerOpen = () => here || anywhere;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Follows the dialogs the other window opens (once per window, in Tauri only). */
function follow() {
  if (listening || !("__TAURI_INTERNALS__" in globalThis)) return;
  listening = true;
  // Events seen so far: a snapshot asked before one of them is older than it.
  let seen = 0;
  listen<boolean>("picker-open", (e) => {
    seen++;
    anywhere = e.payload === true;
    notify();
  })
    // Only once listening: a dialog closing between the snapshot and the
    // listener would otherwise leave every 「参照…」 off for good.
    .then(() => {
      const before = seen;
      // A window opened while a dialog is open.
      return invoke<boolean>("picker_open").then((open) => {
        if (seen !== before) return;
        anywhere = open === true;
        notify();
      });
    })
    .catch(() => {});
}

/**
 * The file or folder dialog, opening at `start` (a folder, or a file whose
 * folder to open). The picked path, or null when cancelled, when it failed,
 * or when a dialog is open already.
 */
export async function pickPath(kind: "file" | "folder", start?: string | null): Promise<string | null> {
  if (pickerOpen()) return null;
  // Off before the call goes out: a second click in the same moment finds it on.
  here = true;
  notify();
  try {
    return await invoke<string | null>("runner_pick", { kind, start: start || null });
  } catch {
    return null;
  } finally {
    here = false;
    notify();
  }
}

/** Whether a file or folder dialog is open: a 「参照…」 button is off while it is. */
export function usePickerOpen(): boolean {
  useEffect(follow, []);
  return useSyncExternalStore(subscribe, pickerOpen);
}

/** Tests: forget any dialog. */
export function resetPicker() {
  here = false;
  anywhere = false;
  notify();
}
