import { describe, expect, it } from "vitest";
import { fixRequest } from "./fixRequest";

describe("fix request", () => {
  it("gives the AI the error, the step, the variables and the screen", () => {
    const text = fixRequest({
      scenario: {
        id: "scn_a",
        name: "受注取込",
        steps: [{ id: "s2", type: "browser.click", name: "ログイン", params: { target: { role: "button", name: "ログイン" } } }],
      },
      runId: "run_1",
      pause: {
        seq: 3,
        stepId: "s2",
        stepType: "browser.click",
        reason: "error",
        error: { code: "ELEMENT_NOT_FOUND", message: "no button", details: { target: { role: "button" } } },
        variables: { user: "taro", big: "x".repeat(500) },
        revision: 4,
      },
      evidence: {
        runId: "run_1",
        seq: 3,
        stepId: "s2",
        observation: {
          id: "obs_1",
          source: "runPause",
          at: "2026-10-28T00:00:00Z",
          actor: { kind: "studio" },
          title: "ログイン画面",
          request: {},
          tree: '- button "サインイン"',
        },
      },
      defs: [{ type: "browser.click", label: "クリック" } as never],
    });
    expect(text).toContain("受注取込");
    expect(text).toContain("クリック「ログイン」");
    expect(text).toContain("ELEMENT_NOT_FOUND: no button");
    expect(text).toContain('"name": "ログイン"');
    expect(text).toContain('user = "taro"');
    expect(text).toContain("…");
    expect(text).toContain('- button "サインイン"');
    expect(text).toContain("obs_1");
    expect(text).toContain("run_1");
  });
});
