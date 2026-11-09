import type { Flow } from "@spellsheet/schema";
import { describe, expect, it } from "vitest";
import type { SecretInfo } from "./api";
import { accountInputs, accountLabel, nameVariable, pickEachRun, sameSite } from "./secretAccounts";

const secret = (name: string, sites: string[], username = "", kind: SecretInfo["kind"] = "login"): SecretInfo => ({
  name,
  kind,
  username,
  sites,
  fields: ["username", "password"],
  updatedAt: "2026-11-09T00:00:00Z",
});

describe("several accounts of one site", () => {
  const secrets = [
    secret("受注（経理）", ["https://orders.example.com"], "keiri01"),
    secret("受注（申請）", ["https://orders.example.com"], "shinsei01"),
    secret("受注 API", ["https://orders.example.com"], "", "apiKey"),
    secret("勤怠", ["https://kintai.example.com"]),
  ];

  it("finds the other logins of the same site, not other kinds or sites", () => {
    expect(sameSite(secrets, "受注（経理）").map((s) => s.name)).toEqual(["受注（申請）"]);
    expect(sameSite(secrets, "勤怠")).toEqual([]);
    expect(sameSite(secrets, "未登録")).toEqual([]);
  });

  it("shows the user name beside the name, as browsers list saved logins", () => {
    expect(accountLabel(secrets[0]!)).toBe("受注（経理）（keiri01）");
    expect(accountLabel(secrets[3]!)).toBe("勤怠");
  });

  it("reads a name taken from a variable", () => {
    expect(nameVariable("{{ アカウント }}")).toBe("アカウント");
    expect(nameVariable("受注（経理）")).toBeNull();
    expect(nameVariable("{{ a.b }}")).toBeNull();
  });

  it("repoints the OAuth sign-in too, so the access token comes from the picked app", () => {
    const flow = {
      variables: [],
      steps: [
        { id: "in", type: "oauth.signIn", params: { secret: "Box（経理）", authorizeUrl: "https://example.com/a" } },
        { id: "req", type: "http.request", params: { url: "https://api.example.com", auth: { secret: "Box（経理）", field: "accessToken" } } },
      ],
    } as unknown as Flow;
    const { ops } = pickEachRun(flow, "Box（経理）", ["Box（申請）"], "アカウント", "アカウント");
    expect(ops[1]).toMatchObject({ stepId: "in", patch: { replaceParams: { secret: "{{ アカウント }}" } } });
    expect(ops[2]).toMatchObject({ stepId: "req", patch: { replaceParams: { auth: { secret: "{{ アカウント }}", field: "accessToken" } } } });
  });

  it("「実行のたびに選ぶ」 makes an input and repoints every step that logs in with the account", () => {
    const flow = {
      variables: [{ name: "アカウント", type: "string", direction: "local" }],
      steps: [
        { id: "open", type: "browser.open", params: { url: "https://orders.example.com", session: "受注（経理）" } },
        {
          id: "g",
          type: "control.group",
          params: {},
          blocks: {
            body: [
              { id: "user", type: "browser.fill", params: { target: { role: "textbox" }, value: { secret: "受注（経理）", field: "username" } } },
              { id: "pw", type: "browser.fill", params: { value: { secret: "受注（経理）", field: "password" } } },
              { id: "other", type: "browser.fill", params: { value: { secret: "勤怠", field: "password" } } },
            ],
          },
        },
      ],
    } as unknown as Flow;
    const { variable, ops } = pickEachRun(flow, "受注（経理）", ["受注（申請）"], "アカウント", "アカウント");
    expect(variable).toBe("アカウント2");
    expect(ops[0]).toMatchObject({ op: "setVariable", variable: { name: "アカウント2", direction: "input", choices: ["受注（経理）", "受注（申請）"] } });
    expect(ops.slice(1).map((o) => (o as { stepId: string }).stepId)).toEqual(["open", "user", "pw"]);
    expect(ops[1]).toMatchObject({ patch: { replaceParams: { session: "{{ アカウント2 }}" } } });
    expect(ops[2]).toMatchObject({ patch: { replaceParams: { target: { role: "textbox" }, value: { secret: "{{ アカウント2 }}", field: "username" } } } });
    // The new input is offered in the node's list of secrets.
    const after = { variables: [...(flow.variables ?? []), (ops[0] as { variable: Flow["variables"] extends (infer V)[] | undefined ? V : never }).variable] };
    expect(accountInputs(after).map((v) => v.name)).toEqual(["アカウント2"]);
  });
});
