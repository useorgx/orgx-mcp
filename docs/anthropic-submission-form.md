# Anthropic MCP Directory — Submission Form Copy

Paste-ready answers for the submission form at
<https://claude.ai/admin-settings/directory/submissions/new>.
Keep this file in sync with `server.json` and `docs/anthropic-reviewer-runbook.md` — if
either changes, update this doc the same day.

## Server basics

| Field | Value |
|-------|-------|
| Server name | OrgX MCP |
| Tagline (≤55 chars) | Organizational continuity for AI agents. |
| Server URL | `https://mcp.useorgx.com/mcp?profile=claude-directory` |
| Transport | Streamable HTTP (primary) · SSE (fallback) |
| Auth | OAuth 2.0 + PKCE · Dynamic Client Registration |
| Permanent slug | `orgx-mcp` |
| Categories (1–5) | `Productivity` (add another current portal category only if its exact label applies) |
| Company website | <https://useorgx.com> |
| Documentation | <https://github.com/useorgx/orgx-mcp#readme> |
| Support URL | <https://useorgx.com/support> |
| Primary review contact | reviewers@useorgx.com |
| Directory surface | 7 focused, non-destructive, closed-world tools; 3 strictly read-only and 4 that record metered MCP allowance usage |
| Read scopes used | `decisions:read` · `agents:read` · `initiatives:read` · `memory:read` |
| Capabilities | 7 informational tools and 4 read-only widget families; no prompts, skill packs, or generic initiative resource on this profile |
| HTTPS Origin validation | Yes — every present MCP transport `Origin` is exact-allowlisted before auth/dispatch; invalid origins return `403`; no-`Origin` CLI traffic remains supported |
| Publisher | OrgX (`com.useorgx/orgx-mcp` in the official MCP Registry) |
| Support email | reviewers@useorgx.com |
| Privacy policy | <https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md> |
| Security docs | <https://github.com/useorgx/orgx-mcp/blob/main/docs/security-data-handling.md> |
| Allowed owned link origins | `https://useorgx.com` · `https://mcp.useorgx.com` |

The slug is a permanent identifier: confirm `orgx-mcp` is available before
submitting and do not change it to solve a listing-copy issue. Anthropic's MCP
Connector Directory does not require a separate DNS or `.well-known`
domain-ownership challenge; the owned link origins still need to be declared
for widget deep links.

## Branding assets (verify 200 on submission day)

| Purpose | URL |
|---------|-----|
| Square logo (1024 × 1024) | <https://mcp.useorgx.com/orgx-logo.png> |
| Favicon (multi-res .ico) | <https://mcp.useorgx.com/favicon.ico> |
| Open Graph preview | <https://mcp.useorgx.com/screenshots/orgx-mcp-og.png> |

Response screenshots are **pending authenticated post-deploy capture**. Upload
3–5 PNG files that are at least 1000 px wide, cropped to the Claude app
response only, and paired with the exact prompt text. Capture them only from
real Claude responses against the deployed `?profile=claude-directory`
endpoint and dedicated reviewer workspace. Local fixtures, synthetic renders, and generic demo images are not submission evidence and must not be uploaded.
Video and GIF files are also outside the accepted screenshot format.

## Data and ownership answers

Use these answers only if the current portal asks the corresponding question;
the live form wording is authoritative.

| Question | Answer |
|---|---|
| API ownership | OrgX owns and operates the first-party API and hosted MCP service. |
| Protected health information | No. OrgX MCP is not intended for PHI workflows. |
| Sponsored content | No. The connector does not inject sponsored content. |
| Other data handling | Private organizational execution context and standard MCP usage accounting, as disclosed in the privacy and security documents above. |

## Description (long-form)

The task outlives the chat. OrgX lets the next agent continue from the
decisions, artifacts, approvals, owners, and proof the last agent left behind.
Make AI work resumable, reviewable, and provable across agents.

From any MCP client — Claude, Cursor, ChatGPT, Cline — agents can retrieve
decisions and artifacts, query organizational memory, read operator proof,
and watch initiative health in real time. The scoped Anthropic Directory
endpoint intentionally exposes only non-destructive, closed-world capabilities;
the broader OrgX service supports separately reviewed write workflows on other
profiles. Three directory tools are strictly read-only. Four record metered
MCP allowance usage on a successful mode but do not change business records.

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

1. *"What did we decide about Search Copilot readiness?"*
   Expected: memory search results with prior decision context and linked artifacts.
2. *"Give me the pulse for the Search Copilot Readiness initiative."*
   Expected: initiative-pulse widget with health + milestones + recent activity.
3. *"Show me what the OrgX agents are doing right now."*
   Expected: agent-status widget with the seeded roster.
4. *"Give me today's morning brief."*
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
exposes only informational tools with read-scoped security schemes.
Profile-specific
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
- [ ] An authenticated `tools/list` for `?profile=claude-directory` returns exactly the documented seven tools, with three `readOnlyHint: true` and four `readOnlyHint: false`.
- [ ] Every submitted tool has a current human-readable `title` and all
  applicable tool hints in the portal scan.
- [ ] `prompts/list` is empty and `resources/list` contains only the four documented read-only widget families (including their version/host compatibility variants).
- [ ] Invalid-Origin POST returns `403`; trusted Claude Origin is echoed (not `*`); a no-Origin CLI request reaches the normal OAuth flow.
- [ ] Every branding asset URL in the table above returns 200 (curl -I).
- [ ] Three to five authenticated response PNGs, each at least 1000 px wide,
  were captured after deployment from real Claude runs, cropped to the app
  response only, matched to their exact prompts, and stored as private
  provider-upload evidence; no local fixture, video, or GIF is used.
- [ ] Reviewer session minted via `tsx scripts/review-session.ts mint` and tested end-to-end.
- [ ] Reviewer URL + password delivered out of band and confirmation captured.
- [ ] server.json version matches the latest deployed worker version.
- [ ] Permanent slug, 1–5 categories, documentation URL, company website,
  primary review contact, and allowed owned link origins are confirmed in the
  current portal.
- [ ] API ownership, PHI, sponsored-content, and other data-handling questions
  are answered truthfully.
- [ ] All seven compliance acknowledgements shown by the current portal are
  completed, and the final dashboard receipt is retained.

Current first-party references: [connector submission requirements](https://claude.com/docs/connectors/building/submission)
and the [Connector Directory overview](https://claude.com/docs/connectors/directory).

## After submission

Retain the provider confirmation screenshot and submission ID in private
operational evidence. Do not mark the connector approved or published until a
separate provider receipt proves that state.
