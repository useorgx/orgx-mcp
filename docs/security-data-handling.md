# OrgX MCP Security & Data Handling

This document summarizes the practical security posture of the `orgx-mcp` worker for reviewers, operators, and users.

## Authentication

- Authenticated access uses OAuth 2.0 authorization code flow with PKCE.
- Dynamic client registration is supported through `POST /register`.
- OAuth discovery metadata is served from the worker’s well-known endpoints.
- Callback allowlists must include:
  - `http://localhost:6274/oauth/callback`
  - `http://localhost:6274/oauth/callback/debug`
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`

## Access control

- Tool access is constrained by OAuth scopes.
- Write-capable tools are explicitly annotated as destructive and require auth.
- Read-only tools are annotated accordingly to preserve safe client behavior.

## Token and session handling

- OAuth state and session-bound context are persisted in Durable Objects.
- The worker issues and validates JWT access tokens for downstream OrgX API access.
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
