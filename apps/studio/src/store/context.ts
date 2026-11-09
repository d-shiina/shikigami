// What every part of the store gets: the API, `set` / `get`, and the
// shared ways to apply an edit and to reload after a conflict.
import type { EditOutcome } from "@spellsheet/schema";
import type { StoreApi } from "zustand/vanilla";
import { type Api, ApiError } from "../lib/api";
import { t } from "../lib/i18n";
import type { StudioState } from "./index";

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function publishMessage(e: unknown): string {
  return e instanceof ApiError ? t.publishError(e.code, e.message) : message(e);
}

type Set = StoreApi<StudioState>["setState"];
type Get = () => StudioState;

export type StoreContext = ReturnType<typeof storeContext>;

export function storeContext(api: Api, set: Set, get: Get) {
  const applyOutcome = (outcome: EditOutcome) => {
    set({
      flow: outcome.flow,
      validation: outcome.validation,
      canUndo: outcome.canUndo,
      canRedo: outcome.canRedo,
      error: null,
    });
  };

  const reloadCurrent = async () => {
    const id = get().flow?.id;
    if (!id) return;
    const [flow, validation, undo] = await Promise.all([api.getFlow(id), api.validate(id), api.undoState(id)]);
    set({ flow, validation, canUndo: undo.canUndo, canRedo: undo.canRedo });
    await Promise.all([get().loadHistory(), get().loadCalled(), get().loadVersions()]);
  };

  /** Runs a mutation; on a revision conflict reloads and tells the user. */
  const mutate = async (fn: (id: string, revision: number) => Promise<EditOutcome>): Promise<boolean> => {
    const flow = get().flow;
    if (!flow) return false;
    try {
      applyOutcome(await fn(flow.id, flow.revision ?? 0));
      void get().refreshList();
      void get().loadHistory();
      void get().loadCalled();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "REVISION_CONFLICT") {
        await reloadCurrent();
        set({ notice: t.reloadedByConflict });
      } else {
        set({ error: message(e) });
      }
      return false;
    }
  };

  return { api, set, get, applyOutcome, reloadCurrent, mutate };
}
