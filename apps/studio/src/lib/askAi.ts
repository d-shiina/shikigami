// Hands a request to the AI. Until Studio talks to the AI itself, the text
// goes to the clipboard for the person to paste into their AI client.

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
    return "AI への依頼文をコピーしました。Claude Code などの AI に貼り付けてください。直した内容を確認したら、ここから再開できます。";
  },
};
