VERDICT: DO NOT SHIP

## A. Prior findings 1–3

1. **The silent enum defaults are fixed, but enum safety is not.** With no caller-authored state, both levels now emit canonical values: top-level `proof_state: "in_review"` / `quality_eval_state: "missing"` and nested `proof.state: "in_review"` / `proof.eval.status: "missing"` (`orgx-mcp/src/completeWithProof.ts:185-196`, `orgx-mcp/src/completeWithProof.ts:243-258`). Those values match the canonical contract (`orgx/lib/server/proof/proofPacketContract.ts:23-28`, `orgx/lib/server/proof/proofPacketContract.ts:43-44`).

   The new enum test is narrower than its name claims. It hard-codes a duplicate enum and checks only the silent/default call (`orgx-mcp/tests/completeWithProof.spec.ts:116-140`). The runtime still accepts and emits arbitrary caller metadata. Repro: `proof_state: "pending"` and `quality_eval_state: "not_run"` are emitted unchanged at both levels. Therefore the original invented **defaults** are fixed, but the worker still has no runtime enum-membership boundary and the test will not catch caller-path regressions or canonical-contract drift.

2. **The nested-default contradiction is fixed only for the empty-input case.** Silence now produces matching top-level and nested `outcome_status` / `next_action`. However, nested-only metadata still creates the same class of split packet:

   ```json
   {
     "input": {
       "proof": {
         "outcome_status": "merged",
         "next_action": "verify production"
       }
     },
     "output": {
       "outcome_event_status": "completion_claimed",
       "proof.outcome_status": "merged",
       "next_action": "verify_before_claiming_outcome",
       "proof.next_action": "verify production"
     }
   }
   ```

   The top-level fields ignore the nested fallbacks (`orgx-mcp/src/completeWithProof.ts:204-208`, `orgx-mcp/src/completeWithProof.ts:226-227`), while the nested fields preserve them (`orgx-mcp/src/completeWithProof.ts:260-268`). The migration plan treats nested proof fields as canonical (`orgx/lib/server/proof/proofPacketMigrationPlan.ts:129-167`). Finding 2 is therefore not fully fixed.

3. **The tests improved, but they are not sufficient and the current tree is red.** The consistency test would fail if a silent nested default regressed independently, and the forbidden-value assertions would catch the original silent `approved` / `passed` / `completion_verified` regression (`orgx-mcp/tests/completeWithProof.spec.ts:72-140`). They do not exercise nested-only input, conflicting top-level/nested input, invalid caller-supplied enums, or canonical-contract drift.

   The working tree also contains an uncommitted authority edit not present in `phase2-v2.diff`. With that edit applied:

   - `pnpm exec vitest run tests/completeWithProof.spec.ts` → **1 failed, 7 passed**.
   - The failing test is `passes a caller's real assertions through untouched` (`orgx-mcp/tests/completeWithProof.spec.ts:47-69`).
   - `pnpm type-check` passed.

   A branch with a focused regression test failing is not shippable.

## B. New defects introduced by the fixes

### 1. The live authority edit trusts caller-controlled identity

The new `assertable` boundary allows privileged claims whenever `createdByType` is not `agent`, `system`, or `service` (`orgx-mcp/src/completeWithProof.ts:35-77`). But `createdByType` comes from `args.created_by_type` or the caller-authored artifact (`orgx-mcp/src/index.ts:3689-3705`). `entity_action` explicitly lets the caller choose `human` or `agent` (`orgx-mcp/src/index.ts:6499-6506`), and `orgx_act` accepts an arbitrary artifact record (`orgx-mcp/src/contractTools.ts:281-284`).

An agent can therefore submit `created_by_type: "human"` and retain `approved`, `passed`, and `completion_verified`. This is identity asserted by the claimant, not authority established by the server.

The outer artifact status is also still independently caller-controlled and can remain `approved` even when proof metadata is downgraded (`orgx-mcp/src/index.ts:3738-3750`). The new helper does not close finding 5.

### 2. The authority edit is both bypassable and behavior-breaking

The comparison is case-sensitive and only blocks three exact strings (`orgx-mcp/src/completeWithProof.ts:48-76`). Invalid or alternate spellings pass because the canonical validator only checks presence, not enum membership (`orgx/lib/server/proof/proofPacketContract.ts:61-86`). At the same time, legitimate caller assertions are silently downgraded, which is why the existing pass-through test now fails. The result is the worst combination: no trusted authority guarantee, plus changed behavior and a red test.

### 3. The supplied “full diff” no longer describes the working tree

`phase2-v2.diff` exactly matches `origin/main...HEAD`, but `orgx-mcp/src/completeWithProof.ts` has an additional uncommitted authority change. That change must either be removed from this review candidate or completed, tested, and included in a refreshed diff before review.

## C. Can findings 4 and 5 be deferred?

**Finding 4: not defensible for an enabled proof/impact gate.** `complete_with_proof` always emits a non-empty `outcome_event_status`, defaulting to `completion_claimed` (`orgx-mcp/src/completeWithProof.ts:197-209`). The consumer treats any non-empty value at `outcome_event_status` or `proof.outcome_status` as impact evidence (`orgx/lib/server/proof/status.ts:867-895`, `orgx/lib/server/proof/status.ts:910-925`, `orgx/lib/server/proof/status.ts:1693-1697`). Every silent completion claim can therefore manufacture L5 impact.

Changing `completion_verified` to `completion_claimed` does not make this worse than the old behavior; both strings trip the same presence check. The Phase 2 defaults are a net semantic improvement. But shipping the enabled path still publishes a false proof result. Deferral is acceptable only if the affected impact calculation is disabled or explicitly non-authoritative until Phase 3. Otherwise fix the consumer now so claimed/missing/pending statuses do not count as impact.

**Finding 5: the committed Phase 2 default fix is also a net improvement, but it cannot be represented as an authority boundary.** Deferring trusted approval enforcement can be an explicit phase boundary if the product continues to label producer-authored states as claims. The current uncommitted edit is not a defensible partial boundary: it trusts claimant-supplied creator type, leaves outer artifact approval writable, silently changes legitimate behavior, and fails the focused suite. Either defer it cleanly or implement authority from authenticated/server-owned reviewer identity and apply it consistently to artifact status and both proof levels.

## D. Other manufactured claims still present

1. **Completion is recorded before completion succeeds.** `buildCompletionProofMetadata` unconditionally writes `completion_state: "completed"` (`orgx-mcp/src/completeWithProof.ts:171`). The flow attaches this packet before verification and can then stop without calling the completion endpoint. A blocked attempt therefore leaves an artifact claiming completion for work the same flow refused to complete.

2. **A random UUID is presented as a run/session reference.** The worker passes `crypto.randomUUID()` as `runOrSessionRef` (`orgx-mcp/src/index.ts:3707`), and the builder otherwise fabricates `mcp:entity_action:<type>:<id>` (`orgx-mcp/src/completeWithProof.ts:140-147`). Neither is shown to identify a persisted run or session, but either satisfies the proof consumer's presence-only trace check (`orgx/lib/server/proof/status.ts:1193-1210`).

3. **An agent-generated scaffold share card is auto-approved.** `buildInitiativeVelocityCardArtifact` always returns `status: "approved"` together with `created_by_type: "agent"` (`orgx-mcp/src/scaffoldShareCard.ts:159-181`). That is another direct self-approval default outside `complete_with_proof`.

4. **The new `in_review` default still manufactures adoption downstream.** `complete_with_proof` defaults the attached artifact to `in_review` (`orgx-mcp/src/index.ts:3738-3743`), but the proof consumer classifies both `approved` and `in_review` as approved-artifact statuses (`orgx/lib/server/proof/status.ts:218-219`) and uses that to set `hasAdoptionSignal` (`orgx/lib/server/proof/status.ts:1592-1596`, `orgx/lib/server/proof/status.ts:1687-1692`). The UI wording is less false, but L4 adoption remains manufactured.

## E. Final verdict

**DO NOT SHIP.**

Before re-review:

1. Resolve each proof field once, using explicit precedence, and write the same resolved value to top-level and nested packet fields. Add silent, top-level-only, nested-only, and conflicting-input tests.
2. Enforce canonical proof/eval enums at runtime; do not rely on a duplicated test constant or presence-only downstream validation.
3. Remove or complete the uncommitted authority edit. A real fix must derive producer/reviewer authority from authenticated server-owned context, reject or clearly report unauthorized claims, and cover outer artifact status plus both packet levels.
4. Stop `completion_claimed` / other non-impact states from satisfying L5, and stop `in_review` from satisfying L4 adoption.
5. Do not emit `completion_state: "completed"` until completion actually succeeds; do not invent run/session identifiers.
6. Remove the scaffold share-card auto-approval or require an independently recorded approval.
7. Re-run the focused suite, typecheck, and the relevant MCP contract suite on the final diff.
