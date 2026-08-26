/**
 * Bounded, provider-neutral contracts for the Agentic Scale Proof.
 *
 * Raw OTel traffic stays outside the accountability graph. Only explicitly
 * material semantic events are promoted. This module deliberately does not
 * inspect prompts or chain-of-thought and never upgrades missing evidence into
 * a successful claim.
 */

export const ACCOUNTABILITY_KINDS = [
  'decision',
  'authorization',
  'commitment',
  'effect',
  'evidence',
  'acceptance',
  'expectation',
  'observation',
  'outcome',
] as const;

export type AccountabilityKind = (typeof ACCOUNTABILITY_KINDS)[number];
export type TrustTier =
  | 'native'
  | 'provider_attested'
  | 'runtime_observed'
  | 'deterministic'
  | 'independently_judged'
  | 'producer_claimed'
  | 'inferred';

export interface OtelLikeEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  timestamp: string;
  attributes: Record<string, unknown>;
}

export interface AccountabilityNode {
  id: string;
  episodeId: string;
  kind: AccountabilityKind;
  occurredAt: string;
  sourceRef: string;
  trustTier: TrustTier;
  subjectDigest?: string;
  branchId?: string;
  status?: string;
}

export interface PromotionResult {
  nodes: AccountabilityNode[];
  rawCount: number;
  promotedCount: number;
  droppedCount: number;
  gaps: Array<{ sourceRef: string; reason: string }>;
}

const KINDS = new Set<string>(ACCOUNTABILITY_KINDS);
const TRUST_TIERS = new Set<TrustTier>([
  'native',
  'provider_attested',
  'runtime_observed',
  'deterministic',
  'independently_judged',
  'producer_claimed',
  'inferred',
]);

function stringAttribute(
  attributes: Record<string, unknown>,
  key: string
): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isMaterial(attributes: Record<string, unknown>): boolean {
  return attributes['orgx.material'] === true;
}

/** Promote only native/attested semantic facts; inference remains a gap. */
export function promoteOtelEvents(events: readonly OtelLikeEvent[]): PromotionResult {
  const nodes: AccountabilityNode[] = [];
  const gaps: PromotionResult['gaps'] = [];

  for (const event of events) {
    if (!isMaterial(event.attributes)) continue;

    const sourceRef = `otel://${event.traceId}/${event.spanId}`;
    const episodeId = stringAttribute(event.attributes, 'orgx.episode.id');
    const kind = stringAttribute(event.attributes, 'orgx.semantic.kind');
    const rawTrust = stringAttribute(event.attributes, 'orgx.trust.tier');

    if (!episodeId || !kind || !KINDS.has(kind)) {
      gaps.push({ sourceRef, reason: 'material_event_missing_semantic_contract' });
      continue;
    }

    const trustTier = TRUST_TIERS.has(rawTrust as TrustTier)
      ? (rawTrust as TrustTier)
      : 'runtime_observed';
    if (trustTier === 'inferred') {
      gaps.push({ sourceRef, reason: 'inferred_event_not_promoted' });
      continue;
    }

    nodes.push({
      id: stringAttribute(event.attributes, 'orgx.node.id') ?? sourceRef,
      episodeId,
      kind: kind as AccountabilityKind,
      occurredAt: event.timestamp,
      sourceRef,
      trustTier,
      subjectDigest: stringAttribute(event.attributes, 'orgx.subject.digest'),
      branchId: stringAttribute(event.attributes, 'orgx.branch.id'),
      status: stringAttribute(event.attributes, 'orgx.status'),
    });
  }

  return {
    nodes,
    rawCount: events.length,
    promotedCount: nodes.length,
    droppedCount: events.length - nodes.length,
    gaps,
  };
}

export type ExecutionGraphPromotionResult =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      code: 'invalid_input' | 'unverifiable_otel_emission';
      status: 400 | 422;
      message: string;
      gaps?: PromotionResult['gaps'];
    };

/** Normalize the existing execution-graph emission without forwarding raw OTel. */
export function buildExecutionGraphEmission(
  args: Record<string, unknown>
): ExecutionGraphPromotionResult {
  const explicitNodes = Array.isArray(args.nodes) ? args.nodes : [];
  const otelEvents = Array.isArray(args.otel_events)
    ? (args.otel_events as OtelLikeEvent[])
    : [];
  if (explicitNodes.length === 0 && otelEvents.length === 0) {
    return {
      ok: false,
      code: 'invalid_input',
      status: 400,
      message: 'orgx_emit_execution_graph requires nodes or otel_events',
    };
  }
  if (otelEvents.length === 0) return { ok: true, body: args };

  const promotion = promoteOtelEvents(otelEvents);
  const promotedNodes = promotion.nodes.map((node) => ({
    id: node.id,
    type: 'step',
    title: `Semantic ${node.kind}`,
    status: 'completed',
    requires_evidence: ['effect', 'acceptance', 'observation', 'outcome'].includes(
      node.kind
    ),
    verification: {
      // Observation is not the same as independent proof.
      state: 'unverified',
      evidence_ref: node.sourceRef,
      method: `otel_${node.trustTier}`,
    },
    started_at: node.occurredAt,
    completed_at: node.occurredAt,
    metadata: {
      accountability_kind: node.kind,
      episode_id: node.episodeId,
      trust_tier: node.trustTier,
      subject_digest: node.subjectDigest,
      branch_id: node.branchId,
      semantic_status: node.status,
    },
  }));
  if (explicitNodes.length + promotedNodes.length === 0) {
    return {
      ok: false,
      code: 'unverifiable_otel_emission',
      status: 422,
      message: 'No OTel events were eligible for semantic promotion',
      gaps: promotion.gaps,
    };
  }

  const { otel_events: _otelEvents, ...withoutRawEvents } = args;
  const existingMetadata =
    withoutRawEvents.metadata &&
    typeof withoutRawEvents.metadata === 'object' &&
    !Array.isArray(withoutRawEvents.metadata)
      ? (withoutRawEvents.metadata as Record<string, unknown>)
      : {};
  return {
    ok: true,
    body: {
      ...withoutRawEvents,
      nodes: [...explicitNodes, ...promotedNodes],
      metadata: {
        ...existingMetadata,
        otel_semantic_promotion: {
          raw_count: promotion.rawCount,
          promoted_count: promotion.promotedCount,
          dropped_count: promotion.droppedCount,
          gaps: promotion.gaps,
        },
      },
    },
  };
}

export type EvidenceCoverageState =
  | 'complete'
  | 'partial'
  | 'known_gap'
  | 'emitter_unavailable'
  | 'out_of_band_effect'
  | 'disputed'
  | 'unverifiable';

export interface ExpectedEvidenceItem {
  id: string;
  required: boolean;
  observedRef?: string;
  gapState?: Exclude<EvidenceCoverageState, 'complete' | 'partial'>;
}

export interface EvidenceCoverage {
  state: EvidenceCoverageState;
  expected: number;
  required: number;
  observed: number;
  missingRequired: string[];
  knownGaps: string[];
}

export function assessEvidenceCoverage(
  expectedEvidence: readonly ExpectedEvidenceItem[]
): EvidenceCoverage {
  const requiredItems = expectedEvidence.filter((item) => item.required);
  const observed = expectedEvidence.filter((item) => item.observedRef).length;
  const missingRequired = requiredItems
    .filter((item) => !item.observedRef)
    .map((item) => item.id);
  const knownGaps = expectedEvidence
    .filter((item) => item.gapState)
    .map((item) => `${item.id}:${item.gapState}`);

  let state: EvidenceCoverageState = 'complete';
  if (missingRequired.length > 0) {
    const explicitStates = requiredItems
      .filter((item) => !item.observedRef && item.gapState)
      .map((item) => item.gapState!);
    state = explicitStates.includes('out_of_band_effect')
      ? 'out_of_band_effect'
      : explicitStates.includes('emitter_unavailable')
      ? 'emitter_unavailable'
      : explicitStates.includes('disputed')
      ? 'disputed'
      : explicitStates.length === missingRequired.length
      ? 'known_gap'
      : 'partial';
  } else if (observed < expectedEvidence.length) {
    state = 'partial';
  }

  return {
    state,
    expected: expectedEvidence.length,
    required: requiredItems.length,
    observed,
    missingRequired,
    knownGaps,
  };
}

export const BRANCH_DISPOSITIONS = [
  'adopted',
  'rejected',
  'abandoned',
  'superseded',
  'failed',
  'unresolved',
] as const;
export type BranchDisposition = (typeof BRANCH_DISPOSITIONS)[number];

export interface EpisodeBranch {
  id: string;
  material: boolean;
  disposition?: BranchDisposition;
  selectionReceiptRef?: string;
}

export function findUnaccountedBranches(
  branches: readonly EpisodeBranch[]
): string[] {
  return branches
    .filter(
      (branch) =>
        branch.material &&
        (!branch.disposition ||
          (branch.disposition === 'adopted' && !branch.selectionReceiptRef))
    )
    .map((branch) => branch.id);
}

export const ASSURANCE_DEPENDENCIES = [
  'subject',
  'context',
  'policy',
  'evaluator',
  'runtime',
  'evidence',
  'independence',
] as const;
export type AssuranceDependency = (typeof ASSURANCE_DEPENDENCIES)[number];
export type AssuranceDigests = Record<AssuranceDependency, string>;

export interface AssuranceSnapshot {
  id: string;
  digests: AssuranceDigests;
  issuedAt: string;
  expiresAt: string;
}

export interface AssuranceValidity {
  state: 'valid' | 'stale' | 'expired' | 'unverifiable';
  invalidatedBy: AssuranceDependency[];
  reasons: string[];
}

export function evaluateAssuranceValidity(input: {
  snapshot?: AssuranceSnapshot;
  current: Partial<AssuranceDigests>;
  now: string;
}): AssuranceValidity {
  if (!input.snapshot) {
    return {
      state: 'unverifiable',
      invalidatedBy: [],
      reasons: ['missing_assurance_snapshot'],
    };
  }

  if (Date.parse(input.snapshot.expiresAt) <= Date.parse(input.now)) {
    return {
      state: 'expired',
      invalidatedBy: [],
      reasons: ['assurance_expired'],
    };
  }

  const missing = ASSURANCE_DEPENDENCIES.filter(
    (dependency) => !input.current[dependency]
  );
  if (missing.length > 0) {
    return {
      state: 'unverifiable',
      invalidatedBy: missing,
      reasons: missing.map((dependency) => `missing_${dependency}_digest`),
    };
  }

  const changed = ASSURANCE_DEPENDENCIES.filter(
    (dependency) =>
      input.snapshot!.digests[dependency] !== input.current[dependency]
  );
  return changed.length > 0
    ? {
        state: 'stale',
        invalidatedBy: changed,
        reasons: changed.map((dependency) => `${dependency}_digest_changed`),
      }
    : { state: 'valid', invalidatedBy: [], reasons: [] };
}
