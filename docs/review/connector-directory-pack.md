# OrgX MCP Connector Review Pack

## Category

Organizational memory for AI agents / AI team control plane

## Primary use cases

- Remember and recall decisions
- Review agent decisions awaiting approval
- Search team memory and artifacts
- Delegate work to specialist agents
- Track project/initiative health
- Render decision, memory, task, and status widgets

## Read actions

- recall_memory
- track_project_progress
- query_org_memory
- get_decision_history
- get_pending_decisions
- get_agent_status
- get_initiative_pulse
- get_org_snapshot

## Write actions

- remember_decision
- approve_agent_work
- delegate_agent_task
- approve_decision
- reject_decision
- create_decision
- spawn_agent_task
- scaffold_initiative
- create_task
- update_entity

## Human confirmation model

Write actions require explicit user confirmation where appropriate. Approval and rejection tools must only run after the user confirms.

## OAuth

OAuth 2.x with PKCE and dynamic client registration.

## Data handling

OrgX stores organizational execution context: decisions, tasks, initiatives, artifacts, agent activity, and approval state. OAuth scopes are declared in `server.json`; users can revoke connector access through their MCP client and OrgX account controls. See `docs/security-data-handling.md` and `docs/privacy-policy.md` for retention, storage, and revocation details.

## Widgets

- decisions widget
- memory search results widget
- initiative pulse widget
- agent status widget
- task spawned widget
- morning brief widget
