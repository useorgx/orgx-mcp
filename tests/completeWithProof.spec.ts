import { describe, expect, it, vi } from "vitest";

import {
  buildCompletionProofMetadata,
  executeCompleteWithProofFlow,
} from "../src/completeWithProof";

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
