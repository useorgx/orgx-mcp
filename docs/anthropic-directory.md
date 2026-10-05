# Anthropic Directory Readiness

OrgX MCP makes AI work resumable, reviewable, and provable across agents. The
submitted endpoint covers organizational memory, planning, owned execution,
human decision review, linked artifacts, and completion evidence.

## Directory endpoint and contract

`https://mcp.useorgx.com/mcp?profile=claude-directory`

The directory has **29 captured tools: 28 model-visible operations and one
app-only agent-run resume action**. This is a workflow surface, not a tool-count
limit. The operation registry in `src/claudeDirectoryTools.ts` forwards to the
existing canonical handlers; it does not introduce another backend router.

| Workflow | Tools |
|---|---|
| Context and recall | `orgx_bootstrap`, `orgx_search`, `orgx_inspect`, `orgx_recommend` |
| Monitoring and reporting | `get_agent_status`, `get_initiative_pulse`, `get_morning_brief`, `get_operator_chronicle`, `orgx_command_status`, `check_execution_readiness` |
| Work records | `orgx_create_entity`, `orgx_update_entity`, `orgx_change_entity_state`, `manage_lifecycle` |
| Planning | `orgx_start_plan`, `orgx_read_plan`, `orgx_improve_plan`, `orgx_record_plan_edit`, `orgx_complete_plan` |
| Delegation | `orgx_check_delegation`, `orgx_delegate_work` |
| Decisions | `orgx_list_pending_decisions`, `orgx_record_decision`, `orgx_open_decision_review` |
| Deliverables and proof | `review_artifact`, `orgx_attach`, `orgx_submit_receipt`, `orgx_complete_with_proof` |
| Human widget action | `resume_agent_run` (app-only) |

Read and write operations have separate contracts. Plan retrieval cannot edit a
plan; delegation checks cannot dispatch work; decision listing cannot record a
decision. Create and update are separate tools. Model-triggered decision review
returns a human review URL and cannot settle an approval. Completion with proof
requires a linked deliverable. Arbitrary deletion and media generation are not
exposed. Delegation, launch, resume, and retry can execute paid agent work.

Tool titles are also present in `annotations.title`; safety hints describe each
operation. Four informational tools advertise `readOnlyHint: false` because
mixed search, recommendation, agent status, and initiative pulse record metered
MCP usage. Usage accounting is still a state change. Append-only artifacts,
receipts, and decisions differ from updates and execution controls.

OAuth retains the shared issuer's full scope vocabulary. The authenticated
connection's granted scopes filter discovery, and canonical invocation-time
checks enforce the selected operation's scope. Read grants cannot discover write
operations. The app-only resume action requires `agents:write` on this profile.
Unknown profile names still fail closed to the original seven informational
tools; the Claude Code plugin and OpenAI profiles retain their own contracts.

The worker suppresses optional session persistence, activation/reentry writes,
analytics, diagnostics, and success logs in this profile. Intended business
writes and documented upstream usage accounting remain enabled. The underlying
MCP framework may persist connection lifecycle state, so the endpoint is not
stateless.

No prompts, downloadable skill packs, or generic initiative resource are
advertised. Eight widget families are served: search-results, agent-status,
initiative-pulse, morning-brief, entity-card, work-ledger, workspace-map, and
proof-receipt. Planning and decision adapters return structured results; artifact
review returns its envelope without the incompatible shared action widget.

## Verification and reviewer access

Run `pnpm verify`, `pnpm test:anthropic-review`, and `pnpm directory:preflight`.
After deployment, repeat the preflight against production, inspect the
operation-specific tool list with MCP Inspector, and run the full reviewer
workflow in Claude. Local tests, CI, deployment, and live outcomes are separate
receipts. A health check or tool scan alone does not prove write functionality.

Use the existing dedicated Anthropic reviewer account and populated reviewer
workspace. Credentials belong only in Anthropic's private test instructions,
with authorized secure delivery, never in this repository. Confirm the reviewer
session's expiry, owner binding, baselineReady, and workspaceIsClean before QA.
Use the authenticated review status route; bootstrap/reset are separate fixture
operations and require deliberate authorization.

## Reviewer scenarios

1. Recall the Search Copilot readiness decision and inspect its linked proof.
2. Inspect initiative health and current agent status.
3. Create a uniquely named test task, update it, and read it back.
4. Start a plan, read it, record an edit, and complete it with final content.
5. Check execution readiness and estimate delegation without dispatch.
6. Record a test decision, list pending decisions, and open human review without
   settling it from MCP.
7. Attach a real artifact URL, submit an idempotent receipt, and complete the
   test task with proof; read back the resulting state and links.
8. Verify write-scope denial and that malformed/unsupported operations do not
   reach the backend.
9. Verify lifecycle controls using disposable reviewer work, with an explicit
   spend cap before any action that dispatches execution.

## Evidence and submission

Response screenshots are pending authenticated post-deploy capture. Supply 3–5
PNG images at least 1000 px wide from real Claude runs, cropped to the app
response and paired with exact prompts. Synthetic renders, local fixtures,
video, and GIF are excluded. Retain the portal's tool scan and final submission
receipt; submitted, accepted, and published are separate states.

Validate OAuth DCR, PKCE S256, hosted Claude callbacks, and random-port loopback
callbacks for localhost and 127.0.0.1. An unauthenticated protected request must
return 401 with WWW-Authenticate. Invalid HTTPS Origins return 403; trusted
Claude Origins are echoed, while no-Origin CLI clients remain supported.

Current requirements: [Anthropic review criteria](https://claude.com/docs/connectors/building/review-criteria)
and [submission guide](https://claude.com/docs/connectors/building/submission).
