// Store actions for selection, navigation and which panels are open.
import { neighbor, outline } from "../lib/outline";
import { summarize } from "../lib/review";
import type { StoreContext } from "./context";
import type { StudioState } from "./index";
import { pendingReview } from "./history";
import { INSPECTOR_KEY, saveFlag } from "./persist";
import { callKey, diveChain } from "./run";

export const uiActions = ({ set, get }: StoreContext) =>
  ({
    // Picking a step of the open flow brings the chart back up to it.
    select(selection) {
      set(selection ? { selection, range: null, dive: [], extractOpen: false, extractName: "" } : { selection, range: null, extractOpen: false, extractName: "" });
    },

    goTo(stepId) {
      get().unfoldTo(stepId);
      set({ selection: { kind: "step", stepId }, range: null, reveal: { stepId, seq: (get().reveal?.seq ?? 0) + 1 }, dive: [] });
    },

    goToPlace({ path, stepId }) {
      const { flow, called } = get();
      if (path.length === 0) return get().goTo(stepId);
      // A call the chart can no longer open: show the call step instead.
      if (diveChain(flow, called, path).length !== path.length) return get().goTo(path[0]!);
      // Folded frames around it in the called flow open, as `goTo` does in the open flow.
      get().unfoldTo(stepId, diveChain(flow, called, path).at(-1)!.flow);
      set({ dive: path, selection: null, range: null, reveal: { stepId, seq: (get().reveal?.seq ?? 0) + 1, inside: callKey(path) } });
    },

    stepBy(delta) {
      const { flow, stepTypes, selection } = get();
      const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
      const ids = outline(flow?.steps ?? [], defs).map((i) => i.id);
      const next = neighbor(ids, selection?.kind === "step" ? selection.stepId : null, delta);
      if (next) get().goTo(next);
    },

    changeBy(delta) {
      const { flow, stepTypes, selection } = get();
      const defs = new Map(stepTypes.map((d) => [d.type, d] as const));
      const changed = summarize([...pendingReview(get())].reverse(), flow?.steps).steps;
      const all = outline(flow?.steps ?? [], defs).map((i) => i.id);
      const current = selection?.kind === "step" ? selection.stepId : null;
      const at = current ? all.indexOf(current) : -1;
      // The nearest changed step in that direction from wherever the selection is.
      const ahead = at < 0 ? (delta > 0 ? all : [...all].reverse()) : delta > 0 ? all.slice(at + 1) : all.slice(0, at).reverse();
      const next = ahead.find((id) => changed.has(id));
      if (next) get().goTo(next);
    },

    setFollowRun(on) {
      set({ followRun: on });
    },


    setInspectorOpen(open) {
      saveFlag(INSPECTOR_KEY, open);
      // Closing puts the selection down too, or the pane would stay for it.
      set(open ? { inspectorOpen: true } : { inspectorOpen: false, selection: null, range: null });
    },

    showFlowProps() {
      saveFlag(INSPECTOR_KEY, true);
      set({ inspectorOpen: true, selection: null, range: null, extractOpen: false, extractName: "" });
    },

    setPlace(place) {
      set({ place, drafting: null, reviewing: place === "review", secretsOpen: place === "secrets", historyOpen: false });
      if (place === "secrets") void get().loadSecrets();
      else set({ secretPrefill: null });
    },

    showDrafting(drafting) {
      if (!drafting) {
        if (get().drafting) set({ drafting: null, ...(get().place === "flows" && !get().flow ? { place: "library" as const } : {}) });
        return;
      }
      // The flow open before is saved as it is edited, so nothing is lost by putting it down.
      set({ drafting, place: "flows", flow: null, validation: null, selection: null, range: null, editing: null, reviewing: false, secretsOpen: false, historyOpen: false, dive: [] });
    },

    setBottom(tab) {
      set({ bottom: tab });
    },

    setHistoryOpen(open, tab = "timeline") {
      set({ historyOpen: open, historyTab: tab });
    },

    setReviewing(on) {
      set({ reviewing: on, place: on ? "review" : "flows", secretsOpen: false });
    },

    setSearchOpen(open) {
      set((s) => ({ searchOpen: open, searchAsked: open ? s.searchAsked + 1 : s.searchAsked }));
    },

    setPaletteOpen(open, at, anchor) {
      // Steps are added to the open flow: show it.
      set(
        open
          ? { paletteOpen: true, paletteAt: at ?? null, paletteAnchor: anchor ?? null, dive: [] }
          : { paletteOpen: false, paletteAt: null, paletteAnchor: null },
      );
    },
  }) satisfies Partial<StudioState>;
