// Hands a request to the AI when Studio cannot start the agent itself (see
// agent.ts): the text goes to the clipboard to paste into an AI client.
import { t } from "./i18n";

export type AskAi = {
  /** Shown on the button, e.g. "AI". */
  name: string;
  /** Resolves to what Studio should tell the person. */
  ask(text: string): Promise<string>;
};

export const clipboardAi: AskAi = {
  name: "AI",
  async ask(text) {
    await navigator.clipboard.writeText(text);
    return t.askCopied;
  },
};
