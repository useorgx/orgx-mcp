# Resume ownership audit

Current evidence: source audit and local MCP mitigation, not a production exploit or verified production deployment of the mitigation.

- MCP expansion merge: `25b2e296c02032ac1ac90dbff3cf291a58a44366` (PR #463).
- Core checkout inspected: `/Users/hopeatina/Code/orgx/orgx`, branch `fix/council-join-status`, HEAD `e78416a371e6a74556f383ceaca171b8b929b8d7`.
- That checkout has unrelated dirty council, webhook, content, and film-kit work; no core files were modified.
- Current core `origin/main` independently read through GitHub at pinned SHA `ba9203bcea570c9c312b33e503b1144a7843c206` on 2026-10-05. Its deployed SHA was not established by this audit.
- Pinned source copies are adjacent `core-main-resume-route.ts`, `core-main-entities-route.ts`, `core-main-serviceKey.ts`, `core-main-supabase.ts`, and `core-main-middleware.ts`. Do not commit or include these private source copies in the public submission.

## Source finding

`orgx/app/api/agent-runs/[id]/resume/route.ts:56` authenticates a gateway service credential. Its run query at lines 83-86 filters by run ID without binding to requester, owner, workspace, or a verified gateway actor. The ordinary resume update at lines 293-306 checks ID and resumable status only. The route has no ownership-resolution helper or owner access check.

`orgx/lib/server/auth/serviceKey.ts:27-40` checks the service credential and admitted path. Signed actor validation is a separate function, unused by the resume route. `orgx/middleware.ts:565-585` admits the service credential without a resource ownership check. `orgx/lib/supabase.ts:1535,1585` creates the global service-role client, rather than a caller-specific RLS client.

Potential condition: an authenticated MCP caller allowed to invoke Resume knows a different account's paused/queued/pending run UUID. Model-hidden visibility is not an ownership boundary. No such call was performed, and no existing run was mutated.

## Proven primary read authority

`GET /api/entities?type=run&id=<runUUID>&limit=1` is already implemented by the MCP worker's `fetchEntityRecord` shape. Current core main:

- `orgx/app/api/entities/route.ts:835-855` includes run in the owner-scoped entity set.
- Lines 3190-3266 require and resolve the authenticated gateway identity.
- Lines 3324-3333 exclude run from the initiative-child exception.
- Lines 3396-3406 combine ID filtering with `requester_id = resolvedUserId`.

A primary-only read with server-derived actor headers, no user-supplied owner override and no initiative filter, can authorize an exact run UUID before the legacy mutation endpoint is called. Empty, malformed, mismatched, or unavailable reads must fail closed.

## MCP mitigation implemented locally

On branch `codex/claude-directory-resume-ownership`, the existing Resume handler now:

1. Preserves existing tool descriptors and OAuth checks.
2. Requires a runtime UUID.
3. Sends the owner-scoped primary-only GET using the authenticated actor and signed delegation claims.
4. Requires exactly one matching run row; when the response includes requester identity, compares it to the known internal actor UUID.
5. Returns `entity_not_found`/404 on an absent or mismatched run, or `run_ownership_verification_unavailable`/503 on an unreadable or malformed response, before any Resume POST.
6. Disables API-origin fallback on both authorization GET and Resume POST.

This mitigation covers MCP callers on every profile. It does not fix direct trusted service callers of the core resume endpoint; that upstream route still needs owner binding at its own boundary. No exploit, credential, private run identity, or cross-account live test is included in this artifact.
