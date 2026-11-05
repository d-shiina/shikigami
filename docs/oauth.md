# Web APIs with OAuth sign-in

English | [日本語](ja/oauth.md)

Many web APIs (Box, Google, Microsoft 365, Salesforce, …) do not take a fixed key: a person signs in once and allows the app access (the OAuth 2.0 authorization code flow), and the app gets tokens. In Shikigami that is two nodes:

| Node | What it does | Output |
|---|---|---|
| `oauth.signIn` | Makes sure there is a usable sign-in for a secret: reuses or refreshes the saved tokens, otherwise lets the person sign in in the browser | `{ secret, signedIn, via, expiresAt, scope }` (never the tokens) |
| `http.request` with `auth: { "secret": "<name>", "field": "accessToken" }` | Calls the API with the access token. It is refreshed first when it is about to expire | as usual ([system.md](system.md)) |

## Any fixed redirect URL works

The provider sends the browser back to the **redirect URL registered for the app**, with the code in the URL (`…?code=…&state=…`). Usually a program has to listen on that address (`http://localhost:…`), so a provider or an administrator that allows only your company's site (e.g. `https://www.example.com/`) as the redirect URL gets in the way.

`oauth.signIn` does not need to listen anywhere. The sign-in runs in Shikigami's browser, which catches its own request to the redirect URL **before it leaves the PC** and shows "Signed in" instead. So:

- The redirect URL can be any fixed address registered at the provider: the company's top page, a page that does not exist, anything. It only has to match exactly.
- The site behind the redirect URL never loads and never receives the code.
- The `state` sent with the request must come back unchanged (`OAUTH_STATE_MISMATCH` otherwise), and the code is bound to this attempt with PKCE, so a code from anywhere else is useless.

## Setting up (Box as the example)

1. At the provider, create the app (Box: Developer Console → Create Platform App → User Authentication (OAuth 2.0)) and register the **redirect URL** (e.g. `https://www.example.com/`). Note the client ID and client secret, and give the app the scopes it needs.
2. In Studio, 🔑 Secrets → New:

   | Field | Contents |
   |---|---|
   | Name | e.g. `Box` |
   | Username | the **client ID** |
   | Password | the **client secret** (empty for public clients without one) |
   | Sites | where the client secret and the tokens may be sent: the token URL's site and the API's site (Box: `https://api.box.com`) |

   From an AI: `request_secret` with `name: "Box"`, `sites: ["https://api.box.com"]` and a reason such as "the client ID as the username and the client secret as the password".
3. In the scenario:

```jsonc
{ "type": "oauth.signIn", "params": {
    "secret": "Box",
    "authorizeUrl": "https://account.box.com/api/oauth2/authorize",
    "tokenUrl": "https://api.box.com/oauth2/token",
    "redirectUrl": "https://www.example.com/"
} },
{ "type": "http.request", "params": {
    "url": "https://api.box.com/2.0/folders/0/items",
    "auth": { "secret": "Box", "field": "accessToken" }
  }, "saveAs": "res" },
{ "type": "log.message", "params": { "message": "{{ join(map(res.body.entries, e => e.name), ', ') }}" } }
```

The first run opens the Box sign-in page. The person signs in and presses "Grant access"; Studio shows "Waiting for you" meanwhile. Later runs finish `oauth.signIn` at once without a person (`via: "saved"` or `"refreshed"`).

## `oauth.signIn` params

| Param | Meaning |
|---|---|
| `secret` | The secret holding the client (username = client ID, password = client secret) |
| `authorizeUrl` | The provider's authorization page |
| `tokenUrl` | The provider's token endpoint. Its site must be one of the secret's sites |
| `redirectUrl` | The redirect URL registered for the app, exactly as registered |
| `scope` | Space-separated scopes, when the provider wants them |
| `authorizeParams` | Extra parameters for the authorization page, e.g. `{ "prompt": "consent", "access_type": "offline" }` (Google needs these for a refresh token) |
| `pkce` | `false` only for a provider that rejects PKCE (default `true`) |
| `message` | What Studio asks the person to do |
| `context` | The browser context (default `default`) |

It waits for the person for 5 minutes by default (`timeoutMs`). The client secret goes in the body of the token request (`client_secret_post`).

## Tokens

- Saved encrypted in the workspace (`secrets/oauth/`), with the same key as the secrets ([secrets.md](secrets.md)). They never appear in outputs, logs or MCP results; the access token is masked like a password.
- `http.request` refreshes the access token when it has less than 2 minutes left (a token that cannot be refreshed is used until it really expires). Refreshes are one at a time, also across Studio, the CLI and the MCP server on the same workspace, so a provider that replaces the refresh token on every refresh (Box does) never loses it.
- Saved tokens are reused only for the same client ID, `tokenUrl` and a `scope` they cover; asking for more scopes signs in again.
- When the provider no longer accepts the refresh token, `http.request` fails with `OAUTH_SIGN_IN_REQUIRED` and the next `oauth.signIn` lets the person sign in again. Put `oauth.signIn` at the start of the scenario so it happens there.
- Studio shows "Signed in (OAuth)" on the secret, with Sign out. The CLI: `shikigami secret logout <name>`. Changing the client ID makes the old tokens unusable; removing the secret removes them.
- `list_secrets` shows `signedIn: true` for secrets with saved tokens.

## Unattended runs

Headless runs cannot wait for a person: when nobody has signed in yet (or the refresh token expired), `oauth.signIn` fails with `HUMAN_REQUIRED`. Sign in once with a visible browser; unattended runs then reuse and refresh the tokens.

## Error codes

| Code | Meaning and fix |
|---|---|
| `OAUTH_SIGN_IN_REQUIRED` | No usable tokens for the secret. Put `oauth.signIn` before the request |
| `OAUTH_DENIED` | The provider sent back an error (`access_denied`: the person did not allow it). Otherwise check the client ID, `redirectUrl` and `scope` against the app's settings |
| `OAUTH_STATE_MISMATCH` | The answer was not for this request. Run again |
| `OAUTH_TOKEN_FAILED` | The token endpoint refused (`details.error`, `details.errorDescription`): check the client ID / secret, `tokenUrl` and `redirectUrl` |
| `SECRET_SITE_NOT_SET` / `SECRET_SITE_MISMATCH` | The token URL or the API is not one of the secret's sites |
| `HUMAN_REQUIRED` / `HUMAN_TIMEOUT` | A person is needed but there is no window / they did not finish in time |
