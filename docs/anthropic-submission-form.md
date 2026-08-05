# Anthropic MCP Directory — Submission Form Copy

Paste-ready answers for the submission form at
<https://claude.ai/admin-settings/directory/submissions/new>.
Keep this file in sync with `server.json` and `docs/anthropic-reviewer-runbook.md` — if
either changes, update this doc the same day.

## Server basics

| Field | Value |
|-------|-------|
| Server name | OrgX MCP |
| Tagline (≤80 chars) | Organizational continuity for AI agents. |
| Server URL | `https://mcp.useorgx.com/mcp?profile=claude-directory` |
| Transport | Streamable HTTP (primary) · SSE (fallback) |
| Auth | OAuth 2.0 + PKCE · Dynamic Client Registration |
| Directory surface | 8 focused read-only tools; no writes, approvals, delegation, or lifecycle mutation |
| Read scopes used | `decisions:read` · `agents:read` · `initiatives:read` · `memory:read` |
| Capabilities | 8 read-only tools and 4 read-only widget families; no prompts, skill packs, or generic initiative resource on this profile |
| HTTPS Origin validation | Yes — every present MCP transport `Origin` is exact-allowlisted before auth/dispatch; invalid origins return `403`; no-`Origin` CLI traffic remains supported |
| Publisher | OrgX (`com.useorgx/orgx-mcp` in the official MCP Registry) |
| Support email | reviewers@useorgx.com |
| Privacy policy | <https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md> |
| Security docs | <https://github.com/useorgx/orgx-mcp/blob/main/docs/security-data-handling.md> |

## Branding assets (all 200 OK as of submission day)

| Purpose | URL |
|---------|-----|
| Square logo (1024 × 1024) | <https://mcp.useorgx.com/orgx-logo.png> |
| Favicon (multi-res .ico) | <https://mcp.useorgx.com/favicon.ico> |
| Response screenshot — memory search | <https://mcp.useorgx.com/screenshots/anthropic-memory-search-response.png> |
| Response screenshot — agent status | <https://mcp.useorgx.com/screenshots/anthropic-agent-status-response.png> |
| Response screenshot — initiative pulse | <https://mcp.useorgx.com/screenshots/anthropic-initiative-pulse-response.png> |
| Response screenshot — morning brief | <https://mcp.useorgx.com/screenshots/anthropic-morning-brief-response.png> |
| Open Graph preview | <https://mcp.useorgx.com/screenshots/orgx-mcp-og.png> |

The four response screenshots are the directory submission set. They are
captured from the actual MCP Apps widget HTML with read-only seeded tool
results, are each at least 1000 px on both axes, and map to these exact prompts:

| Screenshot | Paired prompt |
|------------|---------------|
| `anthropic-memory-search-response.png` | `What did we decide about Search Copilot readiness?` |
| `anthropic-agent-status-response.png` | `Show me what the OrgX agents are doing right now.` |
| `anthropic-initiative-pulse-response.png` | `Give me the pulse for the Search Copilot Readiness initiative.` |
| `anthropic-morning-brief-response.png` | `Give me today's morning brief.` |

Regenerate the deterministic set with `pnpm screenshots:anthropic`. Do not
substitute the older landing-page/demo images in `public/screenshots/`; those
are not response evidence for this submission.

## Description (long-form)

The task outlives the chat. OrgX lets the next agent continue from the
decisions, artifacts, approvals, owners, and proof the last agent left behind.
Make AI work resumable, reviewable, and provable across agents.

From any MCP client — Claude, Cursor, ChatGPT, Cline — agents can retrieve
decisions and artifacts, query organizational memory, read operator proof,
and watch initiative health in real time. The scoped Anthropic Directory
endpoint intentionally exposes only those read-only capabilities; the broader
OrgX service supports separately reviewed write workflows on other profiles.

Unlike a project-management CRUD surface, OrgX is built around urgency-driven
hierarchy and surveillance calm: healthy state collapses to near-silence, the
blocker reshapes the interface when it matters. Every write is observable in
the user's live view at `useorgx.com/live/<initiative_id>`. On the submitted
profile, widgets render read-only results and may deep-link to OrgX; they do
not expose an in-chat mutation or scaffold example.

Target user: a founder or operator delegating to autonomous agents, who wants
organizational memory, decision queues, artifact recall, and initiative pulses available
wherever they think.

## Use-case prompts to include in the submission

These match the reviewer runbook and the seeded reviewer workspace baseline.

1. *"Start OrgX and show my workspace context."*
   Expected: connected workspace context and safe read-only next steps.
2. *"What did we decide about Search Copilot readiness?"*
   Expected: memory search results with prior decision context and linked artifacts.
3. *"Give me the pulse for the Search Copilot Readiness initiative."*
   Expected: initiative-pulse widget with health + milestones + recent activity.
4. *"Show me what the OrgX agents are doing right now."*
   Expected: agent-status widget with the seeded roster.
5. *"Give me today's morning brief."*
   Expected: morning-brief widget with current decisions, risks, and initiative context.

## OAuth callback support

OAuth is handled through Dynamic Client Registration. Before submission,
capture a fresh hosted-Claude and Claude Code login receipt proving that the
client-supplied redirect URI is accepted, PKCE uses `S256`, and an
unauthenticated protected request returns `401` with `WWW-Authenticate`.

Claude Code uses random loopback ports. Validate both
`http://localhost:<random-port>/...` and
`http://127.0.0.1:<random-port>/...`; do not treat fixed port `6274` as the
complete callback contract. Use the exact hosted callback supplied by the
current Claude client rather than copying a stale URL from this document.

The authorization server's well-known metadata is shared across profiles and
advertises the full server scope vocabulary. The directory endpoint itself
exposes only read-only tools with read security schemes. Profile-specific
well-known scope reduction is not claimed because query-scoped issuer metadata
would be unsafe with a shared, cacheable OAuth issuer.

## Reviewer credential delivery

The reviewer URL and password are delivered **out of band** — never in this
file or the public repository. At submission time, use Anthropic's designated
private reviewer-credential field or another approved secure channel, then
retain the delivery confirmation in private operational evidence.

The URL template the reviewer receives:
`https://useorgx.com/review/anthropic/<token>` (password-gated landing page
that seeds the demo workspace in one click, offers a copy-paste Claude MCP
URL, tracks prompt progress, and lets the reviewer reset state at any time).

See `docs/reviewer-invite-template.md` for the full email copy.

## Submission checklist (run before hitting submit)

- [ ] `pnpm type-check && pnpm test:anthropic-review && pnpm build && pnpm directory:preflight` green locally.
- [ ] `MCP_BASE_URL=https://mcp.useorgx.com pnpm directory:preflight` green against production.
- [ ] An authenticated `tools/list` for `?profile=claude-directory` returns exactly the documented eight read-only tools.
- [ ] `prompts/list` is empty and `resources/list` contains only the four documented read-only widget families (including their version/host compatibility variants).
- [ ] Invalid-Origin POST returns `403`; trusted Claude Origin is echoed (not `*`); a no-Origin CLI request reaches the normal OAuth flow.
- [ ] Every asset URL in the table above returns 200 (curl -I).
- [ ] The four response screenshots match their paired prompts and remain at least 1000 px on both axes.
- [ ] Reviewer session minted via `tsx scripts/review-session.ts mint` and tested end-to-end.
- [ ] Reviewer URL + password delivered out of band and confirmation captured.
- [ ] server.json version matches the latest deployed worker version.

## After submission

Retain the provider confirmation screenshot and submission ID in private
operational evidence. Do not mark the connector approved or published until a
separate provider receipt proves that state.
