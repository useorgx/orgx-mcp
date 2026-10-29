# OrgX new Anthropic connector application — 2026-10-05

Current state: prepared at Step 10 (Review and submit) in the authenticated Claude directory portal; not submitted. The account dashboard showed zero submissions. That does not establish the status of an older application in another account or channel.

Portal: https://claude.ai/directory/manage/new/connector

Connection: https://mcp.useorgx.com/mcp?profile=claude-directory

## Prepared fields

- Name: OrgX MCP
- Permanent slug: orgx-mcp
- One-liner: Organizational continuity for AI agents.
- Category: Productivity
- Publisher and company: OrgX, https://useorgx.com
- Documentation: https://github.com/useorgx/orgx-mcp#readme
- Support: https://useorgx.com/support
- Privacy: https://github.com/useorgx/orgx-mcp/blob/main/docs/privacy-policy.md
- Primary contact: the signed-in account holder; role Founder
- Authentication: always required, OAuth Dynamic Client Registration
- API ownership: first-party OrgX API
- Personal health data: No; not an intended PHI workflow
- Sponsored content: No
- Read/write disclosure: reads organizational data and records usage accounting; no business-record mutations on this profile

The listing description, three use cases, prerequisites, test procedure, and additional notes are filled. The self-tested checkbox remains unchecked until authenticated reviewer QA is complete. All compliance acknowledgements remain unchecked pending final consent.

## Provider scan and remediation

The authenticated portal connected successfully and found seven tools with six widget templates (twelve resource entries including compatibility variants). Its initial scan reported seven suggestions: each tool lacked `annotations.title` despite supplying a top-level title.

The compliance page also required tool descriptions without instructions about model behavior or other tools. The old descriptions repeated routing instructions such as NEXT and DO NOT USE. PR https://github.com/useorgx/orgx-mcp/pull/462 supplies annotation titles and narrow descriptions only on the directory profile. It retains the distinction between autonomous-session briefs, operator reporting windows, initiative health, and agent activity. OpenAI descriptors remain byte-identical.

Local verification: 135 registration/descriptor tests passed; 58 Anthropic readiness tests passed; typecheck, 437 contract tests (one skipped), agentic-scale checks, and production build passed through pnpm verify. Production public company, support, logo, and favicon URLs returned 200 with curl. A Python urllib HEAD probe returned 403; that result was superseded by the successful curl requests, not treated as a provider availability claim.

## Deployment and live scan receipt

PR #462 merged as `9a14cdf87f1a7b81d8bd9028640fb9175c8ccf06`. CI passed 2,440 tests (two skipped): https://github.com/useorgx/orgx-mcp/actions/runs/37318953880

The production deployment of that exact merge SHA succeeded: https://github.com/useorgx/orgx-mcp/actions/runs/37319409497

Claude initially retained its cached connector inventory. The supported “Refresh tools list” action in Customize → Connectors → Yours → OrgX Directory Review completed, then reloading the autosaved application retrieved the new descriptors. The resulting live scan shows seven tools, six widget templates, all seven titles, structured output, and zero metadata suggestions. Screenshot: `anthropic-review-2026-10-05/clean-tool-scan.jpg`.

Re-selecting the connector reset the listing name and slug to its local connection label. Both were corrected back to `OrgX MCP` / `orgx-mcp` and confirmed in the final review page. The rest of the form fields survived. The final review still shows “Not tested with MCP Inspector” and the unacknowledged policy field. Those are unresolved requirements, not a submitted application.

OpenAI's metadata/skills panel reports no issues. The installed published `1.0.0` skill files are byte-identical to the installed local `0.1.20` skill files. OpenAI's MCP appeal still shows “Appeal submitted”; scans are paused during review.

## Required before submission

1. Complete — merged SHA, worker deployment, and refreshed authenticated portal scan with all seven titles and no metadata suggestions.
2. Resolve and test an existing dedicated OrgX reviewer account with a populated sample workspace. No such workspace was returned by the connected account's typed workspace search for review; this does not prove it does not exist elsewhere. Do not invent credentials or provision a new password silently.
3. Exercise all seven tools against that reviewer account in Claude and retain real MCP App screenshot evidence (3–5 PNGs, at least 1000px wide, cropped to app responses, each paired with its prompt).
4. Replace the draft credential placeholder with complete access instructions in Anthropic's private reviewer field after authorization to share the dedicated credential.
5. Obtain action-time consent for the required policy acknowledgements and legally binding directory terms. Review the final application, submit, and retain the provider receipt and submission identifier.

First-party requirements: https://claude.com/docs/connectors/building/submission and https://claude.com/docs/connectors/building/review-criteria
