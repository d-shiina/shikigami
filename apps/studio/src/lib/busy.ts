// A button whose work takes a moment (a dialog, a save, a copy) does it once:
// a second click while the first is still going does nothing, and the
// button shows as off until it is done.
import { useCallback, useRef, useState } from "react";

/**
 * `[busy, once]`: `once(work)` runs `work` unless the last one is still
 * going (then it answers undefined at once). The check is on a ref, so two
 * clicks before React draws again still run it only once.
 */
export function useBusy(): [boolean, <T>(work: () => Promise<T>) => Promise<T | undefined>] {
  const going = useRef(false);
  const [busy, setBusy] = useState(false);
  const once = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    if (going.current) return undefined;
    going.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      going.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, once];
}
