# Anthropic Directory Readiness

This checklist is the repository-side handoff for Anthropic MCP Directory submission and follow-up review.

## Scope

OrgX MCP is a remote MCP server for organizational continuity for AI agents.
Make AI work resumable, reviewable, and provable across agents. It delivers
that continuity through a deliberately read-only directory surface:

- remembering and recalling decisions,
- querying team memory and artifact context,
- checking initiative health and blockers,
- viewing current agent status,
- reading morning briefs and operator proof context,
- rendering OrgX widgets in MCP Apps-compatible hosts.

## Directory Review Endpoint

Submit this scoped endpoint to Anthropic:

`https://mcp.useorgx.com/mcp?profile=claude-directory`

The `claude-directory` profile exposes eight focused read-only tools:

- `orgx_bootstrap`
- `orgx_search`
- `orgx_inspect`
- `orgx_recommend`
- `get_agent_status`
- `get_initiative_pulse`
- `get_morning_brief`
- `get_operator_chronicle`

The general-purpose endpoint and other profiles continue to support writes,
approvals, delegation, and lifecycle operations. Those capabilities are not
part of this directory submission and must not appear during its tool scan.

Auxiliary discovery is scoped too: this profile advertises no prompts, no
downloadable skill packs, and no generic initiative resource. It publishes
only the search-results, agent-status, initiative-pulse, and morning-brief
widget resources used by the selected tools.

OAuth discovery metadata is origin-wide because all profiles share one issuer
and well-known metadata can be cached independently of the MCP query string.
It therefore advertises the server's full supported scope vocabulary. The
directory profile reduces effective capability through its tool/resource/
prompt surface, and each selected tool advertises a read-only security scheme.
Do not claim that `?profile=claude-directory` narrows the issuer metadata itself.

## Reviewer package

Before submission, prepare all of the following:

1. A clean release commit and deployed production worker.
2. A provisioned reviewer account with representative sample data.
3. Secure delivery of reviewer credentials outside the repository.
4. Current OAuth compatibility evidence captured for both hosted Claude and
   Claude Code clients:
   - a protected MCP request returns `401` with `WWW-Authenticate`,
   - Dynamic Client Registration accepts the client-supplied redirect URI,
   - PKCE uses `S256`,
   - hosted Claude completes its current callback flow,
   - Claude Code completes callbacks on random loopback ports for both
     `localhost` and `127.0.0.1` (do not pin only port `6274`).
5. If a firewall or IP allowlist is enabled, Claude IP ranges allowlisted per Anthropic guidance.
6. Present HTTPS `Origin` headers are validated before MCP auth or dispatch;
   an invalid origin returns `403`, while no-`Origin` Claude Code/CLI traffic
   remains compatible.
7. Support, privacy, and security docs linked from the README.
8. Authenticated OrgX review routes available for the reviewer account:
   - `GET https://useorgx.com/api/review/sessions/<token>/status`
   - `POST https://useorgx.com/api/review/sessions/<token>/bootstrap`
   - `POST https://useorgx.com/api/review/sessions/<token>/reset`
9. Reviewer runbook and release-manager checklist included in this repository.
10. Four response-only PNGs generated from the actual widget HTML, each at
    least 1000 px on both axes and paired to the exact prompt shown below.

## Pre-submission checks

Run:

```bash
pnpm type-check
pnpm test:anthropic-review
pnpm build
pnpm directory:preflight
```

## Minimum reviewer scenarios

Reviewers should be able to perform all of these on the provided account:

1. Bootstrap flow: `orgx_bootstrap` returns the connected workspace and safe
   next steps without changing OrgX state.
2. Memory flow: `orgx_search` and `orgx_inspect` retrieve seeded decisions and
   artifacts.
3. Status flow: `get_agent_status` and `get_initiative_pulse` report current
   execution state.
4. Briefing flow: `orgx_recommend`, `get_morning_brief`, and
   `get_operator_chronicle` return decision support and proof context.
5. Tool scan: only the eight documented read-only tools are advertised.
6. Prompt/resource scan: no prompts or skill packs are advertised, and only
   the four documented read-only widget families are visible.
7. Origin check: a POST with `Origin: https://attacker.example` returns `403`,
   while the same unauthenticated request without `Origin` reaches the normal
   OAuth challenge instead of the origin guard.

## Example prompts to include in the submission

1. "Start OrgX and show my workspace context."
2. "What did we decide about Search Copilot readiness?"
3. "Give me the pulse for the Search Copilot Readiness initiative."
4. "Show me what the OrgX agents are doing right now."
5. "Give me today's morning brief."

## Response screenshot pack

The directory submission intentionally exposes four MCP Apps widget resource
families. Submit these four response screenshots, not the older landing-page
or generic demo images:

| Prompt | Production asset |
|--------|------------------|
| `What did we decide about Search Copilot readiness?` | <https://mcp.useorgx.com/screenshots/anthropic-memory-search-response.png> |
| `Show me what the OrgX agents are doing right now.` | <https://mcp.useorgx.com/screenshots/anthropic-agent-status-response.png> |
| `Give me the pulse for the Search Copilot Readiness initiative.` | <https://mcp.useorgx.com/screenshots/anthropic-initiative-pulse-response.png> |
| `Give me today's morning brief.` | <https://mcp.useorgx.com/screenshots/anthropic-morning-brief-response.png> |

Run `pnpm screenshots:anthropic` to regenerate the deterministic assets before
the release gates. The fixtures demonstrate read-only responses only; they do
not demonstrate writes, approvals, delegation, or initiative scaffolding.

## Manual operational checklist

- Keep the reviewer account active throughout review and post-admission spot checks.
- Keep sample data seeded so the read-only tools and widgets are meaningful.
- Use the OrgX review routes to confirm the dedicated reviewer workspace is baseline-ready before any Claude smoke test.
- Use `bootstrap` when the workspace is missing or partially seeded; use `reset` when the reviewer changed data and you need to restore the clean baseline.
- Re-run the preflight script after auth, manifest, or tool-surface changes.
- Fail the review handoff if any write-capable or mixed-mode tool appears in
  the `claude-directory` scan.

## Public links

- Privacy Policy: <https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md>
- Security & Data Handling: <https://github.com/useorgx/orgx-mcp/blob/main/docs/security-data-handling.md>
- Support: <https://github.com/useorgx/orgx-mcp/blob/main/docs/support.md>
- Reviewer Runbook: <https://github.com/useorgx/orgx-mcp/blob/main/docs/anthropic-reviewer-runbook.md>
- Release Manager Checklist: <https://github.com/useorgx/orgx-mcp/blob/main/docs/anthropic-release-manager-checklist.md>
- Repository: <https://github.com/useorgx/orgx-mcp>
