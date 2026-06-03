# OrgX MCP Worker Privacy Policy

Last updated: June 3, 2026

This policy covers the public OrgX MCP worker hosted at `https://mcp.useorgx.com`, including ChatGPT Apps, MCP Apps-compatible clients, OAuth endpoints, tool calls, resources, and widgets served by this worker. The canonical repository is `https://github.com/useorgx/orgx-mcp`.

OrgX MCP connects a user-authorized MCP client, such as ChatGPT, Claude, Cursor, or another MCP-compatible client, to OrgX organizational memory and agent orchestration. It is intended for team decisions, initiatives, tasks, artifacts, approvals, agent work, and related operational context.

## Data We Process

The worker processes only the data needed to authenticate the client, run the requested tool, render the requested widget, and protect the service.

- Account and workspace context: OrgX user, organization, workspace, initiative, workstream, milestone, task, decision, artifact, agent, and plan-session records that are needed for the user-requested tool call.
- Tool inputs: prompts, search queries, entity IDs, workspace IDs, initiative names, task instructions, approval notes, rejection reasons, artifact URLs, GitHub pull request URLs, quality scores, activity updates, and other fields the user or client supplies to a tool.
- Tool outputs: decision titles and summaries, memory search results, initiative health, blockers, milestones, tasks, owners, agent status, artifact metadata, plan-session summaries, receipt summaries, activity events, billing or usage summaries, and structured widget payloads needed to display those results.
- OAuth and MCP session data: dynamic client registration metadata, authorization state, access tokens, refresh tokens, token expiry, granted scopes, MCP session IDs, session-bound workspace context, and PKCE/OAuth metadata.
- Operational telemetry: request timing, route names, tool names, status codes, rate-limit counters, non-secret diagnostic errors, truncated user-agent strings, and service health signals used to debug reliability and abuse prevention.
- Optional provenance data: source client, source runtime, provider preference, model tier, budget mode, job IDs, correlation IDs, and execution metadata supplied by the user or by an OrgX agent runtime for continuity and auditability.

## Sensitive Data Boundaries

OrgX MCP does not request passwords, MFA codes, payment card numbers, government IDs, biometric data, health records, or other highly sensitive identifiers. Users should not put secrets, private keys, passwords, tokens, or unrelated sensitive personal data into tool prompts, notes, metadata, artifact text, or URLs.

The worker may receive private business data if a user intentionally stores or retrieves it in OrgX, such as customer research notes, roadmap artifacts, decision rationale, agent task instructions, GitHub pull request links, or internal project context. The worker handles that data only for the OrgX workflow the user requested.

## How We Use Data

We use processed data to:

- authenticate MCP clients and users,
- enforce OAuth scopes, workspace access, and tool access controls,
- execute read and write tool calls requested by the user,
- return structured tool outputs and render MCP app widgets,
- preserve organizational continuity across sessions, tools, agents, and teammates,
- create, update, approve, reject, delegate, attach, or report on OrgX records when the user invokes write-capable tools,
- route agent work, validate budget controls, and record receipts when the user delegates agent work,
- debug service reliability, detect abuse, enforce rate limits, and maintain security,
- provide support and investigate issues reported by users or reviewers.

We do not sell MCP data, tool inputs, tool outputs, or connector data for advertising.

## Data Recipients And Processors

Data may be processed by:

- OrgX-operated application APIs and databases that store organizational memory, initiatives, tasks, decisions, artifacts, agent records, plan sessions, receipts, and workspace settings.
- Cloudflare infrastructure used to host the worker, Durable Objects, routing, security controls, and request handling.
- MCP clients selected and authorized by the user, including ChatGPT, Claude, Cursor, or other MCP-compatible clients that send tool calls and receive tool outputs.
- OpenAI, when the user connects OrgX as a ChatGPT app or tests OrgX in ChatGPT developer mode. ChatGPT receives the tool descriptors, user prompts, tool inputs it sends, tool outputs returned by OrgX, and widget resources needed to display the app experience.
- External services explicitly involved in a user-requested workflow, such as GitHub when a user asks OrgX to consolidate a pull request and the OrgX backend has the required server-side credentials.
- Payment or billing services only when the user explicitly starts an account upgrade or billing workflow. The MCP worker does not silently purchase a plan.

No repository-level MCP data is shared with advertisers or sold to data brokers.

## Retention

Retention depends on the data category.

- Durable OrgX records, such as decisions, tasks, initiatives, artifacts, agent receipts, and plan sessions, remain in OrgX until the user or workspace administrator deletes them or the workspace retention policy removes them.
- OAuth client registrations, access tokens, refresh tokens, authorization state, and MCP session state are retained only as long as needed to maintain the connection, honor refresh behavior, enforce access controls, and support security review. Tokens expire according to the configured OAuth lifetime.
- Operational telemetry and diagnostic logs are retained for the period needed to operate, debug, secure, and audit the worker, then deleted or aggregated according to OrgX operational retention practices.
- Public assets, documentation, and widget files are versioned with the repository and deployment artifacts.

## User Controls

Users and workspace administrators can:

- disconnect the OrgX app or MCP server from the MCP client, including ChatGPT, which stops that client from making further authenticated tool calls,
- revoke or rotate OAuth access by disconnecting the client or resetting credentials,
- delete, update, or correct OrgX records through OrgX product workflows and write-capable MCP tools when authorized,
- request support for deletion, export, or correction by contacting OrgX through GitHub Issues or the support channel listed below,
- avoid sending secrets or unrelated sensitive data in prompts, metadata, artifact text, or URLs.

If a client displays a privacy prompt before connection, users should review the data-sharing summary and this policy before authorizing OrgX.

## Security Baseline

- OAuth 2.0 authorization code flow with PKCE is used for authenticated access.
- Dynamic client registration is supported for MCP clients that require it.
- Tool access is gated by OAuth scopes and workspace membership.
- Read-only and write-capable tools are explicitly annotated in the MCP metadata.
- Session state is isolated in Durable Objects.
- Repository guidance forbids logging raw secrets, access tokens, refresh tokens, cookies, or passwords.
- Tool outputs should avoid unnecessary personal identifiers, internal trace IDs, raw logs, and secrets.

See [Security & Data Handling](./security-data-handling.md) for the operational security summary that accompanies this policy.

## Changes

This policy is versioned with the repository. Material changes should be reviewed alongside the connector release that introduces them and reflected in app submission metadata before resubmission.

## Support

For connector support, use [GitHub Issues](https://github.com/useorgx/orgx-mcp/issues) and include enough detail to reproduce the problem without sharing secrets. For privacy or data-control requests, include the OrgX workspace and account context needed to locate the data, but do not include tokens, passwords, cookies, or private keys.
