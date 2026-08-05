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

- MCP server URL: `https://mcp.useorgx.com/mcp?profile=chatgpt`
- The `chatgpt` profile exposes only the reviewer-facing canonical workflows
  and widgets. Internal coordination transports, redundant compatibility
  aliases, and `consolidate_pr` are intentionally excluded.
- Product URL: `https://useorgx.com`
- Privacy policy URL: `https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md`
- Support URL: `https://github.com/useorgx/orgx-mcp/issues`

Five submitted tools are strictly read-only: `orgx_inspect`,
`review_artifact`, `get_morning_brief`, `get_operator_chronicle`, and
`check_execution_readiness`. Four informational tools use
`readOnlyHint: false` because a successful mode records metered MCP allowance
usage: mixed `orgx_search`, default `orgx_recommend`, `get_agent_status`, and
`get_initiative_pulse`. All nine are non-destructive and closed-world.

The worker suppresses local session-context, activation/reentry, analytics,
diagnostic, and success-log writes for these informational tool executions as
defense in depth. That does not suppress documented upstream MCP allowance records
for the four non-read-only tools. The MCP framework may also persist protocol
initialization and connection/session lifecycle state outside a tool
invocation; this is not an endpoint-wide stateless guarantee.

Before review, request `https://mcp.useorgx.com/healthz?check=upstream` and
confirm the primary upstream is healthy at `https://useorgx.com`. A
`fallback_healthy` result proves failover, not reviewer-ready primary latency;
fix or deploy the primary configuration before submitting.

## Optional Domain Challenge Route

The worker reserves `GET /.well-known/openai-apps-challenge` for OpenAI domain
verification. Configure `OPENAI_APPS_CHALLENGE_TOKEN` only if the submission
portal issues a new challenge. When configured, the route returns that exact
value as `text/plain` with `Cache-Control: no-store`; when unset, it fails
closed with `404`.

Do not commit the issued value. Enter it through Wrangler's interactive secret
prompt, deploy the worker, and compare the live response to the portal value
before asking the portal to verify the domain:

```bash
pnpm wrangler secret put OPENAI_APPS_CHALLENGE_TOKEN --env production
```

An already-verified domain does not require this binding. Removing or rotating
the binding is a separate production operation and should not be inferred from
local route tests.

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
| 5 | `Show me what the OrgX agents are doing right now.` | `get_agent_status` | Returns the seeded agent roster or active and idle agent state, and renders the agent-status widget without changing workspace state. |

## Negative Test Cases

| # | Prompt | Expected behavior |
|---|--------|-------------------|
| 1 | `What meetings do I have tomorrow?` | OrgX should not be invoked because calendar lookup is outside this app. |
| 2 | `Search the web for the latest OpenAI pricing.` | OrgX should not be invoked because generic web search is outside this app. |
| 3 | `Remember my personal coffee preference forever.` | OrgX should not be invoked because personal preference memory is outside organizational workflows. |

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

## Output Schema Reliability Warning

Missing `outputSchema` is a nonblocking submission warning. It does not block
generating, importing, or submitting the ChatGPT app submission JSON. Exact
tool-specific `outputSchema` declarations are still recommended because they
make structured results more reliable for clients and reviewers. A permissive
catch-all schema is not an acceptable substitute because it does not describe
the object the tool actually returns.

Contract references: [OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server),
[OpenAI Plugins reference](https://developers.openai.com/plugins/reference),
and the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

The worker currently omits a blanket output schema rather than advertising a
false contract. Add exact schemas incrementally at each tool definition, keep
`additionalProperties: false` where the returned object is closed, and validate
representative success, empty, auth-error, validation-error, and provider-error
results as each schema lands. Rerun `pnpm test:openai-review` plus the
authenticated ChatGPT web/mobile cases after each schema change; do not invent
a schema merely to silence the warning.

## Resubmission Notes

In the OpenAI dashboard release notes, summarize:

- privacy policy expanded to cover collected data, tool inputs, tool outputs, recipients, retention, and user controls,
- submitted test cases rewritten with exact expected tool names and deterministic seeded outputs,
- web and mobile verification rerun against the dedicated review workspace,
- output audit completed to remove unnecessary identifiers and secrets.
