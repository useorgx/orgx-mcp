# Anthropic Directory Readiness

This checklist is the repository-side handoff for Anthropic MCP Directory submission and follow-up review.

## Scope

OrgX MCP is a remote MCP server for:

- reviewing pending decisions,
- querying org memory,
- checking initiative health,
- scaffolding initiative hierarchies,
- assigning work to OrgX agents,
- rendering OrgX widgets in MCP Apps-compatible hosts.

## Reviewer package

Before submission, prepare all of the following:

1. A clean release commit and deployed production worker.
2. A provisioned reviewer account with representative sample data.
3. Secure delivery of reviewer credentials outside the repository.
4. Confirmed OAuth callback allowlists:
   - `http://localhost:6274/oauth/callback`
   - `http://localhost:6274/oauth/callback/debug`
   - `https://claude.ai/api/mcp/auth_callback`
   - `https://claude.com/api/mcp/auth_callback`
5. If a firewall or IP allowlist is enabled, Claude IP ranges allowlisted per Anthropic guidance.
6. Support, privacy, and security docs linked from the README.
7. Authenticated OrgX review routes available for the reviewer account:
   - `GET https://useorgx.com/api/review/anthropic/status`
   - `POST https://useorgx.com/api/review/anthropic/bootstrap`
   - `POST https://useorgx.com/api/review/anthropic/reset`
8. Reviewer runbook and release-manager checklist included in this repository.

## Pre-submission checks

Run:

```bash
pnpm type-check
pnpm vitest run
pnpm build
pnpm directory:preflight
```

## Minimum reviewer scenarios

Reviewers should be able to perform all of these on the provided account:

1. Read-only flow: `get_pending_decisions`, `get_agent_status`, `query_org_memory`, `get_initiative_pulse`.
2. Scoped write flow: approve or reject a seeded pending decision.
3. Hierarchy flow: scaffold a test initiative with workstreams, milestones, and tasks.
4. Widget flow: verify the corresponding widget renders for at least decisions, initiative pulse, agent status, and scaffolded initiative.

## Example prompts to include in the submission

1. "Show me the pending decisions that need approval today."
2. "Give me the pulse for the Search Copilot Readiness initiative."
3. "Scaffold a launch initiative with two workstreams, one milestone each, and two tasks per milestone."
4. "Assign the engineering agent a task to audit the onboarding funnel."

## Manual operational checklist

- Keep the reviewer account active throughout review and post-admission spot checks.
- Keep sample data seeded so the read-only tools and widgets are meaningful.
- Use the OrgX review routes to confirm the dedicated reviewer workspace is baseline-ready before any Claude smoke test.
- Use `bootstrap` when the workspace is missing or partially seeded; use `reset` when the reviewer changed data and you need to restore the clean baseline.
- Re-run the preflight script after auth, manifest, or tool-surface changes.
- Re-verify write tool annotations if new tools are added to the public directory surface.

## Public links

- Privacy Policy: <https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md>
- Security & Data Handling: <https://github.com/useorgx/orgx-mcp/blob/main/docs/security-data-handling.md>
- Support: <https://github.com/useorgx/orgx-mcp/blob/main/docs/support.md>
- Reviewer Runbook: <https://github.com/useorgx/orgx-mcp/blob/main/docs/anthropic-reviewer-runbook.md>
- Release Manager Checklist: <https://github.com/useorgx/orgx-mcp/blob/main/docs/anthropic-release-manager-checklist.md>
- Repository: <https://github.com/useorgx/orgx-mcp>
