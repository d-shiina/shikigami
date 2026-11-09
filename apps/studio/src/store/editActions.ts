// Store actions that edit the open flow: nodes, variables, copy and paste,
// sub-flows, and folding.
import { unsetParams } from "../lib/nodeRows";
import type { EditOp, Flow, Step } from "@spellsheet/schema";
import { ApiError } from "../lib/api";
import { CASE, FOR_EACH, SWITCH } from "../lib/stepTypes";
import { boxRange, copyText, partOps, readCopied, siblingRange, withNewIds } from "../lib/stepClipboard";
import { t } from "../lib/i18n";
import { resultName } from "../lib/resultName";
import { readClipboardText } from "../lib/clipboard";
import { focusFirstSetting } from "../lib/focusSetting";
import { message, type StoreContext } from "./context";
import type { StudioState } from "./index";
import { diveChain, calledIds } from "./run";
import { locate, insertPlace, findStep, DEFAULT_PARAMS, selectedIds, newCase, WRAP_BLOCK, newStepId } from "./steps";

export const editActions = ({ api, set, get, applyOutcome, reloadCurrent }: StoreContext) =>
  ({
    async updateFlow(patch) {
      await get().applyOps([{ op: "updateFlow", patch }]);
    },

    async addStep(type, params, name) {
      const { flow, selection, paletteAt } = get();
      if (!flow) return;
      const { position, after } = insertPlace(flow.steps ?? [], selection, paletteAt);
      let step: Step = { id: newStepId(), type, params: params ?? { ...(DEFAULT_PARAMS[type] ?? {}) }, ...(name ? { name } : {}) };
      // Keep the result under a name from the start, so the next node can use it without one being invented.
      const saveAs = resultName(get().stepTypes.find((d) => d.type === type), flow.variables, flow.steps ?? []);
      if (saveAs) step.saveAs = saveAs;
      // A repeat added right after a node that read a list goes over that list.
      if (type === FOR_EACH && !params && after?.saveAs) step.params = { ...step.params, items: after.saveAs };
      // A switch starts with its first case; a node added among the cases becomes a case of its own.
      if (type === SWITCH) step.blocks = { cases: [newCase()] };
      const parent = position.parentId ? findStep(flow.steps ?? [], position.parentId) : null;
      if (parent?.type === SWITCH && position.block === "cases" && type !== CASE) step = newCase([step]);
      const ok = await get().applyOps([{ op: "addStep", step, position }]);
      if (!ok || !step.id) return;
      set({ selection: { kind: "step", stepId: step.id } });
      // A node with settings it cannot run without opens at once, so they
      // are filled in now instead of turning up later as a problem.
      if (unsetParams(step, get().stepTypes.find((d) => d.type === type)).length > 0) focusFirstSetting();
    },

    async moveSelected(delta) {
      const { flow, selection } = get();
      if (!flow || selection?.kind !== "step") return;
      const loc = locate(flow.steps ?? [], selection.stepId);
      if (!loc) return;
      const index = loc.index + delta;
      if (index < 0 || index >= loc.siblings) return;
      await get().applyOps([
        { op: "moveStep", stepId: selection.stepId, position: { parentId: loc.parentId, block: loc.block, index } },
      ]);
    },

    async removeSelected() {
      const ids = selectedIds(get());
      if (ids.length === 0) return;
      const ok = await get().applyOps(ids.map((stepId) => ({ op: "removeStep", stepId }) as EditOp));
      if (ok) set({ selection: null, range: null });
    },

    async wrapSelected(type) {
      const { flow } = get();
      const ids = selectedIds(get());
      const block = WRAP_BLOCK[type];
      if (!flow || ids.length === 0 || !block) return;
      const steps = flow.steps ?? [];
      const loc = locate(steps, ids[0]!);
      // A case belongs to its switch: it cannot move into another node.
      if (!loc || ids.some((id) => findStep(steps, id)?.type === CASE)) return;
      const first = findStep(steps, ids[0]!);
      const wrapper: Step = { id: newStepId(), type, params: { ...(DEFAULT_PARAMS[type] ?? {}) } };
      // A repeat over the list the node before it read, like adding one there.
      const before = loc.index > 0 ? (loc.parentId === null ? steps : (findStep(steps, loc.parentId)?.blocks?.[loc.block ?? ""] ?? []))[loc.index - 1] : undefined;
      if (type === FOR_EACH && before?.saveAs) wrapper.params = { ...wrapper.params, items: before.saveAs };
      const ops: EditOp[] = [
        { op: "addStep", step: wrapper, position: { parentId: loc.parentId, block: loc.block, index: loc.index } },
        ...ids.map((stepId, index) => ({ op: "moveStep", stepId, position: { parentId: wrapper.id, block, index } }) as EditOp),
      ];
      const ok = await get().applyOps(ops);
      if (!ok || !wrapper.id || !first) return;
      set({ selection: { kind: "step", stepId: wrapper.id }, range: null });
      if (unsetParams(wrapper, get().stepTypes.find((d) => d.type === type)).length > 0) focusFirstSetting();
    },

    setExtractOpen(open) {
      set({ extractOpen: open && get().selection?.kind === "step", extractName: "" });
    },

    setExtractName(name) {
      set({ extractName: name });
    },

    selectBox(stepIds) {
      const { flow } = get();
      if (!flow) return;
      const ids = boxRange(flow.steps ?? [], stepIds, CASE);
      if (ids.length === 0) return;
      const focus = ids.at(-1)!;
      set({ selection: { kind: "step", stepId: focus }, range: ids.length > 1 ? { anchor: ids[0]!, focus, ids } : null, dive: [] });
    },

    selectTo(stepId) {
      const { flow, selection } = get();
      if (selection?.kind !== "step" || !flow) return get().select({ kind: "step", stepId });
      const range = get().range;
      const anchor = range && range.focus === selection.stepId ? range.anchor : selection.stepId;
      const ids = siblingRange(flow.steps ?? [], anchor, stepId);
      set({
        selection: { kind: "step", stepId },
        range: ids && ids.length > 1 ? { anchor, focus: stepId, ids } : null,
        dive: [],
      });
    },

    async copySelected(cut = false) {
      const { flow } = get();
      const ids = selectedIds(get());
      if (!flow || ids.length === 0) return;
      const steps = ids.map((id) => findStep(flow.steps ?? [], id)).filter((s): s is Step => !!s);
      try {
        await navigator.clipboard.writeText(copyText(steps, flow.parts));
      } catch (e) {
        set({ error: message(e) });
        return;
      }
      if (!cut) return void set({ notice: t.copiedNodes(steps.length) });
      // The nodes copied, even if the selection moved while the clipboard was busy.
      if (get().flow?.id !== flow.id) return;
      const ok = await get().applyOps(ids.map((stepId) => ({ op: "removeStep", stepId }) as EditOp));
      if (ok) set({ selection: null, range: null });
    },

    async paste() {
      const { flow } = get();
      if (!flow) return;
      let text = "";
      try {
        text = await readClipboardText();
      } catch (e) {
        set({ error: message(e) });
        return;
      }
      const copied = readCopied(text);
      if (!copied) {
        set({ notice: t.nothingToPaste });
        return;
      }
      await get().insertCopies(copied);
    },

    async duplicateSelected() {
      const { flow } = get();
      const ids = selectedIds(get());
      if (!flow || ids.length === 0) return;
      const steps = ids.map((id) => findStep(flow.steps ?? [], id)).filter((s): s is Step => !!s);
      // Right after the last of them (ids are in flow order).
      set({ selection: { kind: "step", stepId: ids.at(-1)! }, range: null, paletteAt: null });
      await get().insertCopies({ steps, parts: {} });
    },

    async insertCopies(copied) {
      const { flow, selection, paletteAt } = get();
      if (!flow) return;
      const { position } = insertPlace(flow.steps ?? [], selection, paletteAt);
      const parent = position.parentId ? findStep(flow.steps ?? [], position.parentId) : null;
      const intoCases = parent?.type === SWITCH && position.block === "cases";
      // A case belongs in a switch: elsewhere its nodes are pasted without it,
      // and other nodes pasted among the cases get a case of their own.
      const steps = copied.steps
        .flatMap((s) => (s.type === CASE && !intoCases ? (s.blocks?.body ?? []) : [s]))
        .map((s) => withNewIds(s, newStepId))
        .map((s) => (intoCases && s.type !== CASE ? newCase([s]) : s));
      if (steps.length === 0) return;
      const base = position.index ?? null;
      const ops: EditOp[] = [
        ...partOps(copied, flow.parts),
        ...steps.map(
          (step, i) => ({ op: "addStep", step, position: { ...position, index: base === null ? null : base + i } }) as EditOp,
        ),
      ];
      const ok = await get().applyOps(ops);
      if (!ok) return;
      const ids = steps.map((s) => s.id ?? "");
      const focus = ids.at(-1)!;
      set({ selection: { kind: "step", stepId: focus }, range: ids.length > 1 ? { anchor: ids[0]!, focus, ids } : null, paletteAt: null });
    },

    async updateStep(stepId, patch) {
      await get().applyOps([{ op: "updateStep", stepId, patch }]);
    },

    async setVariable(variable) {
      await get().applyOps([{ op: "setVariable", variable }]);
    },

    async removeVariable(name) {
      await get().applyOps([{ op: "removeVariable", name }]);
    },

    async loadCalled() {
      const flow = get().flow;
      if (!flow) return;
      // Calls inside called flows too, so the chart can enter them.
      const called: Record<string, Flow> = {};
      const seen = new Set([flow.id]);
      let next = calledIds(flow.steps ?? []);
      while (next.length > 0) {
        const ids = next.filter((id) => !seen.has(id));
        ids.forEach((id) => seen.add(id));
        const loaded = await Promise.all(ids.map((id) => api.getFlow(id).catch(() => null)));
        next = [];
        for (const callee of loaded) {
          if (!callee) continue;
          called[callee.id] = callee;
          next.push(...calledIds(callee.steps ?? []));
        }
      }
      // Ignore a late answer for a flow that is no longer open.
      if (get().flow?.id !== flow.id) return;
      set({ called });
    },

    toggleUnfolded(key) {
      set((s) => ({ unfolded: { ...s.unfolded, [key]: !s.unfolded[key] } }));
    },

    enterCall(stepId) {
      const { flow, called, dive } = get();
      const chain = diveChain(flow, called, dive);
      const path = [...dive.slice(0, chain.length), stepId];
      if (diveChain(flow, called, path).length !== path.length) return;
      // The inspector edits the open flow: nothing of it stays selected down here.
      set({ dive: path, selection: null });
    },

    leaveCalls(depth) {
      set((s) => ({ dive: s.dive.slice(0, Math.max(0, depth)) }));
    },

    async extract(stepIds, name) {
      const flow = get().flow;
      if (!flow || stepIds.length === 0) return false;
      try {
        const outcome = await api.extractSubflow(flow.id, flow.revision ?? 0, stepIds, name);
        applyOutcome(outcome.caller);
        set({ selection: { kind: "step", stepId: outcome.callStepId }, range: null, extractOpen: false, extractName: "", notice: t.extracted(outcome.subflow.flow.name) });
        await Promise.all([get().refreshList(), get().loadHistory(), get().loadCalled()]);
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
    },

    async onExternalChange(flowId) {
      if (get().called[flowId]) void get().loadCalled();
      await get().refreshList();
      void api
        .history(flowId)
        .then((h) => set({ histories: { ...get().histories, [flowId]: h } }))
        .catch(() => {});
      void get().loadTimeline(flowId);
      const current = get().flow;
      if (current?.id !== flowId) return;
      try {
        const latest = await api.getFlow(flowId);
        if ((latest.revision ?? 0) !== (current.revision ?? 0)) {
          await reloadCurrent();
          const selection = get().selection;
          if (selection?.kind === "step" && !findStep(latest.steps ?? [], selection.stepId)) {
            set({ selection: null });
          }
          set({ notice: t.externalChange });
        }
      } catch (e) {
        // Deleted elsewhere.
        if (e instanceof ApiError && e.code === "FLOW_NOT_FOUND") {
          set({ flow: null, validation: null, selection: null });
        }
      }
    },

    openEditor(stepId) {
      set({ editing: stepId, selection: { kind: "step", stepId } });
    },

    closeEditor() {
      set({ editing: null });
    },
  }) satisfies Partial<StudioState>;
