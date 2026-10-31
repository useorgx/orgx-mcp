# Registration-only smoke clients

The pinned OAuth provider (0.10.3) already expires ordinary dynamically
registered clients after 90 days by default. This change does not shorten
ordinary integration lifetimes, revoke existing clients, or rotate secrets.

The MCP smoke caller opts in to a separate registration-only canary using
`x-orgx-smoke-registration: 1` on `POST /register`. Only this metadata is
accepted in that mode:

```json
{
  "client_name": "OrgX MCP Smoke Test",
  "redirect_uris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
  "grant_types": [],
  "response_types": []
}
```

The same canonical OAuth provider generates and hashes the client secret.
Its client record receives an immutable five-minute deadline and an absolute
KV expiration in the same write. Authentication rejects a marked client at
that deadline even if KV still returns cached data. Unknown or malformed
markers fail closed; an ordinary provider update cannot renew the deadline.
These canary clients request no grant or response capabilities and cannot
exchange authorization codes or refresh tokens. Even an old Worker that
ignores the opt-in receives the same no-grants metadata.
Other smoke probes continue to use the caller's existing admitted bearer.

Before returning a successful registration response, the Worker deletes only
the just-created client key and adds `x-orgx-smoke-cleanup: complete`. It does
not scan customer grants, expose a management endpoint, or require a cleanup
credential. A cleanup failure returns a sanitized 503 without releasing the
generated credential. A lost response or interrupted Worker cannot extend
the five-minute deadline. Cleanup is idempotent; expired records are also
scheduled for exact-key deletion when encountered.

Deploy the Worker change before enabling the updated smoke caller. The
caller must require both the short expiry and cleanup confirmation, follow
no registration redirects, and omit client identifiers/secrets and raw
response/error text from diagnostics. An old Worker fails the expiry/cleanup
contract; it may retain an inert client with its ordinary TTL. Ship the
Worker first to avoid that historical-registration cleanup obligation.

This mode changes future opt-in registrations only. It does not identify or
delete historical smoke clients, which would need a separately scoped
inventory and revocation decision. No new cron, migration, binding, secret,
token scope, or ordinary OAuth lifetime is required.

Local verification uses the real pinned provider with an in-memory KV that
deliberately ignores expiration. Tests cover exact-boundary authentication,
stale reads, failed cleanup, a write that commits before throwing, interrupted
registration, malformed markers, deadline-preserving updates, token-grant
rejection, concurrent requests, and an ordinary full OAuth flow. Browser
suites and the existing required CI remain independent release gates.
