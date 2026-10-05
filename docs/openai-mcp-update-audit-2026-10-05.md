# OpenAI MCP update audit — October 5, 2026

Plugin: `plugin_asdk_app_6a1083cac4788191a47b657dc58c4315`.

## Provider evidence

- Published package: 1.0.0; metadata and all three skill scans pass.
- MCP: authorized, domain verified, 27 scanned tools (including three widget-only tools).
- Production server manifest: 1.1.5. Its tool annotations match the current checked-in submission matrix.
- `GET /healthz?check=upstream`: `status=ok`, `upstream=healthy`, primary `https://useorgx.com`.
- A fresh portal rescan completed and retained 11 findings across 10 tools.
- Latest audited main: `c5a167d9fdeb338c0abdc6bc4ad44bff4882f0fb`; its deployment job passed: https://github.com/useorgx/orgx-mcp/actions/runs/37096403896/job/111127131756.
- These signals do not prove all hosted review fixtures, demo credentials, or every client UI state. They must not be described as end-to-end reviewer approval.

## Exact findings and response

| Tool | Portal finding | Response |
| --- | --- | --- |
| approve_decision | Name unclear | Change display title to Open Decision Approval Review; preserve action ID and schemas. |
| reject_decision | Name unclear | Change display title to Open Decision Rejection Review; preserve action ID and schemas. |
| approve_agent_work | Name unclear; further review required | Change display title to Review Pending Agent Work. List mode retrieves approvals; approve/reject return a human review URL. |
| manage_lifecycle | Further review required | Pause/resume/retry/cancel can change execution and descendant state. All three risk hints remain true. |
| orgx_write | Further review required | Entity creates/updates can overwrite fields or publish initiative links. All three risk hints remain true. |
| orgx_act | Further review required | Lifecycle actions include deletion and dispatch. All three risk hints remain true. |
| orgx_plan | Further review required | Writes private plan state; readOnly=false, openWorld=false, destructive=false. |
| orgx_spawn | Further review required | Agent dispatch can reach connected systems and cannot always be reversed. All three risk hints remain true. |
| orgx_decide | Further review required | Creates/remembers private decisions; model approval/rejection returns human-session review URL. readOnly=false, openWorld=false, destructive=false. |
| scaffold_initiative | Further review required | Default launch creates hierarchy and starts agents; optional external sync. All three risk hints remain true. |

The eight further-review messages provide no specific implementation or annotation defect. Do not weaken risk hints to bypass the scanner. Correct the three display titles, deploy, rescan, then request manual review if the generic holds persist.

## Current publication process

Official submission documentation says eligible hosted MCP changes update automatically after scanning; package metadata/skills changes need a new ZIP. The current metadata/skills package has no findings, so do not manufacture a new package solely for hosted tool updates. Appeals pause automatic scans until resolved or withdrawn.

The live portal uses `/mcp` but discovers the same 27-tool ChatGPT surface returned by the connected plugin bootstrap. The runbook recommends `/mcp?profile=chatgpt` for explicit host metadata. Do not reconnect a healthy production OAuth grant solely to make the URL text match without first checking host-profile negotiation.

Current docs require a demo-recording URL for remote MCP review. The prior runbook said otherwise; corrected in this patch. Existing reviewer access, video, screenshots, and fixture execution are not exposed on this published detail view and remain unaudited here.

Sources: https://developers.openai.com/plugins/deploy/submission and https://developers.openai.com/plugins/deploy/submission-errors.

## Local validation

- `pnpm test:openai-review`: 179 tests passed across 12 files.
- `pnpm verify`: typecheck, 434 contract tests passed (one skipped), and production bundle build passed.
- Titles change in runtime definitions, server manifest, and generated catalog; tool IDs, schemas, grants, annotations, and approval authority are preserved.

## Manual review note

Please review the held updates for the existing OrgX MCP plugin. The displayed approval tool titles now describe the actual operation: opening human review or listing pending agent work. Existing action IDs and input schemas remain stable for approved clients. OrgX does not allow a model to settle a decision: approval/rejection requests return the human review surface; actual in-widget decisions require the person's click and a single-use token hidden from the model.

The execution tools retain conservative risk annotations: writes, lifecycle actions, delegation, and launch can mutate records, dispatch work to connected systems, or have irreversible effects. Planning is private and non-destructive. The consolidated decision and agent-review routers can write private context or usage but do not resolve approvals or resume execution from a model call. The production primary upstream is healthy, and local submission contract, output schema, profile visibility, side-effect, and widget-domain checks pass. Please evaluate the held changes together; the remaining automated messages only say further review is required and do not identify a more specific defect.
