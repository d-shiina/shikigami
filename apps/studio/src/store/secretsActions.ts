// Store actions for logins (secrets).
import { t } from "../lib/i18n";
import { message, type StoreContext } from "./context";
import type { StudioState } from "./index";

export const secretsActions = ({ api, set, get }: StoreContext) =>
  ({
    async loadSecrets() {
      try {
        const { secrets, keyLocation, keyMissing } = await api.listSecrets();
        set({ secrets, secretKeyLocation: keyLocation, secretKeyMissing: keyMissing, secretsLoaded: true });
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async saveSecret(input) {
      try {
        await api.setSecret(input);
        await get().loadSecrets();
        await get().loadSecretRequests();
        set((s) => ({
          notice: t.secretSaved(input.name),
          error: null,
          secretFix: s.secretFix?.name === input.name ? null : s.secretFix,
        }));
        return true;
      } catch (e) {
        set({ error: message(e) });
        return false;
      }
    },

    async saveSecretAdding(input, addSites) {
      await get().loadSecrets();
      const current = get().secrets.find((s) => s.name === input.name)?.sites ?? [];
      const sites = [...current, ...addSites.filter((site) => !current.includes(site))];
      return get().saveSecret({ ...input, sites });
    },

    async removeSecret(name) {
      try {
        await api.removeSecret(name);
        await get().loadSecrets();
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async signOutSecret(name) {
      try {
        await api.forgetLogin(name);
        await get().loadSecrets();
      } catch (e) {
        set({ error: message(e) });
      }
    },

    async resetSecrets() {
      try {
        await api.resetSecrets();
        await get().loadSecrets();
      } catch (e) {
        set({ error: message(e) });
      }
    },

    setSecretsOpen(open) {
      get().setPlace(open ? "secrets" : "flows");
    },

    async loadSecretRequests() {
      try {
        // The dialog reads what each secret already has: keep both fresh.
        const [secretRequests] = await Promise.all([api.listSecretRequests(), get().loadSecrets()]);
        set({ secretRequests });
      } catch {
        // Requests are a convenience: the dialog still works without them.
      }
    },

    async dismissSecretRequest(name) {
      try {
        await api.dismissSecretRequest(name);
      } catch (e) {
        set({ error: message(e) });
      }
      await get().loadSecretRequests();
    },

    openSecretForm(prefill) {
      set({ place: "secrets", reviewing: false, secretsOpen: true });
      // The form edits the secret when it exists: list first, then fill.
      void get()
        .loadSecrets()
        .then(() => set({ secretPrefill: prefill }));
    },

    clearSecretPrefill() {
      set({ secretPrefill: null });
    },

    dismissSecretFix() {
      set({ secretFix: null });
    },
  }) satisfies Partial<StudioState>;
