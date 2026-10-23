import { describe, expect, it, vi } from "vitest";
import privateResponse from "./fixtures/nativeArtifactReview.private.json";
import publicResponse from "./fixtures/nativeArtifactReview.public.json";
import databasePrivateContract from "./fixtures/nativeArtifactReview.db-private.json";
import databasePublicContract from "./fixtures/nativeArtifactReview.db-public.json";
import {
  artifactQualityPresentationSchema,
  canonicalNativeArtifactQuality,
} from "../src/nativeArtifactQuality";
import { getToolOutputSchema } from "../src/openaiOutputSchemas";
import {
  loadArtifactReviewEnvelope,
  summarizeArtifactReviewEnvelope,
} from "../src/artifactReview";

const copy = () => structuredClone(privateResponse);

// These raw contracts are captured from the production builder over an owned
// synthetic PostgreSQL/PostgREST run. This structural wrapper is not a live GET.
function databaseEnvelope(reviewContract: Record<string, unknown>) {
  const file = databasePrivateContract.frontDoor.files[0];
  return {
    artifact: {
      id: file.artifactId,
      version: databasePrivateContract.lineage.version,
      artifact_type: "research.synthesis_brief",
      name: file.name,
      status: databasePrivateContract.lifecycle.state,
      metadata: {},
      verification: {},
    },
    reviewContract,
    reviewContractSource: "canonical",
  };
}

describe("production native artifact quality wire projection", () => {
  it("accepts the unchanged database-backed private and public canonical contracts", () => {
    for (const contract of [databasePrivateContract, databasePublicContract]) {
      const response = databaseEnvelope(contract);
      for (const tool of ["review_artifact", "orgx_open_artifact_review"]) {
        const parsed = getToolOutputSchema(tool)!.safeParse(response);
        expect(
          parsed.success,
          JSON.stringify(parsed.success ? null : parsed.error.issues)
        ).toBe(true);
        if (parsed.success)
          expect(parsed.data.reviewContract).toMatchObject({
            quality: contract.quality,
            checks: contract.checks,
          });
      }
    }
    expect(
      canonicalNativeArtifactQuality(databaseEnvelope(databasePrivateContract))
    ).toEqual(databasePrivateContract.quality);
    expect(databasePrivateContract.checks.total).toBe(5);
    expect(databasePrivateContract.frontDoor.receipt.costUsd).toBe(0.001);
    expect(
      canonicalNativeArtifactQuality(databaseEnvelope(databasePublicContract))
    ).toBeNull();
    expect(databasePublicContract.quality).not.toHaveProperty("native");
    expect(databasePublicContract.quality.anatomy).toBeNull();
    expect(databasePublicContract).not.toHaveProperty("frontDoor");
    expect(JSON.stringify(databasePublicContract)).not.toContain(
      databasePrivateContract.quality.thresholdSource.profileName
    );
    expect(JSON.stringify(databasePublicContract)).not.toContain(
      databasePrivateContract.quality.native.verificationId
    );
  });
  it("accepts the actual app projection through source, reviewed and operation response schemas", () => {
    const response = copy();
    expect(
      artifactQualityPresentationSchema.parse(response.reviewContract.quality)
        .native
    ).toEqual(response.reviewContract.quality.native);
    for (const tool of ["review_artifact", "orgx_open_artifact_review"]) {
      const result = getToolOutputSchema(tool)!.safeParse(response);
      expect(
        result.success,
        JSON.stringify(result.success ? null : result.error.issues)
      ).toBe(true);
      if (result.success) expect(result.data).toMatchObject(response);
    }
    expect(canonicalNativeArtifactQuality(response)).toMatchObject({
      scoreBasis: "judged_lower_bound",
      runId: null,
    });
  });
  it("loads canonical private evidence without a fabricated legacy eval link, approval or acceptance", async () => {
    const response = copy();
    const actor = { userId: "owner", workspaceId: "workspace" };
    const callApi = vi.fn().mockResolvedValue({ json: async () => response });
    const envelope = await loadArtifactReviewEnvelope({
      env: {
        ORGX_API_URL: "https://example.test",
        ORGX_SERVICE_KEY: "fixture",
      },
      artifact: response.artifact,
      actor,
      callApi,
    });
    expect(envelope.reviewContractSource).toBe("canonical");
    expect(envelope.reviewContract?.quality).toEqual(
      response.reviewContract.quality
    );
    const summary = summarizeArtifactReviewEnvelope(envelope);
    expect(summary).toContain("96/100 (judged lower bound)");
    expect(summary).toContain("Human ruling: pending");
    expect(summary).toContain("Observed outcome: unobserved");
    expect(summary).not.toContain("/eval-runs/");
    expect(callApi.mock.calls[0][3]).toEqual(actor);
  });
  it("keeps a failed measured result failed even when the judged lower bound clears the bar", () => {
    const response = copy();
    response.reviewContract.quality.state = "failed";
    response.reviewContract.quality.blocksAdvance = true;
    response.reviewContract.quality.anatomy!.decision.status = "failed";
    response.reviewContract.checks!.state = "failed";
    response.reviewContract.checks!.passed = 0;
    response.reviewContract.checks!.checks[0].status = "failed";
    expect(canonicalNativeArtifactQuality(response)?.state).toBe("failed");
    expect(summarizeArtifactReviewEnvelope(response)).toContain(
      "Quality: failed 96/100 (judged lower bound)"
    );
  });
  it("preserves the real public projection without private native evidence", () => {
    expect(
      getToolOutputSchema("review_artifact")!.safeParse(publicResponse).success
    ).toBe(true);
    expect(canonicalNativeArtifactQuality(publicResponse)).toBeNull();
    expect(publicResponse.reviewContract.quality).not.toHaveProperty("native");
    expect(JSON.stringify(publicResponse.reviewContract)).not.toContain(
      "Private client closeout bar"
    );
  });
  it("never promotes producer metadata or an entity fallback into native verification", () => {
    const response = copy();
    expect(
      canonicalNativeArtifactQuality({
        ...response,
        reviewContractSource: "entity_fallback",
      })
    ).toBeNull();
    expect(
      canonicalNativeArtifactQuality({
        ...response,
        reviewContract: null,
        artifact: {
          ...response.artifact,
          metadata: { nativeQuality: response.reviewContract.quality },
        },
      })
    ).toBeNull();
  });
  it.each([
    (q: any) => {
      q.native.extraAuthority = true;
    },
    (q: any) => {
      q.native.report.extraClaim = "verified";
    },
    (q: any) => {
      q.native.report.uri = "https://unadmitted.example/report";
    },
    (q: any) => {
      q.native.subjectDigest = `sha256:${"b".repeat(64)}`;
    },
    (q: any) => {
      q.anatomy.profile.id = "invented-legacy-profile";
    },
    (q: any) => {
      q.anatomy.runner.extraClaim = true;
    },
    (q: any) => {
      q.runId = "invented-legacy-run";
    },
    (q: any) => {
      q.scoreBasis = "mean";
    },
    (q: any) => {
      delete q.native;
    },
  ])(
    "rejects incoherent or open native claims in the actual tool validator",
    (mutate) => {
      const response = copy();
      mutate(response.reviewContract.quality);
      for (const tool of ["review_artifact", "orgx_open_artifact_review"])
        expect(getToolOutputSchema(tool)!.safeParse(response).success).toBe(
          false
        );
      expect(canonicalNativeArtifactQuality(response)).toBeNull();
    }
  );
  it("rejects a crossed revision even when its verification object is well formed", async () => {
    const response = copy();
    response.artifact.version += 1;
    expect(canonicalNativeArtifactQuality(response)).toBeNull();
    const result = await loadArtifactReviewEnvelope({
      env: { ORGX_API_URL: "https://example.test" },
      artifact: response.artifact,
      actor: { userId: "owner" },
      callApi: vi.fn().mockResolvedValue({ json: async () => response }),
    });
    expect(result.reviewContract).toBeNull();
    expect(result.reviewContractSource).toBe("entity_fallback");
  });
});
