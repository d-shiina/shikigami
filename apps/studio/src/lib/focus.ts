// What the pointer is on: a step id, or `var:<name>` for a variable. Kept
// outside React state so hovering only re-renders the parts that light up:
// re-rendering the whole canvas mid-click swallowed the click that selects a
// step.
import { useSyncExternalStore } from "react";

let current: string | null = null;
const listeners = new Set<() => void>();

export const focus = {
  set(next: string | null) {
    if (next === current) return;
    current = next;
    for (const l of listeners) l();
  },
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Focus key for a whole variable, as opposed to a step id. */
export const varFocus = (name: string) => `var:${name}`;

export const useFocus = () => useSyncExternalStore(focus.subscribe, focus.get);
