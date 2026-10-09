# OrgX operation catalog pull requests

Use the [complete before-and-after tool inventory](tool-inventory-before-after.md) and [technical architecture](architecture/orgx-mcp-operation-boundary-2026-10-08.md) alongside these PRs. The rollout is a coordinated update and reconnect; no quiet period or historical-session migration is required.

| Repository | PR | Result |
| --- | --- | --- |
| OrgX core | [#3432](https://github.com/hopeatina/orgx/pull/3432) | Workspace-scoped workflow services, plan CAS completion, portable receipt admission/reads, atomic artifact review, and signed receipt judgments bound to database-owned document revisions. |
| OrgX MCP and ChatGPT plugin | Pending PR creation | Default 48 descriptors, explicit operation adapters, current widgets, observed transport outcomes, and reproducible ChatGPT 1.1.0 package. |
| Claude Code | [#47](https://github.com/useorgx/orgx-claude-code-plugin/pull/47) | Current seven-tool read-only profile and exact required initiative inputs. |
| Cursor | [#30](https://github.com/useorgx/cursor-plugin/pull/30) | Current v2 operations, rules, commands, skills and portable receipt instructions. |
| Grok | [#3](https://github.com/useorgx/orgx-grokbot-plugin/pull/3) | Both MCP configs and actual workflow/result instructions advance together. |
| Codex | [#75](https://github.com/useorgx/orgx-codex-plugin/pull/75) | Keep the signed commander execution contract; correct discovery diagnostics and actual brief-result paths. |
| OpenCode | [#51](https://github.com/useorgx/orgx-opencode-plugin/pull/51) | Explicit hosted discovery in continuity health; Gateway execution is unchanged. |
| DeepSeek Harness | [#5](https://github.com/useorgx/orgx-deepseek-harness-plugin/pull/5) | Explicit hosted discovery and deterministic cancellation verification. |
| OpenClaw | [#337](https://github.com/useorgx/openclaw-plugin/pull/337) | Explicit secondary hosted profile and separation of local gateway credentials during repair; local MCP tools retain their own contract. |
| Wizard | [#144](https://github.com/hopeatina/orgx-wizard/pull/144) | Current immutable client pins, atomic installs, case-insensitive profile headers and consistent query precedence. |
| TypeScript SDK | [#10](https://github.com/useorgx/orgx-sdk-typescript/pull/10) | Complete portable v0.2 typing and exact document forwarding. |

Python SDK, Gateway SDK, and local shell have no hosted MCP tool coupling and need no source change or metadata-only PR.

## Deployment order

1. Apply the two reviewed SQL migrations and deploy OrgX core services from #3432.
2. Deploy the current MCP operation catalog and its generated widget resources.
3. Update client packages/instructions and Wizard together. Wizard pins the reviewed Claude, Cursor and Codex source commits, which are already pushed. Reconnect hosts to import the new catalog and widgets.
4. Run authenticated host workflows and submit the reproducible ChatGPT 1.1.0 package through the publisher portal. Portal scanning and publication are separate from source verification.

Each PR records its own validation scope. Independent published-diff reviews fixed incorrect client response paths, missing initiative identifiers, local-to-hosted credential carryover, and conflicting profile headers. Core/MCP review also fixed stale plan completion, receipt revision races, result-schema mismatches, and lost receipt review context. The PRs do not merge, migrate production databases, deploy services, publish packages, or prove installed host versions.
