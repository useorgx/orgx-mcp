# OpenAI ChatGPT App Review Runbook

This runbook is the reviewer-facing QA plan for resubmitting OrgX after the OpenAI rejection for inconsistent test-case results and incomplete privacy disclosure.

## Scope

Use this runbook before each OpenAI app submission or resubmission. It verifies that:

- submitted ChatGPT test prompts map to exact MCP tools,
- expected outputs are deterministic and reviewable,
- web and mobile ChatGPT runs use the same seeded workspace baseline,
- tool responses do not return unnecessary personal identifiers, secrets, raw logs, request IDs, or trace IDs,
- the published privacy policy covers current tool inputs, outputs, recipients, retention, and user controls.

## Public MCP Endpoint

- MCP server URL: `https://mcp.useorgx.com/mcp`
- Product URL: `https://useorgx.com`
- Privacy policy URL: `https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md`
- Support URL: `https://github.com/useorgx/orgx-mcp/issues`

## Reviewer Workspace Baseline

Run the submitted prompts only against a dedicated OpenAI review workspace. Before each web or mobile run, reset or bootstrap that workspace so the baseline is stable.

Expected seeded data:

- 2 initiatives
- 3 workstreams
- 3 milestones
- 5 tasks
- 3 pending decisions

Key seeded initiative titles:

- `Search Copilot Readiness`
- `Workflow Capture Expansion`

Key seeded pending decisions:

- `Approve Search Copilot prompt pack`
- `Approve reviewer workspace reset policy`
- `Confirm widget parity sign-off threshold`

## Submitted Test Cases

These prompts must match `chatgpt-app-submission.json`.

| # | Prompt | Expected tool | Expected result |
|---|--------|---------------|-----------------|
| 1 | `Start OrgX and show my workspace context.` | `orgx_bootstrap` | Returns the connected workspace context, granted scopes, and safe next-step guidance without exposing access tokens, raw session IDs, or secrets. |
| 2 | `Show me the pending decisions that need approval today.` | `orgx_decide` | Returns the three seeded pending decisions with title, status, urgency or priority, and enough context to approve or reject. |
| 3 | `What did we decide about Search Copilot readiness?` | `orgx_search` | Returns prior decision and memory context for Search Copilot Readiness with relevant artifact or entity references. |
| 4 | `Give me the pulse for the Search Copilot Readiness initiative.` | `get_initiative_pulse` | Returns the seeded initiative health, blockers if present, milestone/task summary, and the initiative-pulse widget. |
| 5 | `Show me what the OrgX agents are doing right now.` | `get_agent_status` | Returns the seeded agent roster or active/idle agent state and the agent-status widget. |

## Negative Test Cases

| # | Prompt | Expected behavior |
|---|--------|-------------------|
| 1 | `What meetings do I have tomorrow?` | OrgX should not be invoked because calendar lookup is outside this app. |
| 2 | `Search the web for the latest OpenAI pricing.` | OrgX should not be invoked because generic web search is outside this app. |
| 3 | `Remember my personal coffee preference forever.` | OrgX should not be invoked because personal preference memory is outside this app's organizational-memory scope. |

## Web And Mobile Verification

Run all submitted test cases twice:

1. ChatGPT web with the OpenAI review account connected to the dedicated workspace.
2. ChatGPT mobile with the same account and same workspace after resetting the seed state.

For each run, capture:

- prompt text,
- tool called,
- whether the widget loaded,
- visible response summary,
- any UI loading, image, or console error,
- pass/fail against the expected result.

Do not mark the app ready for resubmission until every positive and negative case passes on both web and mobile.

## Output Privacy Audit

During developer-mode QA, inspect actual tool responses for the submitted prompts and record all user-related fields returned by each tool, including nested widget payloads. Remove unnecessary data instead of merely disclosing it.

Disallowed in normal reviewer outputs:

- raw access tokens, refresh tokens, cookies, API keys, passwords, or MFA codes,
- internal request IDs, trace IDs, log dumps, or stack traces,
- unrelated personal identifiers,
- unrelated account, org, or workspace IDs not needed to complete the request.

Allowed when needed for the user request:

- OrgX entity titles, statuses, types, priorities, summaries, owner or agent labels, artifact metadata, and deep links,
- workspace or entity references needed for follow-up actions,
- policy/auth blockers stated without exposing secrets.

## Resubmission Notes

In the OpenAI dashboard release notes, summarize:

- privacy policy expanded to cover collected data, tool inputs, tool outputs, recipients, retention, and user controls,
- submitted test cases rewritten with exact expected tool names and deterministic seeded outputs,
- web and mobile verification rerun against the dedicated review workspace,
- output audit completed to remove unnecessary identifiers and secrets.
