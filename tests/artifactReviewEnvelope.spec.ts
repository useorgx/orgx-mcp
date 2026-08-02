import { describe, expect, it, vi } from "vitest";

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
