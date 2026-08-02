import { callOrgxApiJson, type OrgxApiEnv } from "./orgxApi";

export type ArtifactReviewRecord = Record<string, unknown>;

export interface ArtifactReviewEnvelope {
  [key: string]: unknown;
  artifact: ArtifactReviewRecord;
  reviewContract: ArtifactReviewRecord | null;
  reviewContractSource: "canonical" | "entity_fallback";
}

interface ArtifactReviewActorContext {
  userId?: string;
  userEmail?: string;
  orgxUserId?: string;
}

type OrgxApiCaller = typeof callOrgxApiJson;

function asRecord(value: unknown): ArtifactReviewRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ArtifactReviewRecord)
    : {};
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isCanonicalReviewContract(
  value: unknown,
): value is ArtifactReviewRecord {
  const contract = asRecord(value);
  return (
    contract.schemaVersion === "artifact_review_contract.v1" &&
    Object.keys(asRecord(contract.quality)).length > 0 &&
    Object.keys(asRecord(contract.workflow)).length > 0
  );
}

/**
 * Enrich the compact entity-list record with the app's canonical, server-built
 * review projection. The detail read is deliberately fail-soft: MCP review
 * remains available during a staggered app deployment, but never fabricates a
 * review contract or attaches one returned for a different artifact.
 */
export async function loadArtifactReviewEnvelope(params: {
  env: OrgxApiEnv;
  artifact: ArtifactReviewRecord;
  actor: ArtifactReviewActorContext;
  callApi?: OrgxApiCaller;
}): Promise<ArtifactReviewEnvelope> {
  const artifactId = cleanString(params.artifact.id);
  if (!artifactId) {
    return {
      artifact: params.artifact,
      reviewContract: null,
      reviewContractSource: "entity_fallback",
    };
  }

  const callApi = params.callApi ?? callOrgxApiJson;
  try {
    const response = await callApi(
      params.env,
      `/api/artifacts/${encodeURIComponent(artifactId)}`,
      undefined,
      params.actor,
    );
    const payload = asRecord(await response.json());
    const detailedArtifact = asRecord(payload.artifact);
    const detailedArtifactId = cleanString(detailedArtifact.id);
    const reviewContract = payload.reviewContract;

    if (
      detailedArtifactId !== artifactId ||
      !isCanonicalReviewContract(reviewContract)
    ) {
      return {
        artifact: params.artifact,
        reviewContract: null,
        reviewContractSource: "entity_fallback",
      };
    }

    return {
      artifact: { ...params.artifact, ...detailedArtifact },
      reviewContract,
      reviewContractSource: "canonical",
    };
  } catch {
    return {
      artifact: params.artifact,
      reviewContract: null,
      reviewContractSource: "entity_fallback",
    };
  }
}

function humanize(value: unknown, fallback: string): string {
  const text = cleanString(value);
  if (!text) return fallback;
  return text.replace(/[_.-]+/g, " ");
}

/** Model-visible narration keeps lifecycle, quality, ruling, and outcomes as
 * separate proof states so the widget remains understandable without UI. */
export function summarizeArtifactReviewEnvelope(
  envelope: ArtifactReviewEnvelope,
): string {
  const artifact = envelope.artifact;
  const name =
    cleanString(artifact.name) ?? cleanString(artifact.title) ?? "artifact";
  const status = humanize(artifact.status, "in review");
  const contract = envelope.reviewContract;

  if (!contract) {
    return `Artifact ready for review: **${name}** (lifecycle: ${status}). Canonical quality evidence is not available in this response; inspect the attached artifact before acting.`;
  }

  const quality = asRecord(contract.quality);
  const ruling = asRecord(contract.ruling);
  const outcome = asRecord(contract.outcome);
  const modalityGate = asRecord(contract.modalityGate);
  const workflow = asRecord(contract.workflow);
  const score =
    typeof quality.score === "number" && Number.isFinite(quality.score)
      ? ` ${Math.round(quality.score * 100)}/100`
      : "";

  return [
    `Artifact ready for review: **${name}**.`,
    `Lifecycle: ${status}.`,
    `Quality: ${humanize(quality.state, "unscored")}${score}.`,
    `Human ruling: ${humanize(ruling.state, "none")}.`,
    `Modality proof: ${humanize(modalityGate.state, "not required")}.`,
    `Observed outcome: ${humanize(outcome.state, "unobserved")}.`,
    `Decision: ${cleanString(workflow.headline) ?? "Inspect the evidence."}`,
  ].join(" ");
}
