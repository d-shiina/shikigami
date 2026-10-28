import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { StudioState } from "./store";

export const StudioContext = createContext<StoreApi<StudioState> | null>(null);

export function useStudio<T>(selector: (state: StudioState) => T): T {
  const store = useContext(StudioContext);
  if (!store) throw new Error("StudioContext is missing");
  return useStore(store, selector);
}
