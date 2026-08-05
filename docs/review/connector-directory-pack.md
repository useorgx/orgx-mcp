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

This review surface is intentionally non-destructive and closed-world. Three
tools are strictly read-only; mixed `orgx_search`, default `orgx_recommend`,
`get_agent_status`, and `get_initiative_pulse` record metered MCP allowance usage and are
therefore annotated non-read-only. The general OrgX profiles retain business
record writes and delegation capabilities, but they are outside this directory
submission.

## Informational actions

- orgx_search
- orgx_inspect
- orgx_recommend
- get_agent_status
- get_initiative_pulse
- get_morning_brief
- get_operator_chronicle

## Excluded actions

All business-record writes, approval, rejection, delegation, hierarchy
mutation, lifecycle, external-action, and destructive tools are excluded from
the Anthropic directory profile.

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
directory profile. Response screenshots remain pending until they are captured
from authenticated post-deploy Claude runs using the exact reviewer prompts.
Synthetic fixtures and local widget renders are not submission evidence.
