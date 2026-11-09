// Store actions for versions and for handing flows to others (.spx,
// distribution folders, pasting an AI chat answer).
import { ApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { message, type StoreContext } from "./context";
import type { StudioState } from "./index";

export const sharingActions = ({ api, set, get, applyOutcome, reloadCurrent, mutate }: StoreContext) =>
  ({
    async loadVersions() {
      const id = get().flow?.id;
      if (!id) return;
      try {
        const [versions, published] = await Promise.all([api.listVersions(id), api.publishedState(id)]);
        if (get().flow?.id === id) set({ versions, published });
      } catch {
        // Versions are secondary; editing keeps working without them.
      }
    },

    async createVersion(name, note) {
      const flow = get().flow;
      if (!flow) return false;
      try {
        await api.createVersion(flow.id, flow.revision ?? 0, { name, note });
        await get().loadVersions();
        set({ notice: t.versionSaved, error: null });
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

    async restoreVersion(number) {
      const ok = await mutate((id, rev) => api.restoreVersion(id, number, rev));
      if (ok) set({ notice: t.restored, selection: null });
    },

    async exportFlow() {
      const id = get().flow?.id;
      if (!id) return;
      try {
        const path = await api.exportFlow(id);
        set({ notice: `${t.exported}: ${path}`, error: null });
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async openHandOff(id, content) {
      try {
        set({ handOff: await api.packagePlan(id, content), error: null });
      } catch (e) {
        set({ error: message(e) });
      }
    },

    closeHandOff() {
      set({ handOff: null });
    },

    async checkDistribution() {
      try {
        const folders = await api.distributionFolders();
        const views = folders.length > 0 ? await api.scanDistribution() : [];
        set((s) => ({ distribution: { ...s.distribution, folders, views } }));
      } catch {
        // Looking is a convenience: nothing to say when it fails (e.g. outside Writer).
      }
    },

    async setDistributionFolders(folders) {
      try {
        const saved = await api.setDistributionFolders(folders);
        set((s) => ({ distribution: { ...s.distribution, folders: saved }, error: null }));
        void get().checkDistribution();
        return true;
      } catch (e) {
        set({ error: message(e) });
        return false;
      }
    },

    openDistribution() {
      set((s) => ({ distribution: { ...s.distribution, open: true } }));
      void get().checkDistribution();
    },

    closeDistribution() {
      set((s) => ({ distribution: { ...s.distribution, open: false } }));
    },

    async placeInDistribution(id, folder, only) {
      try {
        await api.placeInDistribution(id, folder, only);
        set({ handOff: null, notice: t.distribution.placed(folder), error: null });
        void get().checkDistribution();
        return true;
      } catch (e) {
        set({ error: message(e) });
        return false;
      }
    },

    async exportPackage(id, options) {
      try {
        const out = await api.exportPackage(id, options);
        set({ handOff: null, notice: `${t.handOff.saved}: ${out.path}`, error: null });
        return out;
      } catch (e) {
        set({ error: message(e) });
        return null;
      }
    },

    async receiveFile(file) {
      try {
        set({ received: { file, preview: await api.previewPackage(file), away: false }, error: null });
      } catch (e) {
        set({ received: null, error: message(e) });
      }
    },

    closeReceived() {
      set({ received: null });
    },

    stepAwayFromReceived() {
      const received = get().received;
      if (received) set({ received: { ...received, away: true } });
    },

    async backToReceived() {
      const received = get().received;
      if (received) await get().receiveFile(received.file);
    },

    async importReceived(onConflict) {
      const received = get().received;
      if (!received) return false;
      try {
        const outcome = await api.importPackage(received.file, onConflict);
        applyOutcome(outcome);
        set({ received: null, selection: null, history: [], versions: [], notice: `${t.imported}: ${outcome.flow.name}`, error: null });
        await Promise.all([get().refreshList(), get().loadHistory(), get().loadVersions()]);
        // A version from a 配布フォルダー is now here: its notice goes.
        if (get().distribution.folders.length > 0) void get().checkDistribution();
        return true;
      } catch (e) {
        set({ error: message(e) });
        return false;
      }
    },

    async importFile(contents, onConflict) {
      try {
        const outcome = await api.importFlow(contents, onConflict);
        applyOutcome(outcome);
        set({ pendingImport: null, selection: null, history: [], versions: [], notice: `${t.imported}: ${outcome.flow.name}` });
        await Promise.all([get().refreshList(), get().loadHistory(), get().loadVersions()]);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "IMPORT_CONFLICT") {
          const name = (e.details as { name?: string } | undefined)?.name ?? "";
          set({ pendingImport: { contents, name }, error: null });
        } else {
          set({ pendingImport: null, error: message(e) });
        }
        return false;
      }
    },

    cancelImport() {
      set({ pendingImport: null });
    },

    setPasteOpen(mode) {
      set({ pasteOpen: mode });
    },

    async pasteAnswer(text, into) {
      const flow = into ? get().flow : null;
      try {
        const result = await api.pasteAiAnswer(text, flow?.id, flow?.revision);
        if (result.outcome) {
          applyOutcome(result.outcome);
          set({ selection: null, error: null, ...(flow ? {} : { history: [], versions: [] }) });
          await Promise.all([get().refreshList(), get().loadHistory(), get().loadVersions(), get().loadCalled()]);
        }
        return result;
      } catch (e) {
        set({ error: message(e) });
        return null;
      }
    },
  }) satisfies Partial<StudioState>;
