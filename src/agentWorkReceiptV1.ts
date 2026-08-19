/**
 * Adapter: orgx_submit_receipt tool input → portable Agent Work Receipt v0.1.
 *
 * POST /api/v1/agent-work-receipts is the hash-chained receipt import path.
 * Its body contract is `{ workspace_id, receipt, idempotency_key? }` where
 * `receipt` must be a schema-valid Agent Work Receipt v0.1 document
 * (schema id https://useorgx.com/schemas/agent-work-receipt/v0.1/schema.json).
 *
 * Mapping principles:
 *  - Map every tool field onto the closest honest AWR location.
 *  - Nothing is silently dropped: the complete submitted input (minus the
 *    `_context` runtime envelope) is preserved verbatim under
 *    `extensions["com.useorgx.mcp.submit_receipt"]`.
 *  - Anything the adapter had to normalize, coerce, or decline to forward is
 *    surfaced in `warnings` so the tool result can report it.
 */

export const AGENT_WORK_RECEIPT_SCHEMA_VERSION = 'agent-work-receipt/v0.1';
export const AGENT_WORK_RECEIPTS_V1_PATH = '/api/v1/agent-work-receipts';
export const SUBMIT_RECEIPT_EXTENSION_KEY = 'com.useorgx.mcp.submit_receipt';

/** Body-level idempotency key contract enforced by the v1 import route. */
const V1_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

/** RFC 3339 timestamp accepted by the AWR v0.1 validator. */
const RFC3339_RE =
  /^(\d{4}-\d{2}-\d{2})[tT\s](\d{2}):(\d{2}):(\d{2})(\.\d+)?(z|[+-]\d{2}(?::?\d{2})?)$/i;

const SHORT_STRING_MAX = 512;
const LONG_STRING_MAX = 20_000;

type JsonRecord = Record<string, unknown>;

export interface AgentWorkReceiptImportBody {
  workspace_id: string;
  receipt: JsonRecord;
  idempotency_key?: string;
}

export interface BuildAgentWorkReceiptOptions {
  /** Workspace UUID the import is scoped to. Required by the v1 route. */
  workspaceId: string;
  /** Verbatim client label (e.g. "claude-code") for actor.runtime.name. */
  sourceClient?: string | null;
  /** Clock override for deterministic tests. Defaults to now. */
  issuedAt?: string;
  /** receipt_id override for deterministic tests. */
  receiptId?: string;
}

export interface BuildAgentWorkReceiptResult {
  body: AgentWorkReceiptImportBody;
  /** Normalizations the caller should surface in the tool result. */
  warnings: string[];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function shortString(value: string): string {
  return clampString(value, SHORT_STRING_MAX);
}

function longString(value: string): string {
  return clampString(value, LONG_STRING_MAX);
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function isValidRfc3339(value: string): boolean {
  if (!RFC3339_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Deterministically rewrite an idempotency key that the legacy route accepted
 * (any non-empty string ≤160 chars) into the v1 route's stricter charset, so
 * retries with the same key still deduplicate after the migration.
 */
export function normalizeV1IdempotencyKey(raw: string): {
  key: string;
  changed: boolean;
} {
  if (V1_IDEMPOTENCY_KEY_RE.test(raw)) return { key: raw, changed: false };
  let sanitized = raw.replace(/[^A-Za-z0-9._:/-]/g, '-');
  if (!/^[A-Za-z0-9]/.test(sanitized)) sanitized = `k${sanitized}`;
  sanitized = sanitized.slice(0, 160);
  return { key: sanitized, changed: true };
}

type ActionStatus = 'running' | 'completed' | 'failed' | 'skipped';
type OutcomeStatus = 'succeeded' | 'failed' | 'cancelled' | 'unknown';

function mapWorkStatus(status: string | null): {
  action: ActionStatus;
  outcome: OutcomeStatus;
} {
  switch (status) {
    case 'in_progress':
      return { action: 'running', outcome: 'unknown' };
    case 'failed':
      return { action: 'failed', outcome: 'failed' };
    case 'cancelled':
      // AWR actions have no 'cancelled'; 'skipped' (work not carried out) is
      // the closest truthful action state. The outcome keeps 'cancelled'.
      return { action: 'skipped', outcome: 'cancelled' };
    case 'completed':
    default:
      // The legacy route recorded 'completed' when status was omitted; keep
      // that default so migrated receipts do not silently change meaning.
      return { action: 'completed', outcome: 'succeeded' };
  }
}

type VerificationStatus =
  | 'unverified'
  | 'passed'
  | 'failed'
  | 'inconclusive';
type CheckStatus = 'passed' | 'failed' | 'inconclusive';

function mapVerificationStatus(status: string | null): VerificationStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'blocked':
      // AWR has no 'blocked' verification verdict; a blocked verification is
      // one that could not reach a conclusion.
      return 'inconclusive';
    case 'not_run':
    default:
      return 'unverified';
  }
}

interface EvidenceEntry {
  id: string;
  kind: string;
  summary: string;
  observed_at: string;
  ref?: {
    system: string;
    type: string;
    id: string;
    uri?: string;
  };
}

interface OutcomeMetric {
  name: string;
  value: number;
  unit: string;
}

const URL_EVIDENCE_KINDS: Record<string, string> = {
  prs: 'pr',
  deploys: 'deploy',
  test_runs: 'test_run',
  links: 'link',
};

function mapEvidence(
  evidence: JsonRecord | null,
  observedAt: string,
  warnings: string[]
): { entries: EvidenceEntry[]; metrics: OutcomeMetric[] } {
  const entries: EvidenceEntry[] = [];
  const metrics: OutcomeMetric[] = [];
  if (!evidence) return { entries, metrics };

  const nextId = () => `evidence-${entries.length + 1}`;

  for (const [key, kind] of Object.entries(URL_EVIDENCE_KINDS)) {
    const values = evidence[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const url = nonEmptyString(value);
      if (!url) continue;
      entries.push({
        id: nextId(),
        kind,
        summary: longString(url),
        observed_at: observedAt,
        ref: {
          system: 'url',
          type: kind,
          id: shortString(url).slice(0, SHORT_STRING_MAX),
          uri: clampString(url, 8192),
        },
      });
    }
  }

  const notes = nonEmptyString(evidence.notes);
  if (notes) {
    entries.push({
      id: nextId(),
      kind: 'note',
      summary: longString(notes),
      observed_at: observedAt,
    });
  }

  if (Array.isArray(evidence.metrics)) {
    for (const metric of evidence.metrics) {
      const record = readRecord(metric);
      const name = record ? nonEmptyString(record.name) : null;
      const value =
        record && typeof record.value === 'number' && Number.isFinite(record.value)
          ? record.value
          : null;
      if (!record || !name || value === null) {
        warnings.push(
          'evidence.metrics entry without a name and numeric value was preserved in extensions but not projected to outcome.metrics'
        );
        continue;
      }
      metrics.push({
        name: shortString(name),
        value,
        unit: shortString(nonEmptyString(record.unit) ?? 'count'),
      });
    }
  }

  return { entries, metrics };
}

/**
 * Build the POST /api/v1/agent-work-receipts request body from the
 * orgx_submit_receipt tool input. `args` is the raw tool input (the `_context`
 * runtime envelope is excluded from the preserved extension payload).
 */
export function buildAgentWorkReceiptImportRequest(
  args: JsonRecord,
  options: BuildAgentWorkReceiptOptions
): BuildAgentWorkReceiptResult {
  const warnings: string[] = [];
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const summary =
    nonEmptyString(args.summary) ?? 'Receipt submitted without a summary';
  const receiptType = nonEmptyString(args.receipt_type) ?? 'proof';
  const sourceClient = nonEmptyString(options.sourceClient);
  const agentType = nonEmptyString(args.agent_type);
  const businessOutcome = nonEmptyString(args.business_outcome);
  const entityType = nonEmptyString(args.entity_type);
  const entityId = nonEmptyString(args.entity_id);
  const artifactId = nonEmptyString(args.artifact_id);
  const artifactType = nonEmptyString(args.artifact_type);
  const evidence = readRecord(args.evidence);

  // ---------------------------------------------------------------- keys/ids
  const rawIdempotencyKey = nonEmptyString(args.idempotency_key);
  let idempotencyKey: string | undefined;
  if (rawIdempotencyKey) {
    const normalized = normalizeV1IdempotencyKey(rawIdempotencyKey);
    idempotencyKey = normalized.key;
    if (normalized.changed) {
      warnings.push(
        `idempotency_key was normalized to "${normalized.key}" to satisfy the v1 key charset; retries must keep sending the original key to deduplicate`
      );
    }
  }
  const receiptId =
    options.receiptId ?? idempotencyKey ?? crypto.randomUUID();

  // -------------------------------------------------------------- timestamps
  let startedAt = issuedAt;
  const rawStartedAt = nonEmptyString(args.started_at);
  if (rawStartedAt) {
    if (!isValidRfc3339(rawStartedAt)) {
      warnings.push(
        'started_at was not a valid RFC 3339 timestamp and was not forwarded; duration is recorded as unknown'
      );
    } else if (Date.parse(rawStartedAt) > Date.parse(issuedAt)) {
      warnings.push(
        'started_at was in the future and was not forwarded; duration is recorded as unknown'
      );
    } else {
      startedAt = rawStartedAt;
    }
  }
  const durationMs =
    startedAt === issuedAt
      ? undefined
      : Math.max(0, Date.parse(issuedAt) - Date.parse(startedAt));

  // ------------------------------------------------------------------ status
  const statuses = mapWorkStatus(nonEmptyString(args.status));
  const verificationStatus = mapVerificationStatus(
    nonEmptyString(args.verification_status)
  );

  // ---------------------------------------------------------------- evidence
  const mapped = mapEvidence(evidence, issuedAt, warnings);
  const evidenceEntries = mapped.entries;
  if (evidenceEntries.length === 0) {
    // AWR requires at least one evidence item. When the agent supplied no
    // mappable evidence, record an explicit producer attestation rather than
    // fabricating a verifiable reference.
    evidenceEntries.push({
      id: 'evidence-1',
      kind: 'producer_attestation',
      summary: longString(`Producer-reported: ${summary}`),
      observed_at: issuedAt,
    });
  }
  const evidenceIds = evidenceEntries.map((entry) => entry.id);

  // ------------------------------------------------------------------- actor
  const actorId = agentType ?? sourceClient ?? 'orgx-mcp-agent';
  const actor: JsonRecord = {
    type: 'agent',
    id: shortString(actorId),
    ...(sourceClient
      ? { runtime: { name: shortString(sourceClient) } }
      : {}),
  };

  // --------------------------------------------------------------- authority
  const maxCostUsd =
    typeof args.max_cost_usd === 'number' &&
    Number.isFinite(args.max_cost_usd) &&
    args.max_cost_usd >= 0
      ? args.max_cost_usd
      : null;
  const authority: JsonRecord = {
    // The MCP worker relays the receipt; it cannot attest to the authority
    // under which the work ran, so it reports 'unknown' rather than claiming
    // a grant it did not observe.
    mode: 'unknown',
    status: 'unknown',
    scope: {
      actions: [],
      resources: [],
      ...(maxCostUsd !== null
        ? { spend_limit: { currency: 'USD', amount: maxCostUsd } }
        : {}),
    },
  };

  // ----------------------------------------------------------------- actions
  const action: JsonRecord = {
    id: 'action-1',
    type: shortString(receiptType),
    summary: longString(summary),
    status: statuses.action,
    ...(startedAt !== issuedAt ? { started_at: startedAt } : {}),
    ...(statuses.action !== 'running' ? { completed_at: issuedAt } : {}),
  };

  // --------------------------------------------------------------- artifacts
  const artifacts: JsonRecord[] = [];
  if (artifactId) {
    artifacts.push({
      id: shortString(artifactId),
      kind: shortString(artifactType ?? 'artifact'),
      name: shortString(artifactType ?? `OrgX artifact ${artifactId}`),
      ref: { system: 'orgx', type: 'artifact', id: shortString(artifactId) },
      role: 'output',
    });
  }

  // ----------------------------------------------------------------- outcome
  const outcome: JsonRecord = {
    status: statuses.outcome,
    summary: longString(summary),
    ...(mapped.metrics.length > 0 ? { metrics: mapped.metrics } : {}),
  };

  // ------------------------------------------------------------ verification
  const verification: JsonRecord =
    verificationStatus === 'unverified'
      ? {
          status: 'unverified',
          method: 'none',
          checks: [],
          evidence_ids: [],
        }
      : {
          status: verificationStatus,
          // The worker relays the producer's claim; it did not re-run checks.
          method: 'producer_reported',
          verifier: { type: 'agent', id: shortString(actorId) },
          checks: [
            {
              id: 'check-1',
              name: 'producer_reported_verification',
              status: verificationStatus as CheckStatus,
              evidence_ids: evidenceIds,
            },
          ],
          evidence_ids: evidenceIds,
          verified_at: issuedAt,
        };

  // ------------------------------------------------------------------ lineage
  const references: JsonRecord[] = [];
  if (entityType && entityId) {
    references.push({
      relationship: 'attests_to',
      ref: {
        system: 'orgx',
        type: shortString(entityType),
        id: shortString(entityId),
      },
    });
  }
  const lineage: JsonRecord = {
    parent_receipt_refs: [],
    references,
  };

  // -------------------------------------------------------------- extensions
  // Preserve the complete tool input (minus the _context runtime envelope) so
  // the migration to the portable schema never drops a field the legacy path
  // accepted. The v1 route stores the full receipt JSON verbatim.
  const { _context: _ignoredContext, ...submittedFields } = args;
  const extensions: JsonRecord = {
    [SUBMIT_RECEIPT_EXTENSION_KEY]: {
      tool: 'orgx_submit_receipt',
      submitted_fields: submittedFields as JsonRecord,
      ...(sourceClient ? { source_client: sourceClient } : {}),
    },
  };

  const receipt: JsonRecord = {
    schema_version: AGENT_WORK_RECEIPT_SCHEMA_VERSION,
    receipt_id: shortString(receiptId),
    intent: {
      summary: longString(summary),
      ...(businessOutcome ? { objective: longString(businessOutcome) } : {}),
      metadata: { receipt_type: receiptType },
    },
    actor,
    authority,
    actions: [action],
    artifacts,
    evidence: evidenceEntries,
    outcome,
    verification,
    cost: {
      // The tool input carries no actual cost figure. Total 0 with
      // estimated:true plus explicit metadata keeps the required field
      // truthful instead of implying a measured zero-cost run.
      currency: 'USD',
      total: 0,
      estimated: true,
      metadata: { reported: false },
    },
    lineage,
    human_interventions: [],
    timestamps: {
      started_at: startedAt,
      completed_at: issuedAt,
      issued_at: issuedAt,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    },
    extensions,
  };

  return {
    body: {
      workspace_id: options.workspaceId,
      receipt,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    },
    warnings,
  };
}

/**
 * Statuses on which the worker retries the legacy /api/flywheel/receipts
 * path: 404 (older self-hosted target without the v1 route) and 401 (target
 * that does not accept the worker's credentials on the v1 namespace).
 */
export function shouldFallBackToLegacyReceipts(
  statusCode: number | undefined
): boolean {
  return statusCode === 404 || statusCode === 401;
}
