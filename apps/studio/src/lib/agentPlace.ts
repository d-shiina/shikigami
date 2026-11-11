// Where asking the AI sits: under the work (the field under the paper) or in a column on the right.
// A remembered preference of this PC, chosen in the settings.
import { useSyncExternalStore } from "react";

export type AgentPlace = "below" | "right";

const KEY = "spellsheet.studio.agentPlace";
const listeners = new Set<() => void>();

function stored(): AgentPlace {
  try {
    return globalThis.localStorage?.getItem(KEY) === "right" ? "right" : "below";
  } catch {
    return "below";
  }
}

let place: AgentPlace = stored();

export function setAgentPlace(next: AgentPlace) {
  place = next;
  try {
    globalThis.localStorage?.setItem(KEY, next);
  } catch {
    // Only a remembered preference.
  }
  for (const l of listeners) l();
}

export function useAgentPlace(): AgentPlace {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => place,
  );
}
