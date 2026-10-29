type JsonRecord = Record<string, unknown>;

export const ARTIFACT_REVIEW_SELECTION_STATUSES = [
  'in_review',
  'eval_passed',
  'approved',
  'changes_requested',
  'rejected',
] as const;

const PAGE_SIZE = 50;
const HYDRATION_CONCURRENCY = 6;
const MAX_DISCOVERY_ROWS = 500;
const MAX_HYDRATED_CANDIDATES = 48;

export class ArtifactReviewSelectionExhaustedError extends Error {
  constructor() {
    super(
      'Artifact review selection reached its bounded search window before finding a canonical target. Provide artifact_id or a narrower entity_id.'
    );
    this.name = 'ArtifactReviewSelectionExhaustedError';
  }
}

export type ArtifactReviewSelectionRequest = (
  path: string
) => Promise<JsonRecord>;

export interface SelectArtifactForReviewOptions {
  request: ArtifactReviewSelectionRequest;
  explicitArtifactId?: string | null;
  entityId?: string | null;
  workspaceId?: string | null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function artifactIdFromCandidate(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmptyString(record?.id);
}

function candidateMatchesEntityScope(
  value: unknown,
  requestedEntityId: string | null
): boolean {
  const candidate = asRecord(value);
  return candidate
    ? artifactMatchesEntityScope(candidate, requestedEntityId)
    : false;
}

function artifactMatchesEntityScope(
  artifact: JsonRecord,
  requestedEntityId: string | null
): boolean {
  if (!requestedEntityId) return true;

  const metadata = asRecord(artifact.metadata);
  const knownScopeIds = [
    artifact.entity_id,
    artifact.entityId,
    artifact.task_id,
    artifact.taskId,
    artifact.initiative_id,
    artifact.initiativeId,
    metadata?.source_entity_id,
    metadata?.sourceEntityId,
    metadata?.source_initiative_id,
    metadata?.sourceInitiativeId,
    metadata?.context_entity_id,
    metadata?.contextEntityId,
  ];

  return knownScopeIds.some(
    (value) => nonEmptyString(value) === requestedEntityId
  );
}

function isCanonicalPendingReviewTarget(
  payload: JsonRecord,
  requestedEntityId: string | null
): boolean {
  const artifact = asRecord(payload.artifact);
  const reviewContract = asRecord(payload.reviewContract);
  const purpose = asRecord(reviewContract?.purpose);
  const ruling = asRecord(reviewContract?.ruling);
  const lineage = asRecord(reviewContract?.lineage);
  const workflow = asRecord(reviewContract?.workflow);
  const authority = asRecord(reviewContract?.authority);

  // Candidate list rows are discovery hints only. The canonical artifact
  // response must independently prove current purpose, ruling, lineage,
  // workflow, and reviewer authority. Lifecycle status is deliberately not an
  // authorization check here: legacy approved/changes-requested/rejected rows
  // can still have a pending canonical ruling and need a human decision.
  if (
    !artifact ||
    reviewContract?.schemaVersion !== 'artifact_review_contract.v1' ||
    purpose?.reviewRequired !== true ||
    ruling?.state !== 'pending' ||
    lineage?.state !== 'current' ||
    workflow?.canAdvance !== false ||
    authority?.canReview !== true
  ) {
    return false;
  }

  return artifactMatchesEntityScope(artifact, requestedEntityId);
}

function readSelectionPage(payload: JsonRecord, requestedOffset: number) {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const pagination = asRecord(payload.pagination);
  const offset = finiteNonNegative(pagination?.offset) ?? requestedOffset;
  const limit = finiteNonNegative(pagination?.limit) ?? PAGE_SIZE;
  const total = finiteNonNegative(pagination?.total);
  const hasMore =
    pagination?.has_more === true ||
    (pagination?.has_more !== false &&
      total !== null &&
      offset + data.length < total);
  const nextOffset = hasMore
    ? finiteNonNegative(pagination?.next_offset) ?? offset + limit
    : null;

  return { data, nextOffset };
}

/**
 * Resolve either an explicitly requested artifact or the next canonical human
 * review target. Collection rows never authorize selection: every discovered
 * ID is re-read through `/api/artifacts/:id`, then checked for current purpose,
 * pending human ruling, and exact entity scope before it can be returned.
 */
export async function selectArtifactForReview({
  request,
  explicitArtifactId,
  entityId,
  workspaceId,
}: SelectArtifactForReviewOptions): Promise<JsonRecord | null> {
  const explicitId = nonEmptyString(explicitArtifactId);
  if (explicitId) {
    // Explicit inspection intentionally preserves the existing behavior: an
    // evidence-only or already-ruled artifact may still be opened by ID.
    return request(`/api/artifacts/${encodeURIComponent(explicitId)}`);
  }

  const requestedEntityId = nonEmptyString(entityId);
  const requestedWorkspaceId = nonEmptyString(workspaceId);
  const hydratedArtifactIds = new Set<string>();
  let discoveredRows = 0;
  let hydratedCandidates = 0;

  for (const status of ARTIFACT_REVIEW_SELECTION_STATUSES) {
    let offset = 0;
    const visitedOffsets = new Set<number>();

    while (!visitedOffsets.has(offset)) {
      visitedOffsets.add(offset);

      const params = new URLSearchParams({
        type: 'artifact',
        status,
        limit: String(PAGE_SIZE),
        offset: String(offset),
        fields: 'id,entity_type,entity_id,metadata',
      });
      if (requestedWorkspaceId) {
        params.set('workspace_id', requestedWorkspaceId);
      }

      const pagePayload = await request(`/api/entities?${params.toString()}`);
      const page = readSelectionPage(pagePayload, offset);
      const remainingDiscoveryRows = MAX_DISCOVERY_ROWS - discoveredRows;
      const boundedPage = page.data.slice(0, remainingDiscoveryRows);
      discoveredRows += boundedPage.length;

      const candidateIds = boundedPage
        .filter((candidate) =>
          candidateMatchesEntityScope(candidate, requestedEntityId)
        )
        .map(artifactIdFromCandidate)
        .filter((id): id is string => Boolean(id))
        .filter((id) => !hydratedArtifactIds.has(id));

      for (
        let index = 0;
        index < candidateIds.length;
        index += HYDRATION_CONCURRENCY
      ) {
        const availableHydrations =
          MAX_HYDRATED_CANDIDATES - hydratedCandidates;
        if (availableHydrations <= 0) {
          throw new ArtifactReviewSelectionExhaustedError();
        }

        const batchIds = candidateIds.slice(
          index,
          index + Math.min(HYDRATION_CONCURRENCY, availableHydrations)
        );
        batchIds.forEach((id) => hydratedArtifactIds.add(id));
        hydratedCandidates += batchIds.length;

        const payloads = await Promise.all(
          batchIds.map((candidateId) =>
            request(`/api/artifacts/${encodeURIComponent(candidateId)}`)
          )
        );
        const selected = payloads.find((payload) =>
          isCanonicalPendingReviewTarget(payload, requestedEntityId)
        );
        if (selected) {
          return selected;
        }

        if (
          batchIds.length <
          Math.min(HYDRATION_CONCURRENCY, candidateIds.length - index)
        ) {
          throw new ArtifactReviewSelectionExhaustedError();
        }
      }

      if (
        boundedPage.length < page.data.length ||
        (discoveredRows >= MAX_DISCOVERY_ROWS && page.nextOffset !== null)
      ) {
        throw new ArtifactReviewSelectionExhaustedError();
      }
      if (page.nextOffset === null || page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
  }

  return null;
}
