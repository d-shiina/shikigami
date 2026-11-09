// Store actions for the list of flows: open, create, duplicate, delete, undo.
import { ApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { setFlowNames } from "../lib/sentence";
import { message, type StoreContext } from "./context";
import type { StudioState } from "./index";

export const flowsActions = ({ api, set, get, applyOutcome, mutate }: StoreContext) =>
  ({
    async refreshList() {
      try {
        const summaries = await api.listFlows();
        setFlowNames(new Map(summaries.map((s) => [s.id, s.name] as const)));
        set({ summaries });
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async open(id) {
      try {
        const [flow, validation, undo] = await Promise.all([api.getFlow(id), api.validate(id), api.undoState(id)]);
        set({
          // Opened from the library (or by the AI while it shows): show it in the editor.
          ...(get().place === "library" ? { place: "flows" as const } : {}),
          drafting: null,
          flow,
          validation,
          canUndo: undo.canUndo,
          canRedo: undo.canRedo,
          selection: null,
          editing: null,
          error: null,
          history: [],
          versions: [],
          published: null,
          called: {},
          dive: [],
        });
        await Promise.all([get().loadHistory(), get().loadVersions(), get().loadCalled()]);
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async create(name) {
      try {
        const outcome = await api.createFlow({ name });
        applyOutcome(outcome);
        set({ selection: null, history: [], versions: [] });
        void get().loadHistory();
        await get().refreshList();
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async duplicate(id) {
      try {
        const outcome = await api.duplicateFlow(id);
        applyOutcome(outcome);
        set({ history: [], versions: [] });
        void get().loadHistory();
        await get().refreshList();
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async remove(id) {
      try {
        const current = get().flow;
        await api.deleteFlow(id, current?.id === id ? current.revision : undefined);
        if (current?.id === id) set({ flow: null, validation: null, selection: null });
        await get().refreshList();
      } catch (e) {
        if (e instanceof ApiError && e.code === "FLOW_IN_USE") {
          const callers = ((e.details as { callers?: { name?: string }[] } | undefined)?.callers ?? []).map((c) => c.name ?? "");
          set({ error: t.inUse(callers) });
        } else {
          set({ error: message(e) });
        }
      }
    },

    applyOps: (ops) => mutate((id, rev) => api.edit(id, rev, ops)),
    undo: async () => void (await mutate((id, rev) => api.undo(id, rev))),
    redo: async () => void (await mutate((id, rev) => api.redo(id, rev))),
  }) satisfies Partial<StudioState>;
