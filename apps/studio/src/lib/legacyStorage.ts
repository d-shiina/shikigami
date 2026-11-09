// Writer kept its screen settings (theme, language, recent flows, column
// widths, AI chats…) in this storage under the product's old name. They move
// to the new keys once, before anything reads them: this module is imported
// first (main.tsx, splash.ts).

/** The product's name before SpellSheet, as written in keys and formats. */
export const LEGACY_NAME = "shikigami";

/** The keys' prefix under the old name. */
export const LEGACY_PREFIX = `${LEGACY_NAME}.studio.`;
export const PREFIX = "spellsheet.studio.";

export function moveLegacyStorage(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    if (!storage) return;
    const old: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(LEGACY_PREFIX)) old.push(key);
    }
    for (const key of old) {
      const moved = PREFIX + key.slice(LEGACY_PREFIX.length);
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(moved) === null) storage.setItem(moved, value);
      storage.removeItem(key);
    }
  } catch {
    // Storage unavailable (private window, tests): nothing to move.
  }
}

/** `format` is `current` (`spellsheet.config`), or how files saved before the rename spell it. */
export function isFormat(format: unknown, current: string): boolean {
  return format === current || format === current.replace("spellsheet", LEGACY_NAME);
}

moveLegacyStorage();
