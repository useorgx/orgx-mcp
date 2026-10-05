# OpenAI ChatGPT App Review Runbook

This runbook is the reviewer-facing QA plan for resubmitting OrgX after the OpenAI rejection for inconsistent test-case results and incomplete privacy disclosure.

## Scope

Use this runbook before each OpenAI app submission or resubmission. It verifies that:

- submitted ChatGPT test prompts map to exact MCP tools,
- expected outputs are deterministic and reviewable,
- every submitted tool publishes an exact, tool-specific `outputSchema`,
- every enabled ChatGPT and Codex review surface uses the same seeded
  workspace baseline,
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
- Terms URL: `https://useorgx.com/terms`

## Current Plugin Portal Checklist

Submit through the OpenAI Platform plugin portal at
<https://platform.openai.com/plugins>. Use submission type **With MCP** and
enter the production Universal URL directly. Do not reference an older
integration ID. `chatgpt-app-submission.json` remains the checked-in source of
truth for listing copy, annotations, and tests and uses the current
`https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json`
package schema, but it is not proof that the current portal supports JSON
import.

Before opening review, confirm all of the following in the portal:

- the submitting organization has verified OrgX business identity and the
  operator has Apps Management read/write access, including `api.apps.write`;
- the selected project uses global, not EU-only, data residency;
- website, support, privacy, terms, category, short and long descriptions,
  starter prompts, country/region availability, localization, and release
  notes are populated with one consistent OrgX publisher identity;
- each positive test includes the dedicated seeded-workspace fixture and
  access instructions required to reproduce its expected result;
- the reviewer login is already populated and works without signup, MFA, SMS,
  email confirmation, or private-network access;
- a fresh **Scan Tools** result matches the deployed tool names,
  descriptions, schemas, security schemes, annotations, `_meta`, UI resources,
  CSP, and verified domains;
- every one of the 27 `chatgpt` profile tools has a non-null, exact
  `outputSchema`, and every standard widget resource includes
  `_meta.ui.domain=https://mcp.useorgx.com` on that profile;
- no other version of this MCP-backed plugin is already under review.

Current first-party submission requirements require a reviewer-accessible
demo-recording URL for remote MCP submissions. Provide a walkthrough of the
main use cases and tools across the supported platforms. For a plugin with UI, use authentic captures from
enabled review surfaces; do not substitute local fixtures or synthetic renders.

Current first-party references: [plugin submission](https://developers.openai.com/plugins/deploy/submission),
[app review requirements](https://developers.openai.com/plugins/deploy/app-review),
[plugin guidelines](https://developers.openai.com/plugins/app-guidelines), and
[ChatGPT/Codex testing](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Seven submitted tools are strictly read-only: `orgx_inspect`,
`review_artifact`, `get_morning_brief`, `get_operator_chronicle`,
`check_execution_readiness`, `orgx_command_status`, and `orgx_panel_snapshot`. Four informational tools use
`readOnlyHint: false` because a successful mode records metered MCP allowance
usage: mixed `orgx_search`, default `orgx_recommend`, `get_agent_status`, and
`get_initiative_pulse`. All eleven are non-destructive and closed-world.

`orgx_panel_snapshot` is app-only (`ui.visibility: ["app"]`) and backs the
OrgX panel's global (sidebar) and thread entrypoints. It reads the session
workspace's pending decisions and accepted proof, and never takes a
workspace argument. Approve and Send back in the panel call
`orgx_widget_decide` with a single-use token from the result `_meta`, which
the model never sees.

`orgx_submit_receipt` renders the Receipt widget
(`ui://widget/proof-receipt.html`): how far the proof got (recorded,
evidence, verified, outcome), the attached evidence, what is missing before it
counts as proof, and the next move. Its result carries `proof`, a bounded echo
of the submitted input only (receipt type, status, anchor ids, artifact and
agent type, stated outcome, model tier, and at most twelve evidence rows with
http(s) URLs), so the widget never infers what was claimed. The widget is
read-only; evidence and the anchored work open through the host, and only on
the declared OrgX and GitHub origins.

The consolidated `orgx_decide` and `approve_agent_work` routers also use
`readOnlyHint: false`, `openWorldHint: false`, and `destructiveHint: false`.
Their create/remember/list paths can write private state or record usage, while
approve/reject only validate the request and return the human-session review
URL; they never resolve a decision or resume execution from MCP. The legacy
`approve_decision` and `reject_decision` tools remain compatibility entrypoints
that open the human decision surface. Without a widget approval token, they
return `direct_human_decision_action_required`; a model cannot settle a decision.
Their display titles explicitly say they open approval or rejection review.
Keep their action IDs and input schemas stable for already-approved clients.

Widget resource metadata is profile-aware. The explicit `chatgpt` profile
publishes the standard MCP Apps `ui.domain` for `https://mcp.useorgx.com`.
Claude and every non-ChatGPT profile omit `ui.domain` so the host can assign
its required sandbox origin. Resource CSP is limited to the MCP origin and
`https://cdn.useorgx.com`; outbound widget links remain limited to the declared
OrgX and GitHub origins. No wildcard is permitted.

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

## One Contract, Widget-Only Tools, and Connector Refresh

`tests/surfaceContract.spec.ts` runs the real worker per profile and fails CI
when any of these drift: the runtime `tools/list`, the bootstrap's
`visible_tools` + `widget_only_tools`, `chatgpt-app-submission.json`,
`server.json` (v2), the output schemas, the widget templates (every
`outputTemplate` is a served resource), and the tools each served widget calls
(`src/widgetToolContract.ts`).

Visibility has one rule (`src/toolVisibility.ts`): every listed tool is
model-callable (`ui.visibility: ["model","app"]`, `openai/visibility:
"public"`) except the three widget-only tools, which are hidden from the model
and callable by widgets (`ui.visibility: ["app"]`, `openai/visibility:
"private"`, `openai/widgetAccessible: true`):

- `orgx_widget_decide` — settles a decision after a person clicks; it also
  requires the single-use HMAC widget approval token the model never sees;
- `orgx_panel_snapshot` — the OrgX panel's read;
- `resume_agent_run` — the agent-status widget's Resume button.

Every tool a widget calls is also `openai/widgetAccessible: true`. The
widget runtime rewrites the legacy `get_pending_decisions` refresh to
`orgx_decide action=list_pending`, which is on every profile that serves the
decisions widget.

`orgx_decide` and `approve_agent_work` with `action=approve|reject` return a
normal result, `status: "needs_human"` with `review_url`; the decision is
never settled from MCP.

ChatGPT imports a connector's tool list when the connector is created or
refreshed, and a widget call to a tool missing from that import fails inside
ChatGPT with `{"detail":"MCP Resource not found"}` before reaching OrgX. After
any deploy that adds, removes, renames, or changes the visibility of a tool,
open the connector in ChatGPT, select **Refresh**, and start a new
conversation. Point developer-mode connectors at
`https://mcp.useorgx.com/mcp?profile=chatgpt` (the reviewed surface); the
default `/mcp` (v2) also carries every widget-called tool.

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

Run the submitted prompts only against a dedicated OpenAI review workspace.
Before each supported-surface run, reset or bootstrap that workspace so the
baseline is stable.

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

## Supported-Surface Verification

Run every submitted positive and negative test on every surface enabled in the
portal. At minimum, cover the current ChatGPT and Codex surfaces selected for
publication:

1. ChatGPT web/desktop with the OpenAI review account connected to the
   dedicated workspace.
2. Codex with the same OrgX account and reset workspace when Codex is enabled.
3. Any additional portal-selected surface, including mobile if the portal
   offers and enables it for this release.

For each run, capture:

- prompt text,
- tool called,
- whether the widget loaded,
- visible response summary,
- any UI loading, image, or console error,
- pass/fail against the expected result.

Do not mark the plugin ready for resubmission until every positive and negative
case passes on every enabled surface.

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

## Output Schema Submission Gate

OrgX treats a missing or catch-all `outputSchema` on any submitted tool as a
blocking current-release gate. Do not submit or resubmit until a fresh
`tools/list` confirms that all 27 `chatgpt` profile tools publish exact,
tool-specific schemas. A permissive catch-all `outputSchema` is not an
acceptable substitute because it does not describe the object the tool actually
returns.

Contract references: [OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server),
[OpenAI Plugins reference](https://developers.openai.com/plugins/reference),
and the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

The worker maps each submitted tool to its exact structured-result schema and
never substitutes a blanket schema. Keep `additionalProperties: false` where a
returned object is closed, and validate representative success, empty,
auth-error, validation-error, and provider-error results. Rerun
`pnpm test:openai-review` plus the authenticated enabled-surface cases after any
schema change.

## Resubmission Notes

In the OpenAI plugin portal release notes, summarize:

- privacy policy expanded to cover collected data, tool inputs, tool outputs, recipients, retention, and user controls,
- submitted test cases rewritten with exact expected tool names and deterministic seeded outputs,
- enabled ChatGPT/Codex surface verification rerun against the dedicated
  review workspace,
- all 26 submitted tools published exact `outputSchema` contracts and the
  profile-aware widget domain/CSP contract passed a fresh portal scan,
- output audit completed to remove unnecessary identifiers and secrets.

Approval and publication are separate states. After approval, publish the
approved version explicitly in the portal and retain that publication receipt.
