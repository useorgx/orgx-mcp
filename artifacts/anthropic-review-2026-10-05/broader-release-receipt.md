# Broader Claude directory release receipt

## Production delivery

- PR: https://github.com/useorgx/orgx-mcp/pull/463
- Reviewed head: `458c8a6b98303be7a1123b2d7386b45ca597055f`.
- PR CI: https://github.com/useorgx/orgx-mcp/actions/runs/37333715355 — passed, 2496 tests passed / 2 skipped, typecheck and Worker dry-run passed.
- Merged main SHA: `25b2e296c02032ac1ac90dbff3cf291a58a44366`.
- Production deployment: https://github.com/useorgx/orgx-mcp/actions/runs/37334702148 — success, including health/OAuth metadata and MCP-to-core actor signing parity.
- Cloudflare production version: `bcce56fa-4615-41c2-8233-c527369f98a2`; release marker `0.0.0-25b2e29`.
- Live directory metadata preflight passed; evidence `broader-production-preflight.log`.
- Live Origin/auth probes: invalid Origin 403; `https://claude.ai` 401 with echoed CORS Origin and OAuth resource metadata; no-Origin CLI 401 with OAuth resource metadata. Evidence `production-origin-auth-probes.json`.

## Claude provider evidence

- Existing `OrgX Directory Review` connection refreshed against production after deployment.
- Its Read grant captures 14 tools; screenshots `claude-read-grant-14-tools.jpg` and `anthropic-captured-14-tools.jpg`.
- The application now captures these 14 tools from the live connection. The full operation profile contains 29: 28 model-visible and one app-only Resume operation. Full Operate capture is pending.
- Listing, use cases, prerequisites and additional notes were updated to accurately describe the broader surface.
- Original new application remains a draft. No Anthropic submission or acceptance receipt exists.
- Inspector self-tested claim remains unchecked. The planned all-tool matrix is not completed test evidence.

## Outstanding gates

- Temporary local verification OAuth Operate grant requires the requested action-time security confirmation. Initial callback session timed out without a grant; no bearer was issued.
- Existing reviewer identity owns a second populated workspace whose full fixture provenance is unresolved. Password sharing with Anthropic requires confirmation all accessible data are synthetic, or a fully isolated reviewer identity.
- Paid planning improvement, delegation, launch and resume paths require explicit bounded execution authorization. A zero dollar delegation cap is not a no-dispatch guarantee.
- Authenticated all-tool Inspector tests and positive Claude fixture workflows remain unrun. The existing Read connection only proves discovery and transport; its explicit fixture search returned zero initiatives, so it is not an access pass.
- Directory bootstrap false binding was reproduced during that Claude smoke; a separate guarded binding fix is in progress.
- Final directory submission accepts Anthropic Software Directory Terms and requires action-time confirmation when the full application is ready.

Do not equate CI, merge, deployment, live discovery, actual workflow execution, form save, submission, or provider acceptance.

## Resume ownership delivery

- PR: https://github.com/useorgx/orgx-mcp/pull/464
- Reviewed head: `196bade4bfdab6ae683691175dd5c0840f67a0d6`.
- Targeted SDK, transport and regression checks: 194 passed, including 17 ownership cases; final typecheck and Worker build passed.
- PR CI: https://github.com/useorgx/orgx-mcp/actions/runs/37337312650 — success.
- Merged main SHA: `cc3481dc3e620aedd26e6fc972058362dadfd2e0`.
- Production deployment: https://github.com/useorgx/orgx-mcp/actions/runs/37337845281 — success, including health and signed gateway actor parity.
- Cloudflare version: `c3ded343-b576-4625-9c2c-48c24c886118`; release marker `0.0.0-cc3481d`.
- Post-deploy public directory preflight passed.
- Every MCP Resume now verifies the exact run through the primary actor-scoped read before POST, and avoids replaying Resume through fallback. This does not repair authorization for callers outside the MCP gateway; the core route still needs its own actor authorization.
- Actual paid run resumption remains untested.

## Directory binding and operation corrections

- PR: https://github.com/useorgx/orgx-mcp/pull/465
- Reviewed head: `5080b02372441e60abb0c3b835a148518abe29e3`.
- Local final typecheck passed; contract suite 541 passed / 1 skipped; Anthropic review suite 250 passed; agentic scale suite 7 passed; Worker build and diff check passed.
- New security regressions: 24 bootstrap workspace access cases and 5 actual canonical proof SDK/HTTP cases. Legacy profile descriptors and bootstrap behavior remain covered.
- Directory bootstrap now requires exact primary actor-scoped lookup before binding; failed checks retain context. Resume shares that strict lookup.
- Directory plans require explicit read IDs and omit all unsupported retry keys. AI improvement discloses external model costs. Directory workspace creation is excluded because it bypasses dedup and changes account default. Proof completion requires typed linked proof, rejects approval/metadata overrides, and avoids fallback replay.
- CI: https://github.com/useorgx/orgx-mcp/actions/runs/37341276204 — running at the time of this packet entry. Merge and deploy are pending.
- Browser follow-up paused while the user was actively using Dia. Last application evidence remains the saved draft with 14 Read-grant tools and Inspector testing unchecked; no submission receipt exists.
