# Artifact transport and growth incident — 2026-10-07

## Confirmed source defect and bounded repair

At MCP base `397eb964390627a862063b2f783e7ed1e9cb364e`, canonical
`orgx_attach` sends the supplied idempotency key in artifact metadata but omits
the HTTP header. The app source at
`bd51cb34c84913cc0c29ee8cbbecd2ee81b14c57` rewrites
`/api/client/:path*` to `/api/v1/:path*` in `orgx/next.config.mjs`.
`orgx/app/api/v1/artifacts/route.ts` requires `request.headers.get('idempotency-key')`
and returns “Idempotency-Key header is required for artifact creation” when
missing. The OpenAPI artifact creation contract also requires that header.

This draft forwards the caller's existing key for canonical `orgx_attach` and
`orgx_write` creation, retaining metadata and actor/delegation attribution.
It explicitly keeps API fallback disabled: adding a keyed header otherwise makes
these writes retry-safe to the shared HTTP client and would enable a new replay.
No generated key, schema change, permission change, automatic business-write
retry, or reconciliation action is introduced. Legacy `entity_action attach`
and `save_artifact` are not migrated by this bounded change.

Two network-blocked, in-memory MCP client/server fixtures fail against the base
with the required-header error, and pass after the repair. They assert the exact
caller key, preserved metadata/actor identity, one business POST, and fallback
disabled. The mocked generic entities route enforces the header to test transport;
this does not claim `/api/entities` currently rejects headerless writes.

## Parent-forwarded growth incident: outcome still unverified

The parent supplied this evidence; it was not independently read from production:

- Initiative `93c4533f-a5a3-49aa-9ac3-68eb7893408f` has eight streams and eight
  milestones on readback.
- A request for 26 tasks reported “saved locally” without a queue/command ID;
  server readback found zero tasks. Do not claim those tasks are durable or queued.
- Artifact creation returned HTTP 400 with the required-header error despite a
  supplied tool key. The source mismatch above is confirmed, but the deployed
  connector path, its version, and whether it caused this incident are unknown.
- Reconciliation owner child `01a11405` holds
  `codex-growth-repair-26-tasks-20261007`. This audit does not retry writes,
  recreate tasks, or re-scaffold the initiative.
- Supplied reconciliation Library reference
  `libfile_a72bff2f0cd48191924195866151557c` could not be materialized: the official
  transfer helper received HTTP 403, including one fresh bounded retry. Its
  contents were not inspected. No guessed URL or credential search was used.

## Required receipt state contract: follow-up, not implemented here

“Saved locally” is not server success. A truthful client needs distinct outcomes:

| State | Required evidence | Allowed recovery |
| --- | --- | --- |
| Saving | One request in flight; scope and caller key fixed | Coalesce duplicate activation |
| Queued | Durable local queue/command ID, target workspace, intended count and next reconciliation path | Read that receipt; resume the owner queue |
| Unknown | Lost response or missing durable queue identifier | Reconcile by the original key in the same workspace; do not create a fresh batch |
| Committed | Server receipt/entity IDs and scoped readback | Show exact committed count and handoff |
| Partial | Exact committed IDs/count plus unresolved remainder | Reconcile remainder under original ownership/key |
| Rejected/failed | Explicit final server or permission evidence | Display reason; allow only a recovery justified by that evidence |

A local persistence claim must include its receipt and distinguish storage from
remote commitment. Zero server readback plus no queue ID is an unverified outcome,
not proof that a replay is safe. The execution connector is not exposed in this
selected environment; its typed receipt normalization needs a separate repair
once its source and sanitized envelope are available. Production incident impact
and all 26 task outcomes remain unknown in this audit.

## Verification

Focused MCP/header/fallback/write-contract checks: 11 passed. Type-check and bundle
build passed. Full suite: 240 files passed, one skipped; 2,543 tests passed, two
skipped, including nine browser tests rerun with macOS launch permission. Exact-head
CI is recorded in the draft PR. All calls are synthetic; no live artifact or task
was created.
