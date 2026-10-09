---
name: orgx-runtime-reporting
description: Record and inspect portable Agent Work Receipts while separating document validation, producer claims, independent verification, human judgment, and work outcomes.
---

Use this skill when the user asks to record completed or attempted agent work, inspect evidence, or review a work receipt. A receipt is a portable producer account, not a command to change work state.

Read the applicable workspace with `orgx_get_workspace_context`. Preserve a complete Agent Work Receipt document. Prefer schema version `agent-work-receipt/v0.2` for new receipts: retain its receipt identity, intent, identified criteria, outcome and criterion results, evidence identifiers and references, provenance, and any supported lineage, integrity, metadata, and namespaced extensions. Preserve valid v0.1 receipts in their original schema; do not invent criterion results during conversion. Follow the published input schema and include all required fields.

Use identifiers consistently. A producer `receipt_id` is an opaque external identity; OrgX returns a separate ledger UUID after admission. Referenced criterion and evidence IDs must exist. Record unmet and unknown criteria honestly, and distinguish intended outcomes from observed results. Do not fabricate source checks, quoted evidence, human interventions, timestamps, signatures, or successful outcomes. Mark unperformed checks as unknown or not performed under the applicable schema.

Call `orgx_validate_work_receipt` with the entire document. This checks schema and reference conformance and known OrgX review extensions without storing it. It does not prove that the evidence is true. When authorized to persist the report, use `orgx_submit_work_receipt` with the complete document and the target workspace. The import enforces hosted admission rules, quota, document limits, and content-bound retries. Reuse a retry key only for the same document; a conflicting payload needs correction, not a fallback write.

Receipt admission is not independent verification, human acceptance, or work completion. Claimed `verified`, `accepted`, or successful outcome values remain producer claims. A valid hash establishes content integrity; a signature requires a trusted identity before it establishes authority. Imported statements about a human remain imported statements until the relevant authenticated OrgX review path records a judgment.

Use `orgx_get_work_receipt` after admission to inspect the stored projection. Keep `producer_claims`, `receipt_assessment`, and `human_judgment` separate in user-facing explanations. Bounded evidence and criteria lists include totals; omitted rows are not evidence of absence. Use `orgx_list_work_receipts` to search the ledger and `orgx_get_receipt_review_queue` to see unresolved suggestions for people. Neither read changes judgments or performs model inference.

For richer review packets, preserve valid `org.orgx.review/v1` data, including evidence-linked criteria, sources and quotations, source-check assertions, review lenses, and episodes. Those assertions remain producer reported. Unknown vendor extensions may remain data; they cannot choose an operation or bypass admission policy.

Report the authoritative import result, ledger UUID, external receipt ID, retained evidence, and any admission or review gaps. Human outcome calls happen through authenticated OrgX UI or protected widget clicks. Never put credentials in receipt data, fabricate a click, or invoke a private widget transition as a substitute for the person's decision. Do not report completion until the separate work operation confirms it.
