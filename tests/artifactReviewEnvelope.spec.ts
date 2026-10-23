import { describe, expect, it, vi } from "vitest";
import { outputFrontDoor } from './fixtures/outputFrontDoor';

import {
  loadArtifactReviewEnvelope,
  summarizeArtifactReviewEnvelope,
} from "../src/artifactReview";

const env = {
  ORGX_API_URL: "https://example.test",
  ORGX_SERVICE_KEY: "test-key",
};

const artifact = {
  id: "artifact-1",
  name: "Launch narrative",
  status: "approved",
  summary: "Compact entity record",
};

const reviewContract = {
  schemaVersion: "artifact_review_contract.v1",
  quality: { state: "unscored", score: null },
  ruling: { state: "accepted" },
  outcome: { state: "unobserved" },
  modalityGate: { state: "blocked" },
  workflow: { headline: "Visual proof incomplete", canAdvance: false },
};

describe("artifact review envelope", () => {
  it('narrates an admitted summary in five lines while keeping producer claims separate', () => {
    const summary = summarizeArtifactReviewEnvelope({ artifact, reviewContract: { ...reviewContract, frontDoor: outputFrontDoor() }, reviewContractSource: 'canonical' });
    expect(summary.split('\n')).toHaveLength(5);
    expect(summary).toContain('Answer: Review the client deck');
    expect(summary).toContain('Context: partial. The brief loaded. Budget was not recorded.');
    expect(summary).toContain('Checked (producer notes)');
    expect(summary).toContain('Run cost: $0.00; expert minutes left: 0; quality bar: Not recorded');
    expect(summary).toContain('Quality: unscored; human ruling: accepted; outcome: unobserved');
    expect(summary).toContain('Modality proof: blocked');
    expect(summary).toContain('Decision: Visual proof incomplete');
    expect(summary).toContain('https://useorgx.com/console/runs/');
  });

  it('drops an invalid additive summary and preserves the canonical review and actor scope', async () => {
    const actor = { userId: 'u', userEmail: null, workspaceId: 'workspace-1', runId: 'run-1', scopes: ['entities:read'] };
    const callApi = vi.fn().mockResolvedValue({ json: async () => ({ artifact, reviewContract: { ...reviewContract, frontDoor: { ...outputFrontDoor(), context: { state: 'loaded', team: 'invented' } } } }) });
    const result = await loadArtifactReviewEnvelope({ env, artifact, actor, callApi });
    expect(result.reviewContractSource).toBe('canonical');
    expect(result.reviewContract).toEqual(reviewContract);
    expect(callApi.mock.calls[0]?.[3]).toEqual(actor);
  });
  it("loads the canonical detail projection with the same authenticated actor", async () => {
    const callApi = vi.fn().mockResolvedValue({
      json: async () => ({
        artifact: {
          id: "artifact-1",
          description: "Full artifact record",
        },
        reviewContract,
      }),
    });

    const result = await loadArtifactReviewEnvelope({
      env,
      artifact,
      actor: {
        userId: "user-1",
        userEmail: "reviewer@example.test",
        orgxUserId: "orgx-user-1",
      },
      callApi,
    });

    expect(callApi).toHaveBeenCalledWith(
      env,
      "/api/artifacts/artifact-1",
      undefined,
      {
        userId: "user-1",
        userEmail: "reviewer@example.test",
        orgxUserId: "orgx-user-1",
      },
    );
    expect(result).toEqual({
      artifact: {
        ...artifact,
        description: "Full artifact record",
      },
      reviewContract,
      reviewContractSource: "canonical",
    });
  });

  it("fails soft without inventing evidence when detail loading fails", async () => {
    const result = await loadArtifactReviewEnvelope({
      env,
      artifact,
      actor: { userId: "user-1" },
      callApi: vi.fn().mockRejectedValue(new Error("not deployed yet")),
    });

    expect(result).toEqual({
      artifact,
      reviewContract: null,
      reviewContractSource: "entity_fallback",
    });
    expect(summarizeArtifactReviewEnvelope(result)).toContain(
      "Canonical quality evidence is not available",
    );
  });

  it("rejects a contract attached to a different artifact subject", async () => {
    const result = await loadArtifactReviewEnvelope({
      env,
      artifact,
      actor: { userId: "user-1" },
      callApi: vi.fn().mockResolvedValue({
        json: async () => ({
          artifact: { id: "artifact-2" },
          reviewContract,
        }),
      }),
    });

    expect(result.reviewContract).toBeNull();
    expect(result.reviewContractSource).toBe("entity_fallback");
  });

  it("narrates approval, quality, proof, ruling, and outcome as separate states", () => {
    expect(
      summarizeArtifactReviewEnvelope({
        artifact,
        reviewContract,
        reviewContractSource: "canonical",
      }),
    ).toBe(
      "Artifact ready for review: **Launch narrative**. Lifecycle: approved. Quality: unscored. Human ruling: accepted. Modality proof: blocked. Observed outcome: unobserved. Decision: Visual proof incomplete",
    );
  });
});
