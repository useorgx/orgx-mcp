VERDICT: DO NOT SHIP

The authority check belongs at the private write boundary, but this patch removes the client-side guard before that boundary enforces the claims this worker writes. Earlier findings 1–3 are still only partially fixed. The public worker also exposes a more direct verification bypass through `force`, and several paths still manufacture completion, impact, provenance, approval, adoption, or audit claims.

## 1. Removing the public-worker authority rule

**Correct destination; unsafe current sequence.**

The public MCP worker cannot be the security boundary for OrgX authority. A determined caller could already bypass the removed exact-label check by calling the private API directly or by supplying a caller-controlled `created_by_type` such as `human` instead of `agent` (`src/index.ts:3738-3748`, `src/completeWithProof.ts:180`). Moving enforcement to every private write chokepoint is therefore architecturally correct.

Removing the check is not strictly worse against that determined attacker: the old rule did not reliably stop them. It is strictly worse for careless or unsophisticated agents and as defense in depth. A truthful/default `agent` caller can now submit `proof_state: "approved"`, `quality_eval_state: "passed"`, `outcome_event_status: "completion_verified"`, or equivalent nested proof metadata without even encountering the previous downgrade. That removes a useful failure/audit signal before the replacement boundary exists.

The secrecy rationale is not a valid security rationale. Authorization must remain secure when its rules are public. Publishing the rule was not the bypass; trusting caller-controlled identity and leaving alternate write paths unguarded were the bypasses.

There is also a stronger public bypass than the removed rule: `orgx_act.force` is documented as skipping preflight checks (`src/contractTools.ts:279`) and is forwarded unchanged (`src/index.ts:3770-3779`, `src/index.ts:6922-6928`). The private action route currently uses it to skip completion verification and proof hard blocks (`orgx/app/api/entities/[type]/[id]/[action]/route.ts:649`, `:680`, `:720`). I found no separate authority check on the right to use `force`.

The safe sequence is:

1. Enforce privileged proof, approval, outcome, creator, and override claims at all private write paths.
2. Give `force` its own explicit authority policy or remove it from this client.
3. Then remove or retain the public check only as non-security preflight UX.

## 2. Earlier findings 1–3

### Finding 1 — invented enum values: NOT fully fixed

The silent/default values are now canonical at both levels:

- top-level: `proof_state: "in_review"`, `quality_eval_state: "missing"`, and `outcome_event_status: "completion_claimed"` (`src/completeWithProof.ts:143-170`);
- `metadata.proof`: the same defaults (`src/completeWithProof.ts:204-221`).

But there is still no runtime membership validation for caller values. A runtime probe with `proof_state: "bogus"` and `quality_eval_state: "not_run"` emitted those exact values at both the top level and in `metadata.proof`. The TypeScript casts do not protect the API boundary.

### Finding 2 — self-contradicting nested packet: NOT fully fixed

Silent input and top-level-only input are consistent. Nested-only input is not:

- top-level `outcome_event_status` ignores `metadata.proof.outcome_status` (`src/completeWithProof.ts:169-170`);
- nested `proof.outcome_status` accepts it (`src/completeWithProof.ts:216-217`);
- top-level `next_action` ignores `metadata.proof.next_action` (`src/completeWithProof.ts:187-188`);
- nested `proof.next_action` accepts it (`src/completeWithProof.ts:218-219`).

Observed runtime result for nested-only input:

```text
top outcome_event_status = completion_claimed
nested proof.outcome_status = merged
top next_action = verify_before_claiming_outcome
nested proof.next_action = verify production
```

The producer must define one precedence rule and derive both representations from the same normalized values.

### Finding 3 — tests pinning behavior: NOT fully fixed

The new tests pin silent defaults, top-level caller-authored values, and consistency for silent input (`tests/completeWithProof.spec.ts:9-165`). They do not cover:

- nested-only values;
- conflicting top-level and nested values;
- precedence;
- invalid runtime enum strings;
- contract drift between the duplicated test enums and the real private contract.

All targeted tests pass, but they do not exercise either runtime failure above.

## 3. Placement note and actual trust boundary

The placement note identifies the correct architectural boundary, but it overstates current enforcement.

Current private-monorepo enforcement on `origin/main` blocks an artifact from being born with the outer status `approved` or `rejected` (`orgx/lib/server/artifacts/clientService.ts:27-49`, `:264`). Formal action/review paths also contain self-approval controls.

That is not equivalent to enforcing proof authority:

- the client artifact contract accepts arbitrary metadata (`orgx/lib/server/artifacts/clientContract.ts:59-61`);
- the create service inserts that metadata without validating `proof_state`, `quality_eval_state`, `outcome_event_status`, `metadata.proof`, schema-validation flags, or claimed creator identity (`orgx/lib/server/artifacts/clientService.ts:213`, `:266-277`);
- the proof packet validator checks required presence but not enum membership or claim authority (`orgx/lib/server/proof/proofPacketContract.ts:61-86`, `:130-159`).

Therefore these statements are not currently true:

- “Permission is enforced in the private monorepo at the write boundary” (`tests/completeWithProof.spec.ts:51-53`);
- the producer “is therefore barred from writing the privileged value” (`src/completeWithProof.ts:162-168`);
- permission “is decided” there for all proof claims (`src/completeWithProof.ts:154-156`).

The narrower wording at `src/completeWithProof.ts:35-48`—that authority enforcement *belongs* there—is accurate. Its assertion that this worker must “never CONSTRUCT a claim the caller did not make” (`src/completeWithProof.ts:44`) is contradicted by this worker's current behavior.

## 4. Other public business logic and bypass maps

### P0 — `force` publishes and implements a verification bypass

`src/contractTools.ts:279` tells callers that `force` skips preflight. `src/index.ts:3770-3779` and `:6922-6928` forward it. The private route skips completion verification and proof hard blocks when it is true. This is business-critical override logic, not merely a disclosed threshold. Fix the authority model; obscuring the flag would not secure it.

### P1 — share-card scaffold creates agent-approved artifacts

`src/scaffoldShareCard.ts:27`, `:38`, `:170`, and `:181` hardcode `status: "approved"` with `created_by_type: "agent"`. I found no live call site, and the current private outer-status guard would reject it, but it remains an unsafe ready-made template and a precise regression path. Change it to a non-privileged status or remove it.

### P1 — public discovery teaches attach-equals-approved

The discovery handler is otherwise read-only, but its attach-proof example returns `status: "approved"` immediately after `orgx_attach` (`src/publicMcpDiscovery.ts:238-256`). That is not what attachment establishes and trains clients to manufacture approval.

### P1 — the free audit is a gameable, client-computed authority score

`src/freeAudit.ts` publishes:

- score normalization and bands (`:81-102`);
- trust-level point values (`:156-163`);
- receipt-coverage formula (`:170-183`);
- nonzero fallback proof/autonomy scores for missing signals (`:195-198`, `:214-242`);
- context points awarded largely for payload presence (`:276-285`);
- ROI points awarded for any payload and even zero cost (`:319-325`);
- the below-70 and autonomy-promotion recommendations (`:358-380`);
- a shareable exact score (`:459-462`).

This is not an authentication bypass, but it is business-critical trust/autonomy logic that callers can game by shaping payload presence. The output lacks a confidence field while tests describe sparse data only as “weak confidence” (`tests/freeAudit.spec.ts:77-102`). Do not present or share it as an authoritative audit until the score is server-derived from validated evidence, or clearly label it as a heuristic estimate with confidence and coverage.

### P2 — public routing economics and hardcoded autonomy thresholds

`src/scaffoldInitiative.ts:73-84` publishes token, cost, and human-rate assumptions; `:343-403` exposes tiny-budget thresholds and collapses an entire hierarchy into a one-task demo-safe policy when any node crosses one; `:1158-1226` computes estimated ROI; `:1259` emits the rate card. Estimates are labeled, so this is not an authorization flaw, but these are commercially sensitive and gameable routing rules. Move mutable economics and promotion thresholds to server configuration if they affect real allocation.

### P1 — rate limiting is keyed to bearer-token material

`src/edgeRateLimit.ts:32-40` publishes quotas, `:64-79` derives subjects from token hashes, `:339-347` creates the base token bucket, `:382-403` exposes the enterprise bypass, and `:434-463` creates the pro bucket. If one user can mint multiple OAuth grants/tokens, each token receives an independent quota because the limiter never rekeys to a stable user/workspace/account identity. The public code makes the multiplication path obvious, but the defect is the token-scoped enforcement itself.

## 5. Remaining manufactured claims

1. `completion_state: "completed"` is written before verification (`src/completeWithProof.ts:142`, `:234-265`). Because attachment happens first, a failed verification can leave persisted artifact metadata claiming completion.
2. Silent callers receive `outcome_event_status: "completion_claimed"` (`src/completeWithProof.ts:169-170`). The private proof-status logic treats the presence of an outcome event as an impact signal (`orgx/lib/server/proof/status.ts:920-935`, `:1703-1707`).
3. A random UUID is passed as `run_or_session_ref` even when no persisted run/session exists (`src/index.ts:3707`); the fallback manufactures an `mcp:entity_action:*` reference (`src/completeWithProof.ts:111-118`).
4. The default artifact status is `in_review` (`src/index.ts:3738-3743`), while private proof aggregation currently counts `in_review` among adoption-qualifying artifact statuses (`orgx/lib/server/proof/status.ts:218-229`, `:1602-1606`, `:1697-1702`).
5. The share-card scaffold manufactures agent approval (`src/scaffoldShareCard.ts:170-181`).
6. The free audit manufactures nonzero proof/autonomy/context/ROI scores from missing or merely present payloads and emits a shareable score.
7. The sibling receipt change fixes reachability and stops inventing zero-duration starts, but omitted `status` still becomes `completed`. It records `status_source: "assumed"` and then stores `status: claimedStatus ?? "completed"` (`orgx/app/api/flywheel/receipts/route.ts:196-212` on `feat/receipt-boundary`). Labeling the assumption is better; it is still an unmade terminal claim.

## 6. Ship decision

**DO NOT SHIP.**

Minimum gates:

1. Enforce privileged outer and nested proof claims, creator identity, outcome claims, and overrides at every private write boundary; merge and deploy that enforcement before removing client defense in depth.
2. Remove `force` from the public contract or require explicit server-side authority for it.
3. Normalize once, validate runtime enum membership, and render top-level and `metadata.proof` from the same values.
4. Add nested-only, conflict-precedence, invalid-enum, and private-contract conformance tests.
5. Stop constructing completion, outcome, adoption, and run/session claims from silence or mere attachment.
6. Remove or neutralize the agent-approved scaffold and misleading approved discovery sample.
7. Treat the free audit and routing economics as non-authoritative heuristics or move consequential scoring/routing to a validated server boundary.
8. Merge/deploy the receipt sibling change, and require an explicit terminal status rather than assuming completion.

Verification performed:

- targeted Vitest: 6 files, 41 tests passed;
- `pnpm type-check`: passed;
- phase diff `git diff --check`: passed;
- direct runtime probes reproduced invalid-enum passthrough and nested/top-level contradiction.
