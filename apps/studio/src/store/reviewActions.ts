// Store actions for reviewing changes, approvals, confirmation (確定),
// policy and pick requests.
import type { HistoryEntry } from "@spellsheet/schema";
import { t } from "../lib/i18n";
import { message, publishMessage, type StoreContext } from "./context";
import { revertBlocker, pendingReview, groupRevertBlocker } from "./history";
import type { StudioState } from "./index";
import { saveReviewed } from "./persist";

export const reviewActions = ({ api, set, get }: StoreContext) =>
  ({
    async loadHistory() {
      const id = get().flow?.id;
      if (!id) return;
      try {
        const [history] = await Promise.all([api.history(id), get().loadTimeline(id)]);
        set({ histories: { ...get().histories, [id]: history } });
        // Ignore a late answer for a flow that is no longer open.
        if (get().flow?.id === id) set({ history });
      } catch {
        // The timeline is secondary; editing keeps working without it.
      }
    },

    approve(revision) {
      const id = get().flow?.id;
      if (!id) return;
      const reviewed = { ...get().reviewed, [id]: [...(get().reviewed[id] ?? []), revision] };
      saveReviewed(reviewed);
      set({ reviewed });
    },

    markAllReviewed() {
      const id = get().flow?.id;
      if (!id) return;
      const revisions = pendingReview(get()).map((e) => e.revision);
      const reviewed = { ...get().reviewed, [id]: [...(get().reviewed[id] ?? []), ...revisions] };
      saveReviewed(reviewed);
      set({ reviewed });
    },

    async approveAll() {
      const flow = get().flow;
      if (!flow) return;
      get().markAllReviewed();
      try {
        await api.submitReview(flow.id, { revision: flow.revision ?? 0, verdict: "approved" });
        set({ notice: t.approved });
      } catch (e) {
        // Marked here anyway; Core refuses only when the flow moved on (REVISION_CONFLICT).
        set({ error: message(e) });
      }
      await get().loadTimeline(flow.id);
    },

    async approveAndPublish() {
      const flow = get().flow;
      if (!flow) return;
      try {
        const published = await api.approveAndPublish(flow.id, flow.revision ?? 0);
        get().markAllReviewed();
        set({ notice: t.approvedPublished(published.version), published, error: null });
        await get().loadVersions();
      } catch (e) {
        set({ error: publishMessage(e) });
      }
      await get().loadTimeline(flow.id);
    },

    async publish(version) {
      const flow = get().flow;
      if (!flow) return;
      try {
        const published = await api.publishFlow(
          flow.id,
          version == null ? { expectedRevision: flow.revision ?? 0, note: "" } : { version, note: "" },
        );
        set({ notice: t.publishDone(published.version), published, error: null });
        await get().loadVersions();
      } catch (e) {
        set({ error: publishMessage(e) });
      }
    },

    async unpublish() {
      const flow = get().flow;
      if (!flow) return;
      try {
        await api.unpublishFlow(flow.id);
        set({ notice: t.unpublished, published: null, error: null });
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async loadApprovals() {
      try {
        set({ approvals: await api.listApprovals() });
      } catch {
        // The banner is a convenience; the AI's call fails safe without an answer.
      }
    },

    async loadPickRequests() {
      try {
        set({ pickRequests: await api.listPickRequests() });
      } catch {
        // A convenience: the banner in the browser asks the person anyway.
      }
    },

    async cancelPickRequest(id) {
      try {
        await api.cancelPickRequest(id);
      } catch (e) {
        set({ error: message(e) });
      }
      await get().loadPickRequests();
    },

    async finishPickRequest(id) {
      try {
        await api.finishPickRequest(id);
      } catch (e) {
        set({ error: message(e) });
      }
      await get().loadPickRequests();
    },

    async decideApproval(id, approve) {
      try {
        await api.decideApproval(id, approve);
        set({ notice: approve ? t.approvalApproved : t.approvalDenied, error: null });
      } catch (e) {
        set({ error: message(e) });
      }
      await get().loadApprovals();
    },

    setPolicyOpen(open) {
      set(open ? { policyOpen: true } : { policyOpen: false, policy: null });
      if (!open) return;
      void api
        .getPolicy()
        .then((policy) => set({ policy }))
        .catch((e) => set({ error: message(e), policyOpen: false }));
    },

    async savePolicy(policy) {
      try {
        set({ policy: await api.savePolicy(policy), notice: t.policySaved, error: null });
        return true;
      } catch (e) {
        set({ error: message(e) });
        return false;
      }
    },

    async sendBack(reason, steps) {
      const flow = get().flow;
      if (!flow) return false;
      try {
        await api.submitReview(flow.id, {
          revision: flow.revision ?? 0,
          verdict: "rejected",
          reason: reason.trim(),
          steps: steps.filter((n) => n.note.trim()).map((n) => ({ ...n, note: n.note.trim() })),
        });
        set({ notice: t.sentBack });
        await get().loadTimeline(flow.id);
        return true;
      } catch (e) {
        set({ error: message(e) });
        return false;
      }
    },

    async loadTimeline(id) {
      try {
        const timeline = await api.reviewTimeline(id);
        // Polled while reviewing: keep the old object when nothing changed.
        if (JSON.stringify(timeline) === JSON.stringify(get().timelines[id])) return;
        set({ timelines: { ...get().timelines, [id]: timeline } });
      } catch {
        // Evidence is secondary; reviewing works from the journal alone.
      }
    },

    async revert(entry) {
      const blocker = revertBlocker(entry, get().history);
      if (blocker) {
        set({ error: blocker });
        return;
      }
      const ok = await get().applyOps(entry.inverse ?? []);
      if (ok) {
        get().approve(entry.revision);
        set({ notice: t.reverted });
      }
    },

    async revertAll() {
      const group = pendingReview(get());
      if (group.length === 0) return;
      const blocker = groupRevertBlocker(group, get().history);
      if (blocker) {
        set({ error: blocker });
        return;
      }
      // Newest first, so each inverse meets the state its own edit left.
      const ok = await get().applyOps(group.flatMap((e) => e.inverse ?? []));
      if (ok) {
        get().markAllReviewed();
        set({ notice: t.reverted });
      }
    },

    async loadInbox() {
      const ids = get().summaries.map((s) => s.id);
      const pairs = await Promise.all(
        ids.map((id) =>
          api
            .history(id)
            .then((h) => [id, h] as const)
            .catch(() => [id, [] as HistoryEntry[]] as const),
        ),
      );
      for (const id of ids) void get().loadTimeline(id);
      // A journal fetched since (after an outside edit) may be newer than
      // this batch's answer; keep whichever reaches the later revision.
      const latest = (h: HistoryEntry[] | undefined) => h?.at(-1)?.revision ?? -1;
      const histories = { ...get().histories };
      for (const [id, h] of pairs) if (latest(h) >= latest(histories[id])) histories[id] = h;
      set({ histories });
    },
  }) satisfies Partial<StudioState>;
