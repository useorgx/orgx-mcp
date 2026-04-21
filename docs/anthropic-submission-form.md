# Anthropic MCP Directory — Submission Form Copy

Paste-ready answers for the submission form at <https://clau.de/mcp-directory-submission>.
Keep this file in sync with `server.json` and `docs/anthropic-reviewer-runbook.md` — if
either changes, update this doc the same day.

## Server basics

| Field | Value |
|-------|-------|
| Server name | OrgX MCP |
| Tagline (≤80 chars) | Agent orchestration, decisions, and org memory for every MCP client. |
| Server URL | `https://mcp.useorgx.com/mcp` |
| Transport | Streamable HTTP (primary) · SSE (fallback) |
| Auth | OAuth 2.0 + PKCE · Dynamic Client Registration |
| Required scopes | `decisions:read` · `decisions:write` · `agents:read` · `agents:write` · `initiatives:read` · `initiatives:write` · `memory:read` · `offline_access` |
| Capabilities | tools, resources, prompts, apps (widgets) |
| Publisher | OrgX (`com.useorgx/orgx-mcp` in the official MCP Registry) |
| Support email | reviewers@useorgx.com |
| Privacy policy | <https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md> |
| Security docs | <https://github.com/useorgx/orgx-mcp/blob/main/docs/security-data-handling.md> |

## Branding assets (all 200 OK as of submission day)

| Purpose | URL |
|---------|-----|
| Square logo (1024 × 1024) | <https://mcp.useorgx.com/orgx-logo.png> |
| Favicon (multi-res .ico) | <https://mcp.useorgx.com/favicon.ico> |
| Screenshot — command center | <https://mcp.useorgx.com/screenshots/command-center.png> |
| Screenshot — morning brief | <https://mcp.useorgx.com/screenshots/morning-brief.png> |
| Screenshot — canvas | <https://mcp.useorgx.com/screenshots/canvas.png> |
| Screenshot — agent demo | <https://mcp.useorgx.com/screenshots/agent-demo.png> |
| Open Graph preview | <https://mcp.useorgx.com/screenshots/orgx-mcp-og.png> |

## Description (long-form)

OrgX is a cognitive operating system for organizations. The OrgX MCP server
lets any MCP client — Claude, Cursor, ChatGPT, Cline — drive an OrgX
workspace directly: review pending decisions, scaffold initiative
hierarchies, assign work to specialist agents, query organizational memory,
and watch initiative health in real time.

Unlike a project-management CRUD surface, OrgX is built around urgency-driven
hierarchy and surveillance calm: healthy state collapses to near-silence, the
blocker reshapes the interface when it matters. Every write is observable in
the user's live view at `useorgx.com/live/<initiative_id>`, and every widget
can drill down to act without leaving the chat.

Target user: a founder or operator delegating to autonomous agents, who wants
organizational memory, decision queues, and initiative pulses available
wherever they think.

## Use-case prompts to include in the submission

These match the reviewer runbook and the seeded reviewer workspace baseline.

1. *"Show me the pending decisions that need approval today."*
   Expected: decisions widget with three seeded pending decisions.
2. *"Give me the pulse for the Search Copilot Readiness initiative."*
   Expected: initiative-pulse widget with health + milestones + recent activity.
3. *"Show me what the OrgX agents are doing right now."*
   Expected: agent-status widget with the seeded roster.
4. *"Scaffold a launch initiative with two workstreams, one milestone each, and two tasks per milestone."*
   Expected: scaffolded-initiative widget with the newly-created hierarchy.

## OAuth callback support

OAuth is handled through Dynamic Client Registration. We verified against
`POST /register` that these callback URIs accept registration without errors:

- `http://localhost:6274/oauth/callback` (MCP Inspector debug)
- `http://localhost:6274/oauth/callback/debug`
- `https://claude.ai/api/mcp/auth_callback`
- `https://claude.com/api/mcp/auth_callback`

No static allowlist is required. Each Anthropic review run registers its own
client via DCR.

## Reviewer credential delivery

The reviewer URL and password are delivered **out of band** — never in this
form, never in the repo. Delivery channel for this submission:

> **[ fill before submitting: 1Password shared link, secure email, or Anthropic's reviewer portal ]**

The URL template the reviewer receives:
`https://useorgx.com/review/anthropic/<token>` (password-gated landing page
that seeds the demo workspace in one click, offers a copy-paste Claude MCP
URL, tracks prompt progress, and lets the reviewer reset state at any time).

See `docs/reviewer-invite-template.md` for the full email copy.

## Submission checklist (run before hitting submit)

- [ ] `pnpm type-check && pnpm vitest run && pnpm build && pnpm directory:preflight` green locally.
- [ ] `MCP_BASE_URL=https://mcp.useorgx.com pnpm directory:preflight` green against production.
- [ ] Every asset URL in the table above returns 200 (curl -I).
- [ ] Reviewer session minted via `tsx scripts/review-session.ts mint` and tested end-to-end.
- [ ] Reviewer URL + password delivered out of band and confirmation captured.
- [ ] server.json version matches the latest deployed worker version.

## After submission

Save confirmation screenshot to `docs/evidence/anthropic-submission.png` and
update the initiative `t_submit_anthropic` task with the submission ID.
