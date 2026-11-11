// What Writer remembers between sessions in local storage (folded
// groups, breakpoints, reviewed changes, panel states).

export const REVIEWED_KEY = "spellsheet.studio.reviewed";

export const BREAKPOINTS_KEY = "spellsheet.studio.breakpoints";

export function loadBreakpoints(): Record<string, string[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(BREAKPOINTS_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

export const FOLDED_KEY = "spellsheet.studio.folded";

export function loadFolded(): Record<string, string[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(FOLDED_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

export function saveFolded(folded: Record<string, string[]>) {
  try {
    globalThis.localStorage?.setItem(FOLDED_KEY, JSON.stringify(folded));
  } catch {
    // Only how the chart is shown on this PC.
  }
}

export function saveBreakpoints(breakpoints: Record<string, string[]>) {
  try {
    globalThis.localStorage?.setItem(BREAKPOINTS_KEY, JSON.stringify(breakpoints));
  } catch {
    // Breakpoints are a convenience on this PC.
  }
}


export function loadReviewed(): Record<string, number[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(REVIEWED_KEY) ?? "{}") as Record<string, number[]>;
  } catch {
    return {};
  }
}

export function saveReviewed(reviewed: Record<string, number[]>) {
  try {
    globalThis.localStorage?.setItem(REVIEWED_KEY, JSON.stringify(reviewed));
  } catch {
    // Review marks are a convenience; losing them only re-shows the cards.
  }
}
