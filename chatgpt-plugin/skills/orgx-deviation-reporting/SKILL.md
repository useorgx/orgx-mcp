---
name: orgx-deviation-reporting
description: Preserve meaningful changes of plan, failed checks, and corrections in authorized OrgX work receipts without turning producer reports into verified facts.
---

Use this skill when a material deviation affects the work the user asked to record: changed scope or assumptions, a blocked or failed attempt, a correction, missing evidence, or a different observed outcome. Continue useful authorized work and explain the effect plainly. Do not create telemetry or external messages merely because this skill was loaded.

Capture what was expected, what happened, the supporting evidence, the affected work reference, and the corrective action or remaining question. Preserve the actual sequence and separate observations from interpretations. Use an existing producer receipt identity when reporting the same event; do not hide a changed document behind a retry key already bound to different content.

When the user has authorized recording work, follow the runtime reporting skill: prepare a complete Agent Work Receipt, prefer `agent-work-receipt/v0.2`, and preserve its identified criteria, evidence-linked results, provenance, and supported review or lineage extensions. Use `orgx_validate_work_receipt` and then `orgx_submit_work_receipt`. A failed import remains a failed import; never retry through an unrelated operation to bypass policy. Inspect the admitted result using `orgx_get_work_receipt`.

Record criterion results as met, unmet, or unknown according to the evidence. Producer confidence, reported verification, and a proposed outcome are producer assertions. Receipt storage does not independently verify work, update human trust, confirm acceptance, or change the task's status. If an accountable choice is required, use `orgx_capture_decision` and `orgx_open_decision_review` within the user's authorized scope. People make their calls through the review surface.

For a correction, preserve the original receipt and the supported relation to the corrected report. Report both identities and the reason for the correction. Do not overwrite human judgment, invent a verified source, or claim that a corrected receipt retroactively completed work.
