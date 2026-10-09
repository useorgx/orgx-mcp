# OrgX operation cutover adversarial review

The review compares the operation refactor with source baseline `44d18580ea5f9f9e030f6f47fdf7cf7d2895e793`, then integrates the latest `main` changes before publication. The [before-and-after inventory](tool-inventory-before-after.md) lists every old ChatGPT/default descriptor and every proposed descriptor. This is a coordinated cutover: current clients update together and reconnect. Historical descriptor parity is not a release requirement.

## Findings fixed in the initial descriptor review

- Generic entity completion must not shadow runtime `orgx_complete_work`. The runtime command requires `task_id`, `expected_updated_at`, and `expected_aggregate_version`; the separate generic operation is `orgx_complete_entity`.
- Fixed operation adapters must advertise their actual result envelopes, while intentionally supported native runtime adapters must retain their own result contracts. Schema inference must follow the registered implementation rather than an operation with a coincidentally equal name.
- Alias output-schema resolution must not depend on whether the alias target belongs to the current ChatGPT profile. This matters for active runtime profiles that remain separate from the new public workflow catalog.
- Human receipt rulings require a signed, revision-bound approval capability. Producer verification and acceptance fields are claims; import cannot authorize a human ruling. An unavailable capability never falls back to unsigned approval.

## Current review

The review also examines plan compare-and-set behavior, receipt revision identity, workspace boundaries, callback authorization, current advertised tool instructions, and installed-client configuration. The final review fixed:

- Plan completion now checks owner, workspace and expected version, commits the current text atomically, and returns closed-schema post-commit attachment failures.
- Receipt judgments bind the ledger document and database-owned review revision. Replacing producer material invalidates previous acceptance; old detail reads and post-commit learning cannot consume a newer packet's judgment.
- Receipt detail retains bounded confidence, source labels, objective and outcome context through the real output schema and mounted panel. Producer agreement and verification claims remain visibly unconfirmed.
- Current discovery instructions name current tools. Receipt reads use their own tools rather than a hidden search action; portable anchors require the exact OrgX namespace.
- Widget callbacks cannot apply late acknowledgments to a changed workspace or receipt revision. Current widgets use one advertised operation per action.
- The published review additionally fixed warm-session grant reuse by comparing canonical verified grants before dispatch and requiring reconnect on changes across HTTP and native SSE, including live SSE sessions without an SDK initialization marker; artifact callbacks now require exact identity and guard every delayed repaint.
- The ChatGPT candidate now uses the documented portable format rather than a Codex/portable hybrid, preserves the recorded server URL, shortens listing text and includes the required support URL. Core migrations sort after the applied baseline.
- Client instructions read the actual brief-result path and supply required initiative identifiers. Wizard handles header casing and query precedence consistently; OpenClaw keeps local credentials out of hosted requests.

Verification and published reviews are recorded in the [PR index](ecosystem-pull-requests-2026-10-09.md) and each PR description. Source checks do not establish production deployment, a successful provider scan, or publication of the reconstructed ChatGPT plugin candidate.


The additional local release gate uses official MCP Inspector against the real Worker: all 68 default/extended tools, 44 intended refusal cases, two partial proof outcomes and 28 current widget resources passed. All 96 rendering checks and 43 actual Worker browser interactions passed. It fixed native SSE signed-run authentication, workspace-selection output validation, receipt list parsing and error status handling, current chronicle rendering studio validation inputs and the current panel receipt boundary. The actual signed local widget feed also reached Live. The [local verification report](mcp-inspector-local-verification-2026-10-09.md) records the setup, independent descriptor review and evidence boundaries. Full-suite results are recorded in the PR description. The portable ChatGPT plugin and MCP manifests pass the actual official JSON schemas, 12 package regression checks and reproducible archive generation. Core and client evidence is scoped separately in their PR descriptions.
