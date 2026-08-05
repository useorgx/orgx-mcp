# OrgX MCP Connector Review Pack

## Category

Organizational memory for AI agents / AI team control plane

## Primary use cases

- Remember and recall decisions
- Read decisions awaiting approval
- Search team memory and artifacts
- Track project/initiative health
- Render memory, brief, initiative, and status widgets

## Anthropic directory endpoint

`https://mcp.useorgx.com/mcp?profile=claude-directory`

This review surface is intentionally read-only. The general OrgX profiles
retain write and delegation capabilities, but they are outside this directory
submission.

## Read actions

- orgx_bootstrap
- orgx_search
- orgx_inspect
- orgx_recommend
- get_agent_status
- get_initiative_pulse
- get_morning_brief
- get_operator_chronicle

## Excluded actions

All write, approval, rejection, delegation, hierarchy mutation, lifecycle, and
mixed-mode tools are excluded from the Anthropic directory profile.

## OAuth

OAuth 2.x with PKCE and dynamic client registration.

Every present MCP transport `Origin` is checked against an exact HTTPS
allowlist before auth or tool dispatch. Invalid origins return `403`; hosted
Claude is trusted explicitly, and no-`Origin` Claude Code/CLI traffic remains
supported.

## Data handling

OrgX stores organizational execution context: decisions, tasks, initiatives, artifacts, agent activity, and approval state. OAuth scopes are declared in `server.json`; users can revoke connector access through their MCP client and OrgX account controls. See `docs/security-data-handling.md` and `docs/privacy-policy.md` for retention, storage, and revocation details.

## Widgets

- memory search results widget
- initiative pulse widget
- agent status widget
- morning brief widget

These four MCP Apps widget resource families are intentionally exposed by the
directory profile. Pair the response evidence exactly as follows:

| Prompt | Screenshot |
|--------|------------|
| `What did we decide about Search Copilot readiness?` | <https://mcp.useorgx.com/screenshots/anthropic-memory-search-response.png> |
| `Show me what the OrgX agents are doing right now.` | <https://mcp.useorgx.com/screenshots/anthropic-agent-status-response.png> |
| `Give me the pulse for the Search Copilot Readiness initiative.` | <https://mcp.useorgx.com/screenshots/anthropic-initiative-pulse-response.png> |
| `Give me today's morning brief.` | <https://mcp.useorgx.com/screenshots/anthropic-morning-brief-response.png> |

All four are read-only response captures from the actual widget HTML and must
remain at least 1000 px on both axes. They contain no write or scaffold example.
