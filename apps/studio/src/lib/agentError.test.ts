import { afterEach, describe, expect, it } from "vitest";
import { agentErrorText } from "./agentError";
import { ApiError } from "./api";
import { setLocale } from "./i18n";

afterEach(() => setLocale("ja", false));

describe("agentErrorText", () => {
  it("says in Japanese that automation did not start, with what Windows said", () => {
    setLocale("ja", false);
    const e = new ApiError({
      code: "AGENT_START_FAILED",
      message: 'error: could not register the worker to start at sign-in: Windows said "エラー: アクセスが拒否されました。"',
      details: { reason: "エラー: アクセスが拒否されました。" },
    });
    const text = agentErrorText(e);
    expect(text).toContain("自動実行を開始できませんでした。");
    expect(text).toContain("Windows からの理由：エラー: アクセスが拒否されました。");
    // The command's English stays off the screen.
    expect(text).not.toContain("error:");
    expect(text).not.toContain("schtasks");
  });

  it("words the other failures without the command's English", () => {
    setLocale("ja", false);
    expect(agentErrorText(new ApiError({ code: "AGENT_NO_ANSWER", message: "the worker did not answer" }))).toContain("応答がありません");
    expect(agentErrorText(new ApiError({ code: "AGENT_START_FAILED", message: "error: x" }))).not.toContain("error:");
  });
});
