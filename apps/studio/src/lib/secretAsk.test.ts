import { describe, expect, it } from "vitest";
import type { SecretInfo, SecretRequest } from "./api";
import { nextSecretAsk } from "./secretAsk";

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  name: "Google",
  sites: ["https://accounts.google.com"],
  fields: ["username", "password"],
  reason: "Google にログインするため",
  requestedAt: "",
  missing: { registered: false, fields: ["username", "password"], sites: ["https://accounts.google.com"] },
  ...over,
});

const saved: SecretInfo = {
  name: "Google",
  username: "me",
  sites: ["https://accounts.google.com"],
  fields: ["username", "password"],
  updatedAt: "",
};

describe("nextSecretAsk", () => {
  it("asks only for the values of a new login, with name and site filled in", () => {
    const ask = nextSecretAsk([request()], null, []);
    expect(ask).toMatchObject({
      source: "ai",
      name: "Google",
      fields: ["username", "password"],
      sites: ["https://accounts.google.com"],
      needsSite: false,
      quick: true,
      reason: "Google にログインするため",
    });
  });

  it("asks only for what a saved secret lacks", () => {
    const ask = nextSecretAsk(
      [request({ missing: { registered: true, fields: ["totp"], sites: ["https://mail.google.com"] } })],
      null,
      [saved],
    );
    expect(ask).toMatchObject({ fields: ["totp"], sites: ["https://mail.google.com"], needsSite: false, existing: saved });
  });

  it("asks for a site when neither the request nor the secret has one", () => {
    const ask = nextSecretAsk([request({ sites: [], missing: { registered: false, fields: ["password"], sites: [] } })], null, []);
    expect(ask?.needsSite).toBe(true);
  });

  it("puts AI requests before a failed run", () => {
    expect(nextSecretAsk([request()], { name: "社内", code: "SECRET_NOT_FOUND" }, [])?.source).toBe("ai");
  });

  it("turns a failed run into the same ask", () => {
    expect(nextSecretAsk([], { name: "社内", code: "SECRET_NOT_FOUND" }, [])).toMatchObject({
      source: "run",
      fields: ["username", "password"],
      needsSite: true,
      quick: true,
    });
    expect(nextSecretAsk([], { name: "Google", code: "SECRET_NOT_FOUND" }, [saved])).toBeNull();
    expect(
      nextSecretAsk([], { name: "Google", code: "SECRET_FIELD_EMPTY" }, [{ ...saved, fields: ["username"] }]),
    ).toMatchObject({ fields: ["password"], needsSite: false, quick: true });
    // A refused page is only shown: adding it takes the full form.
    expect(
      nextSecretAsk([], { name: "Google", code: "SECRET_SITE_MISMATCH", site: "https://evil.example" }, [saved]),
    ).toMatchObject({ quick: false, page: "https://evil.example", sites: [] });
  });
});
