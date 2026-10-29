# Directory bootstrap binding audit

Evidence is current source, not a live cross-account access test. Root separately observed a bound workspace map followed by an empty initiative search using an existing read connection; that account observation was not reproduced by this subagent.

MCP expansion merge: `25b2e296c02032ac1ac90dbff3cf291a58a44366`. Core main read at pinned SHA `ba9203bcea570c9c312b33e503b1144a7843c206`. Core deployed SHA is not established here.

## Binding defect

`src/index.ts:5327` fetches the requested workspace through the actor-scoped entities route. An absent row only produces a null workspace name. The handler then passes the caller's ID to `resolveBootstrapSessionContext` and saves it before attempting context preparation (`src/index.ts:5373-5392`). The resolver itself accepts an ID without an access assertion (`src/bootstrapPayload.ts:78-99`). A previously bound ID is not fetched when arguments omit a workspace.

`src/contextPack.ts:96-159` catches context preparation failures and returns null. It cannot undo the earlier binding. `src/responseSummarizer.ts:529` starts with static text, “OrgX contract ready,” independent of successful workspace context retrieval.

## Existing backend access semantics

Current core `GET /api/entities?type=workspace&id=<id>&limit=1` requires an authenticated identity and combines the exact ID with `owner_id = resolvedUserId` (`orgx/app/api/entities/route.ts:835-855,3190-3266,3396-3406`). This is an owner-scoped workspace read. An absent row must not be presented as a verified session binding.

The owner-only limitation also exists in the workspace list, dashboard pulse, generic routeAuthz workspace lookup, and context-capsule preparation. It predates this directory surface. This audit does not claim that these endpoints support organization members or project collaborators.

Current core has a separate durable membership resolver, `orgx/lib/server/auth/resolveWorkspaceActor.ts:94-144`, which recognizes workspace ownership or organization roles in `org_members`. The member-aware access-request GET uses ordinary session authentication and is not a proven signed-MCP-gateway preflight. No member-aware replacement endpoint was invented or called.

## Bounded correction requested

The directory bootstrap should verify the effective requested, inferred, or previously bound workspace using the existing primary-only actor-scoped read before changing session context or requesting its preparation. Missing or mismatched rows return a non-enumerating 404; unavailable or malformed reads return 503. A rejection preserves prior context. Other profiles retain their existing behavior.

The correction does not expand backend workspace membership support. A dedicated reviewer connection must authenticate the account that can actually read the demonstration workspace under this current backend contract. Implementation, test, merge, deployment, and live verification of this correction remain separate states.
