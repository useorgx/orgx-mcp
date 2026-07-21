import { describe, expect, it } from "vitest";

import { buildCompletionProofMetadata } from "../src/completeWithProof";

describe("buildCompletionProofMetadata", () => {
  it("fills the verifier packet so proof-backed completion does not need force", () => {
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
      schema_validated: true,
      schema_validated_artifact: true,
      completion_state: "completed",
      proof_state: "approved",
      quality_eval_state: "passed",
      outcome_event_status: "completion_verified",
      source_tool: "entity_action.complete_with_proof",
      source_client: "codex",
      owner_source: "entity_action.complete_with_proof",
      run_or_session_ref: "run-123",
      run_ref: "run-123",
      created_by_type: "agent",
      created_by_id: "engineering-agent",
      next_action: "monitor_adoption_and_impact",
      quality_score: 4.7,
      task_id: "task-1",
    });
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
