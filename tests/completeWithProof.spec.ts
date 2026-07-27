import { describe, expect, it, vi } from "vitest";

import {
  buildCompletionProofMetadata,
  executeCompleteWithProofFlow,
} from "../src/completeWithProof";

describe("buildCompletionProofMetadata", () => {
  it("claims nothing the caller did not assert", () => {
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://github.com/hope/orgx/pull/42",
      qualityScore: 4.7,
      verification: ["pnpm vitest run tests/focused.spec.ts"],
      createdByType: "agent",
      createdById: "engineering-agent",
      sourceClient: "codex",
      runOrSessionRef: "run-123",
    });

    expect(metadata).toMatchObject({
      atomic_unit_type: "completion_proof",
      artifact_hash: "https://github.com/hope/orgx/pull/42",
      // The caller passed evidence and a score, but asserted NOTHING about
      // validation, approval, evals or verification. None of those may be
      // manufactured on its behalf.
      schema_validated: false,
      schema_validated_artifact: false,
      completion_state: "completed",
      proof_state: "in_review",
      quality_eval_state: "missing",
      outcome_event_status: "completion_claimed",
      source_tool: "entity_action.complete_with_proof",
      source_client: "codex",
      owner_source: "entity_action.complete_with_proof",
      run_or_session_ref: "run-123",
      run_ref: "run-123",
      created_by_type: "agent",
      created_by_id: "engineering-agent",
      next_action: "verify_before_claiming_outcome",
      quality_score: 4.7,
      task_id: "task-1",
    });
  });

  it("passes a caller's real assertions through untouched", () => {
    // The fix must not punish honest callers. Someone who genuinely ran schema
    // validation and holds an approval still gets exactly what they asserted.
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://github.com/hope/orgx/pull/42",
      schemaValidated: true,
      createdByType: "agent",
      metadata: {
        proof_state: "approved",
        quality_eval_state: "passed",
        outcome_event_status: "completion_verified",
      },
    });

    expect(metadata).toMatchObject({
      schema_validated: true,
      schema_validated_artifact: true,
      proof_state: "approved",
      quality_eval_state: "passed",
      outcome_event_status: "completion_verified",
    });
  });

  it("never upgrades a claim when the caller is silent", () => {
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/evidence",
      createdByType: "agent",
    });

    for (const [field, forbidden] of [
      ["schema_validated", true],
      ["schema_validated_artifact", true],
      ["proof_state", "approved"],
      ["quality_eval_state", "passed"],
      ["outcome_event_status", "completion_verified"],
    ] as const) {
      expect(
        (metadata as Record<string, unknown>)[field],
        `${field} must not default to ${String(forbidden)}`
      ).not.toBe(forbidden);
    }
  });

  it("keeps the nested proof packet consistent with the top level", () => {
    // proofPacketMigrationPlan reads proof.* as canonical with the top level
    // only as fallback, so a nested packet that still says "completion_verified"
    // silently wins over an honest top level. An earlier pass fixed only the top
    // level and shipped exactly that contradiction.
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/evidence",
      createdByType: "agent",
    }) as Record<string, any>;

    expect(metadata.proof.state).toBe(metadata.proof_state);
    expect(metadata.proof.eval.status).toBe(metadata.quality_eval_state);
    expect(metadata.proof.outcome_status).toBe(metadata.outcome_event_status);
    expect(metadata.proof.next_action).toBe(metadata.next_action);

    expect(metadata.proof.state).not.toBe("approved");
    expect(metadata.proof.eval.status).not.toBe("passed");
    expect(metadata.proof.outcome_status).not.toBe("completion_verified");
  });

  it("only emits values the canonical proof-packet contract allows", () => {
    // lib/server/proof/proofPacketContract.ts defines these enums. Inventing a
    // value that reads as honest but is not in the contract is the same class of
    // error as inventing a claim about it — and validateProofPacketV0 checks
    // presence, not enum membership, so nothing downstream would catch it.
    const PROOF_STATES = [
      "draft",
      "in_review",
      "approved",
      "changes_requested",
      "superseded",
    ];
    const EVAL_STATES = ["missing", "pending", "passed", "failed", "skipped"];

    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      externalUrl: "https://example.com/evidence",
      createdByType: "agent",
    }) as Record<string, any>;

    expect(PROOF_STATES).toContain(metadata.proof_state);
    expect(EVAL_STATES).toContain(metadata.quality_eval_state);
    expect(PROOF_STATES).toContain(metadata.proof.state);
    expect(EVAL_STATES).toContain(metadata.proof.eval.status);
  });

  it("preserves caller-authored proof state and next action", () => {
    const metadata = buildCompletionProofMetadata({
      entityType: "task",
      entityId: "task-1",
      artifactHash: "sha256:abc",
      metadata: {
        outcome_event_status: "merged",
        next_action: "verify production",
        source_tool: "github.pull_request",
      },
    });

    expect(metadata).toMatchObject({
      artifact_hash: "sha256:abc",
      outcome_event_status: "merged",
      next_action: "verify production",
      source_tool: "github.pull_request",
    });
  });
});

describe("executeCompleteWithProofFlow", () => {
  it("attaches proof, verifies it, and calls canonical complete", async () => {
    const callApi = vi.fn(async (path: string) => {
      if (path === "/api/client/artifacts") {
        return { ok: true, artifact: { id: "artifact-1" } };
      }
      if (path.startsWith("/api/entities/verify?")) {
        return {
          ok: true,
          verification: { verified: true, blockers: [] },
        };
      }
      if (path === "/api/entities/task/task-1/complete") {
        return {
          success: true,
          transition: { from: "in_progress", to: "done" },
          forced_proof_completion: false,
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    });

    const result = await executeCompleteWithProofFlow({
      entityType: "task",
      entityId: "task-1",
      attachPayload: {
        entity_type: "task",
        entity_id: "task-1",
        artifact_url: "https://github.com/hope/orgx/pull/42",
      },
      completeBody: { force: false, user_id: "user-1" },
      callApi,
    });

    expect(callApi.mock.calls.map(([path]) => path)).toEqual([
      "/api/client/artifacts",
      "/api/entities/verify?type=task&id=task-1",
      "/api/entities/task/task-1/complete",
    ]);
    expect(
      callApi.mock.calls.some(([path]) =>
        String(path).endsWith("/complete_with_proof"),
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      completed: true,
      attachResult: { artifact: { id: "artifact-1" } },
      verification: { verified: true },
      completeResult: { forced_proof_completion: false },
    });
  });

  it("stops after verification when proof is blocked", async () => {
    const callApi = vi.fn(async (path: string) => {
      if (path === "/api/client/artifacts") {
        return { ok: true, artifact: { id: "artifact-1" } };
      }
      if (path.startsWith("/api/entities/verify?")) {
        return {
          ok: true,
          verification: {
            verified: false,
            blockers: ["Proof-chain blocker: incomplete_execution_proof"],
          },
        };
      }
      throw new Error(`Completion must not run after a blocked verifier: ${path}`);
    });

    const result = await executeCompleteWithProofFlow({
      entityType: "task",
      entityId: "task-1",
      attachPayload: {
        entity_type: "task",
        entity_id: "task-1",
        artifact_url: "https://github.com/hope/orgx/pull/42",
      },
      completeBody: { force: false, user_id: "user-1" },
      callApi,
    });

    expect(callApi.mock.calls.map(([path]) => path)).toEqual([
      "/api/client/artifacts",
      "/api/entities/verify?type=task&id=task-1",
    ]);
    expect(result).toMatchObject({
      completed: false,
      verification: {
        verified: false,
        blockers: ["Proof-chain blocker: incomplete_execution_proof"],
      },
      completeResult: null,
    });
  });
});
