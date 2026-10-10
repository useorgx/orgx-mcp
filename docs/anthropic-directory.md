# Anthropic Directory Readiness

OrgX MCP makes AI work resumable, reviewable, and provable across agents. The
submitted endpoint covers organizational memory, planning, owned execution,
human decision review, linked artifacts, and completion evidence.

## Directory endpoint and contract

`https://mcp.useorgx.com/mcp?profile=claude-directory`

The directory has **48 captured tools: 41 model-visible operations and seven
app-only widget operations**. It shares the 40 core workflow/receipt operations
and one explicit plan-edit journal operation with the ChatGPT profile.
`src/workflowTools.ts` and `src/receiptOperationTools.ts` expose each operation
upfront, bind existing handlers or fixed OrgX routes, and publish input/output
schemas, scopes, titles, and annotations.

| Workflow | Tools |
|---|---|
| Context, recall, and monitoring | `orgx_get_workspace_context`, `orgx_search`, `orgx_inspect`, `orgx_get_operator_brief`, `orgx_get_next_actions`, `orgx_get_agent_status`, `orgx_get_initiative_progress`, `orgx_get_operation_status`, `orgx_check_execution_readiness` |
| Planning and organization | `orgx_start_plan`, `orgx_read_plan`, `orgx_save_plan`, `orgx_complete_plan`, `orgx_validate_initiative_plan`, `orgx_create_initiative_hierarchy`, `orgx_create_initiative`, `orgx_create_workstream`, `orgx_create_milestone`, `orgx_create_task`, `orgx_update_work` |
| Execution | `orgx_estimate_agent_task`, `orgx_start_agent_task`, `orgx_handoff_task`, `orgx_launch_initiative`, `orgx_pause_work`, `orgx_resume_work`, `orgx_retry_work`, `orgx_cancel_work` |
| Decisions | `orgx_capture_decision`, `orgx_list_pending_decisions`, `orgx_open_decision_review` |
| Deliverables and proof | `orgx_attach_artifact`, `orgx_open_artifact_review`, `orgx_request_independent_artifact_review`, `orgx_complete_work_with_proof` |
| Portable receipts | `orgx_submit_work_receipt`, `orgx_validate_work_receipt`, `orgx_get_work_receipt`, `orgx_list_work_receipts`, `orgx_get_receipt_review_queue` |
| Plan edit journal | `orgx_record_plan_edit` |
| App-only widget operations | `orgx_widget_decide`, `orgx_panel_snapshot`, `orgx_widget_receipt_call`, `resume_agent_run`, `orgx_widget_select_workspace`, `orgx_widget_approve_artifact`, `orgx_widget_request_artifact_changes` |

The old operation registry remains at
`https://mcp.useorgx.com/mcp?profile=claude-directory-legacy`: its original 29
tools plus eight required widget dependencies now make 37 descriptors. It is
a compatibility surface, not the current directory submission endpoint.

Read and write operations have separate contracts. Plan retrieval cannot edit a
plan; delegation checks cannot dispatch work; decision listing cannot record a
decision. Create and update are separate tools. Model-triggered decision review
returns a human review URL and cannot settle an approval. Completion with proof
requires a linked deliverable. Arbitrary deletion and media generation are not
exposed. Delegation, launch, resume, and retry can execute paid agent work.

The core hierarchy path rejects unsupported objectives, proof/acceptance
fields, and cross-milestone edges before writing; richer compatibility
creation is separate. The new core proof-completion path supports tasks;
existing parent completion remains explicitly marked compatibility. Plan save and completion
require a positive expected version, with edit-history partial failures
reported. Portable receipt import preserves v0.1/v0.2 documents and producer
claims; it does not verify evidence, record human acceptance, or complete work.
Protected human outcome calls also require the compare-and-append migration
and concurrency checks described in the architecture plan before release.

Tool titles are also present in `annotations.title`; safety hints describe each
operation. Four informational tools advertise `readOnlyHint: false` because
`orgx_search`, `orgx_get_next_actions`, `orgx_get_agent_status`, and
`orgx_get_initiative_progress` record metered
MCP usage. Usage accounting is still a state change. Append-only artifacts,
receipts, and decisions differ from updates and execution controls.

OAuth retains the shared issuer's full scope vocabulary. The authenticated
connection's granted scopes filter discovery, and canonical invocation-time
checks enforce the selected operation's scope. Read grants cannot discover write
operations. App-only callbacks still enforce their operation's scopes and
protected human transitions require the appropriate signed click capability.
The app-only resume action requires `agents:write` on this profile.
Unknown profile names still fail closed to seven canonical informational
tools; the Claude Code plugin and OpenAI profiles retain their own contracts.

The worker suppresses optional session persistence, activation/reentry writes,
analytics, diagnostics, and success logs in this profile. Intended business
writes and documented upstream usage accounting remain enabled. The underlying
MCP framework may persist connection lifecycle state, so the endpoint is not
stateless.

No prompts, downloadable skill packs, or generic initiative resource are
advertised. The shared 14 widget families are served: search-results,
agent-status, initiative-pulse, morning-brief, entity-card, work-ledger,
workspace-map, proof-receipt, decisions, scaffolded-initiative, task-spawned,
artifact-review, plan-session-live, and orgx-panel. Tools return typed results;
artifact and receipt cards separate producer claims from verified or human
judgments. The legacy directory retains its eight-family resource policy.

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
