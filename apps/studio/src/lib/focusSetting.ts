// Puts the cursor in the first setting of the node in the right pane, once
// it has drawn: after a double-click on the node, or after adding a node
// that cannot run without a setting.
export function focusFirstSetting(): void {
  if (typeof document === "undefined") return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const pane = document.querySelector("[data-node-settings]");
      const field = pane?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select:not([data-add-setting])");
      field?.focus();
    }),
  );
}
