VERDICT: DO NOT SHIP

The runtime change is strictly better than `origin/main`, and both fixes requested after the third review hold under adversarial probes. The sole remaining blocker is narrower: the rewritten placement text still says authority **is** enforced at the private boundary even though the acknowledged current state is that it is not fully enforced there. That is a factual, security-relevant contradiction in this diff. No runtime change and no `force` fix are required to clear this review; the minimum fix is wording only.

## A. Is this diff strictly better than main?

Yes.

For a silent `complete_with_proof` call, main manufactures:

| Field | Main | This diff |
| --- | --- | --- |
| `schema_validated` | `true` | `false` |
| `schema_validated_artifact` | `true` | `false` |
| `proof_state` / `proof.state` | `approved` | `in_review` |
| `quality_eval_state` / `proof.eval.status` | `passed` | `missing` |
| `outcome_event_status` / `proof.outcome_status` | `completion_verified` | `completion_claimed` |
| `next_action` / `proof.next_action` | `monitor_adoption_and_impact` | `verify_before_claiming_outcome` |
| attached artifact status | `approved` | `in_review` |

Those changes remove unearned validation, approval, evaluation, verification, adoption, and artifact-approval assertions (`src/completeWithProof.ts:160-199`, `:210-233`, `:249-271`; `src/index.ts:3738-3743`). Explicit caller assertions still pass through, subject to enum membership for proof/eval states. The receipt additions also make `status` and `started_at` reachable through `orgx_submit_receipt`, and the handler forwards the parsed arguments unchanged to the private API (`src/contractTools.ts:432-438`, `src/index.ts:4803-4815`).

The behavioral cost is intentional: a silent caller that relied on fabricated approval may now remain in review or be blocked by a semantic verifier. That is fail-closed behavior, not a regression in truthful proof handling. I found no way this diff is worse than main within the reviewed surface.

## B. Do the runtime-validation and nested-consistency fixes hold?

Yes.

The copied runtime sets exactly match the canonical private contract:

- proof: `draft | in_review | approved | changes_requested | superseded`;
- eval: `missing | pending | passed | failed | skipped`.

`contractValue` now constrains both the top-level and nested proof/eval values (`src/completeWithProof.ts:35-80`, `:190-199`, `:249-263`). Invalid values are conservatively normalized to `in_review` / `missing`; they are not emitted.

I ran a direct runtime matrix against `buildCompletionProofMetadata`:

| Probe | Result |
| --- | --- |
| silent input | canonical fallbacks; all four top/nested pairs equal |
| invalid top-level `bogus` / `not_run` | `in_review` / `missing` at both levels |
| invalid nested-only values | `in_review` / `missing` at both levels |
| valid nested-only values | copied to the top level; all pairs equal |
| conflicting valid top-level/nested values | documented implementation precedence is top-level; both outputs use it |
| invalid top-level plus valid nested values | conservative fallbacks for proof/eval; both levels remain equal |
| whitespace-padded canonical values | trimmed, accepted, and equal at both levels |

Every probe asserted:

- both emitted proof states are canonical;
- both emitted eval states are canonical;
- `proof_state === proof.state`;
- `quality_eval_state === proof.eval.status`;
- `outcome_event_status === proof.outcome_status`;
- `next_action === proof.next_action`.

All assertions passed. The added invalid-enum and nested-only regression tests also pass (`tests/completeWithProof.spec.ts:166-200`). One non-blocking test gap remains: conflicting top-level/nested precedence is proven by the direct probe but is not pinned in the committed suite.

Verification:

- `pnpm exec vitest run`: 118 files passed; 780 tests passed, 1 skipped.
- `pnpm exec tsc --noEmit`: passed.
- Focused four-file run: 38 tests passed.
- `git diff --check origin/main...HEAD`: passed.
- Supplied `phase2-v4.diff`: `git apply --check --reverse` passed against this worktree.

## C. Is anything in the diff incorrect, unsafe, or self-contradicting?

One documentation finding; no runtime defect found in the requested fixes.

`src/completeWithProof.ts:61` says, “Authority is enforced in the private monorepo at the write boundary,” and `:187-189` says permission “is decided” there. `tests/completeWithProof.spec.ts:51-53` repeats that claim.

That is not the current private-boundary behavior. On verified private `origin/main`, the shared artifact insert blocks the outer birth statuses `approved` and `rejected`, but accepts and inserts arbitrary metadata (`orgx/lib/server/artifacts/clientService.ts:27-49`, `:213`, `:264-278`). The proof validator checks presence, not authority or runtime enum membership (`orgx/lib/server/proof/proofPacketContract.ts:61-86`, `:125-165`). The acknowledged unauthorised `force` path is further evidence that authority is not generally enforced there, although fixing `force` remains out of scope.

There is a second sentence-level contradiction at `src/completeWithProof.ts:200-206`: it says “The producer is therefore barred from writing the privileged value,” but `outcome_event_status` accepts any non-empty caller string at `:210-214`, including `completion_verified`. The new default no longer manufactures that value; the producer is not barred from supplying it.

These statements could cause a later maintainer to treat missing server enforcement as already complete. That is why the wording is blocking despite the correct runtime improvement.

## D. Is the placement note now accurate?

Not fully.

It is now accurate that:

- this worker is preflight/defense in depth, not the security boundary;
- callers can bypass this worker and reach the private API;
- `created_by_type` is caller-supplied, so a rule keyed on it is defeatable;
- publishing authorization rules is not itself a security failure.

It is still inaccurate in present tense when it says authority **is enforced** and permission **is decided** at the private boundary. The accurate statement is that authority **must be enforced** or **belongs** there.

## E. Minimum change to make this SHIP-able

Make one documentation-only wording patch:

1. Change “Authority is enforced in the private monorepo at the write boundary” to “Authority must be enforced in the private monorepo at the write boundary.”
2. Change “Whether a caller is PERMITTED ... is decided” to “Whether a caller is PERMITTED ... belongs at.”
3. Replace “The producer is therefore barred from writing the privileged value” with “This default no longer manufactures the privileged value; caller-authored values still pass through.”
4. Make the same `must be enforced` correction in `tests/completeWithProof.spec.ts:51-53`.

After that wording-only patch: **SHIP**. The runtime enum validation, nested consistency, truthful defaults, artifact default, receipt reachability, tests, and typecheck are sufficient for this public-worker diff. `force` and the broader private-boundary authority implementation remain explicitly out of scope and are not additional gates on this verdict.
