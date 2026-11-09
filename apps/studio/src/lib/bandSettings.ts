// 設定 › 実行: whether Writer steps aside for a run that works on the screen
// (src-tauri/src/run_band.rs). Kept on this PC, sent with each run.

export type BandSettings = {
  /** Minimise Writer and show the run band. */
  shrink: boolean;
  /** Bring Writer back when the run ends. */
  restoreAtEnd: boolean;
};

const KEY = "shikigami.studio.runBand";
export const BAND_DEFAULTS: BandSettings = { shrink: true, restoreAtEnd: true };

export function loadBandSettings(): BandSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return BAND_DEFAULTS;
    const read = JSON.parse(raw) as Partial<BandSettings>;
    return {
      shrink: typeof read.shrink === "boolean" ? read.shrink : BAND_DEFAULTS.shrink,
      restoreAtEnd: typeof read.restoreAtEnd === "boolean" ? read.restoreAtEnd : BAND_DEFAULTS.restoreAtEnd,
    };
  } catch {
    return BAND_DEFAULTS;
  }
}

export function saveBandSettings(settings: BandSettings): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Only this PC's choice: the defaults stand.
  }
}
