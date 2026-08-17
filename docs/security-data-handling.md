# OrgX MCP Security & Data Handling

This document summarizes the practical security posture of the `orgx-mcp` worker for reviewers, operators, and users.

## Authentication

- Authenticated access uses OAuth 2.1 authorization code flow with PKCE S256.
- Dynamic client registration is supported through `POST /register`.
- OAuth discovery metadata is served from the worker’s well-known endpoints.
- OAuth clients register their current callback URI through Dynamic Client
  Registration. Hosted callbacks must match the URI supplied by the client.
- Local clients such as Claude Code use random loopback ports; validate both
  `localhost` and `127.0.0.1` rather than pinning only port `6274`.
- Production verification must cover PKCE `S256` and the protected-resource
  `401` response with `WWW-Authenticate`.

## Access control

- A versioned resource/action policy constrains both advertised tools and tool
  execution by the explicit OAuth grant.
- Write-capable tools declare their required scope and effect annotations;
  destructive hints are reserved for operations that can actually destroy or
  overwrite durable state.
- Read-only tools are annotated accordingly to preserve safe client behavior.
- MCP HTTP and WebSocket routes validate every present `Origin` header against
  an exact allowlist before OAuth, session state, or tool dispatch. Invalid or
  opaque origins receive `403`; allowed origins are echoed in CORS with
  `Vary: Origin` rather than a wildcard.
- CLI and server-to-server clients that omit `Origin` remain supported. Exact
  Claude, ChatGPT, OrgX web, and MCP origins are built in; operators can add a
  reviewed origin through `MCP_ALLOWED_ORIGINS` without widening to `*`.

## Token and session handling

- Short-lived OAuth authorization state is stored server-side; the browser sees
  only an opaque state key. Session-bound context is persisted in Durable
  Objects.
- The OAuth provider issues access and refresh tokens; the worker forwards only
  verified actor identity and scoped request context to the OrgX API.
- Session context is stored only to preserve continuity for the active user and workspace.

## Data minimization

- The worker forwards only the fields required to satisfy the requested tool call.
- Widget payloads are normalized to avoid duplicative text and oversized error payloads where possible.
- Internal caches are used only for short-lived optimization paths such as hydration tier lookups.

## Operational safety

- Secrets must not be logged or committed.
- Production access requires Cloudflare-managed secrets and OrgX service credentials.
- If the service is deployed behind a firewall, Claude IP ranges must be allowlisted as described in the Anthropic submission guidance.

## Billing and checkout behavior

- `account_upgrade` returns a checkout URL or contact path only after explicit user intent.
- The tool itself does not silently purchase a plan.
- Reviewers can omit billing flows from practical testing if they are not part of the primary connector experience.

## Reviewer guidance

- Use a dedicated review workspace with representative sample data.
- Keep reviewer credentials active throughout review and any follow-up audits.
- Share test credentials through a secure channel outside the public repository.
