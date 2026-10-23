import { callOrgxApiJson, type OrgxApiEnv, type GatewayDelegationClaims } from "./orgxApi";
import { canonicalOutputFrontDoor } from './outputFrontDoor';
import { buildEntityLink } from './deepLinks';

export type ArtifactReviewRecord = Record<string, unknown>;

export interface ArtifactReviewEnvelope {
  [key: string]: unknown;
  artifact: ArtifactReviewRecord;
  reviewContract: ArtifactReviewRecord | null;
  reviewContractSource: "canonical" | "entity_fallback";
}

interface ArtifactReviewActorContext extends GatewayDelegationClaims {
  userId?: string | null;
  userEmail?: string | null;
  orgxUserId?: string | null;
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

    // Admit the additive presentation block through its closed contract. A
    // malformed block cannot turn metadata into context, spend or authority.
    const frontDoor = canonicalOutputFrontDoor({ reviewContract: asRecord(reviewContract), reviewContractSource: 'canonical' });
    const admittedContract = { ...asRecord(reviewContract) };
    delete admittedContract.frontDoor;
    if (frontDoor) admittedContract.frontDoor = frontDoor;
    return {
      artifact: { ...params.artifact, ...detailedArtifact },
      reviewContract: admittedContract,
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

  const frontDoor = canonicalOutputFrontDoor(envelope);
  if (frontDoor) {
    const line = (value: string) => value.replace(/\s+/g, ' ').trim();
    const decisions = frontDoor.decisions.map((decision) =>
      `${line(decision.question)} Recommend: ${line(decision.recommendation)} Impact: ${line(decision.impact)} (${buildEntityLink('decision', decision.id).url})`
    );
    const artifactId = cleanString(artifact.id);
    const output = artifactId ? buildEntityLink('artifact', artifactId).url : 'Open the artifact in OrgX.';
    const receipt = frontDoor.receipt.runId && frontDoor.receipt.href
      ? new URL(frontDoor.receipt.href, buildEntityLink('run', frontDoor.receipt.runId).url).toString() : null;
    const cost = frontDoor.receipt.costUsd;
    const costText = cost === null ? 'Not recorded' : cost > 0 && cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
    return [
      `Answer: ${line(frontDoor.answer)}`,
      `Decisions: ${decisions.length ? decisions.join(' | ') : 'None requested.'}`,
      `Context: ${frontDoor.context.state}. ${line(frontDoor.context.summary)}`,
      `Checked (producer notes): ${frontDoor.checked.map(line).join('; ') || 'None recorded'}. Not checked: ${frontDoor.notChecked.map(line).join('; ') || 'None recorded'}. Quality: ${humanize(quality.state, 'unscored')}${score}; human ruling: ${humanize(ruling.state, 'none')}; outcome: ${humanize(outcome.state, 'unobserved')}.`,
      `Files: ${frontDoor.files.length}. Run cost: ${costText}; expert minutes left: ${frontDoor.receipt.expertMinutes ?? 'Not recorded'}; quality bar: ${frontDoor.receipt.qualityBar ? line(frontDoor.receipt.qualityBar) : 'Not recorded'}. Open: ${output}${receipt ? ` | Run receipt: ${receipt}` : ''}`,
    ].join('\n');
  }

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
