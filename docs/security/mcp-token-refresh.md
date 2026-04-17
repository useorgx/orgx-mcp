# OrgX MCP — Token Refresh Contract

This document describes how orgx-mcp signals authentication state to MCP
clients and the behaviour expected from clients in return. It covers both
the OAuth access-token path (the primary user-facing flow) and the two
internal token types the server issues directly (stream tokens and session
tokens).

If you are integrating a new MCP client against orgx-mcp, **read this doc
before you implement the bearer-refresh path**. Silently swallowing 401s
and showing a "reconnect" modal is the single most common cause of
mid-session breakage.

## Token inventory

| Token              | TTL       | Issued by                           | Used for                                        |
|--------------------|-----------|-------------------------------------|-------------------------------------------------|
| OAuth access token | **1 h**   | `/token` (OAuthProvider)            | Bearer on every `/mcp`, `/sse`, and root-URL request |
| OAuth refresh token| **30 d**  | `/token` (OAuthProvider)            | Exchanged at `/token` for a new access token. **Rotated on every use.** |
| Stream token       | 1 h       | Server-side (`signStreamToken`)     | `?t=…` on `/scaffold/:sid/stream`, `/live-feed/*/stream` |
| Session token      | 1 h       | `POST /session-tokens`              | Internal agent-worker → MCP server calls        |

The access token is the one that touched most user sessions. The other two
exist for specific server-to-server and stream scenarios.

## Server guarantees

The server commits to these behaviours. If any of them breaks, please open
an issue — clients depend on them.

### G1 — Every auth failure returns 401 with `WWW-Authenticate`

Any endpoint that expected a bearer and couldn't verify it returns HTTP
`401` with a proper RFC 6750 + RFC 9728 header:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token",
                  error_description="Access token expired. Refresh the token and retry.",
                  resource_metadata="https://mcp.useorgx.com/.well-known/oauth-protected-resource"
Content-Type: application/json
Cache-Control: no-store

{
  "error": "invalid_token",
  "error_description": "Access token expired. Refresh the token and retry.",
  "reason": "token_expired"
}
```

The `reason` field is a stable, non-RFC extension. Clients that want to
branch without parsing free-form text should read `reason` — see the
"Reason codes" table below.

### G2 — Anonymous means "no header at all"

If a request has **no** `Authorization` header, the server may let it
through as anonymous (relevant for WebSocket upgrades that use DO session
auth, and for public landing pages). If a request has an `Authorization`
header that fails verification, the server returns 401 — **never**
silently demotes to anonymous.

This is the bug that caused our mid-session breakage in April 2026 —
expired bearers were getting anonymous props, so Claude.ai never saw a
401 and never refreshed.

### G3 — Refresh tokens rotate on every use

Per the upstream `@cloudflare/workers-oauth-provider` (≥ 0.2.4), every
successful `grant_type=refresh_token` exchange at `/token` issues **both**
a new access token AND a new refresh token. The old refresh token is
invalidated. This prevents replay if a refresh token leaks.

Clients must persist the refresh token returned in each token response,
not keep using the one they got at initial authorization.

### G4 — Stream connections emit `auth_expired` before closing

Long-running SSE streams (`/scaffold/:sid/stream`, `/live-feed/*/stream`)
would otherwise keep pushing events past their stream token's 1-hour TTL.
Just before the token expires (default 5-second margin), the server
injects:

```
event: auth_expired
data: {"reason":"stream_token_expired","next":"refresh"}
```

…then closes the stream cleanly. Clients should:

1. Listen for `event: auth_expired` in their SSE reader.
2. On receipt, request a fresh stream token from the orgx web app
   (not from orgx-mcp — the web app issues stream tokens).
3. Reconnect, resuming from the last event ID if the endpoint supports it.

### G5 — Session-token failures report their reason

`POST /session-tokens` (internal, for agent workers) returns session
tokens bound to a specific `sessionId`/`orgId`/`userId`. When a caller
presents an expired session token, the server's 401 carries
`reason: "session_expired"` — the caller should re-issue by hitting
`/session-tokens` again with the server-to-server shared secret.

A `reason: "invalid_token"` from session-token validation means something
else went wrong (wrong signing key, corrupted payload) — refreshing won't
help, and the caller should fail loudly rather than loop.

## Reason codes

The `reason` field in every 401 body is one of:

| `reason`                 | Meaning                                         | Client action          |
|--------------------------|-------------------------------------------------|------------------------|
| `missing_token`          | Bearer scheme present but no token value        | Attach bearer, retry   |
| `invalid_token`          | Token signature invalid, malformed, or unknown  | Refresh once, then reauth |
| `token_expired`          | Access token past its `exp`                     | Refresh, retry         |
| `session_expired`        | Session token past its 1-hour TTL               | Re-request `/session-tokens` |
| `stream_token_expired`   | Stream token past its 1-hour TTL                | Request new stream token, reconnect |
| `stream_token_invalid`   | Stream token failed signature check             | Request new stream token — don't retry same one |

## Client behaviour — what you need to implement

### Proactive refresh (preferred)

Refresh **before** the token expires, not on 401. Pick a threshold at
~90 % of `expires_in`:

```ts
const refreshAtMs = issuedAtMs + expiresInSec * 1000 * 0.9;
```

A timer at `refreshAtMs` calls `/token` with the refresh token and swaps
the bearer into the in-flight header factory. This avoids the race where
a tool call is mid-flight when the token flips to expired.

### Reactive refresh (fallback)

When a 401 arrives with `error="invalid_token"`:

1. Exchange the refresh token at `/token` for a fresh access token.
2. Retry the original request exactly once with the new bearer.
3. If the retry also 401s, surface "Reconnect OrgX" UI — do **not** loop.

Implementations that retry blindly on 401 without refreshing first cause
the "reauth modal appears every few minutes" anti-pattern our users have
complained about.

### MCP session state survives refresh

The `mcp-session-id` header is the conversation state; the bearer is
just the key. Do not regenerate the session ID on refresh — the server
keys conversation context by session ID, not by bearer.

### Long-running tool calls

For tool calls that stream or take multiple minutes (scaffold builds,
search aggregations):

- Start the tool call with a bearer that has ≥ 5 min of TTL remaining.
  If the current token has less than that, refresh first.
- If you receive `event: auth_expired` during the stream, complete the
  tool call's refresh in the background and reconnect — don't tear down
  and restart.

### Logging

Client logs must include the `reason` field from the 401 body. "Got a
401" without the reason is useless for debugging; the reason tells
whether a refresh was attempted or would have helped.

## Security properties we do not trade away

- Refresh tokens rotate on every use — a leaked refresh token is valid
  for exactly one exchange.
- Refresh tokens are invalidated on sign-out and on Clerk password-change
  events (via Clerk webhook → OAuth provider callback).
- We do not issue "sliding expiry" tokens. The `exp` on every token is
  set at issuance and never extended mid-life.
- The `error_description` and `reason` fields never include the token
  value, the user identifier, or the token's `exp` / `iat`.
- The `auth_expired` SSE event is scoped to the token lifecycle — no user
  identity or session data is included.
- `Cache-Control: no-store` on every 401 prevents stale rejections from
  trapping the client in a loop.

## References

- RFC 6750 — OAuth 2.0 Bearer Token Usage (§3 on `WWW-Authenticate`)
- RFC 9728 — OAuth 2.0 Protected Resource Metadata
- [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
  — upstream library for `/mcp` and `/sse` protection
- `src/authErrors.ts` — the single place that builds 401 responses
- `src/requestAuth.ts` — non-provider path auth logic
- `src/streamToken.ts` — stream-token signing, verification, and SSE expiry wrapper
- `src/sessionToken.ts` — session-token signing, verification
