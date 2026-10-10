import { z } from 'zod';

import type { ToolSecuritySchemes } from './contractTools';
import { portableReceiptInput } from './portableReceiptInput';
import { SECURITY_SCHEMES } from './toolDefinitions';
import { projectReceiptReviewExtension, receiptReviewProjectionSchema } from './receiptReviewProjection';
import { buildPortableReceiptProof } from './portableReceiptProof';
import { toolCallSchema } from './openaiOutputSchemas/shared';
import { workLedgerOutputShape, workLedgerQuerySchema } from './openaiOutputSchemas/workLedger';

const workspace = z.string().uuid().optional().describe('Workspace UUID. Defaults to the authenticated workspace.');
const limit = z.number().int().min(1).max(100).default(25);
const reviewKind = z.enum(['mapping', 'area', 'link', 'work_type', 'outcome', 'criterion']);
const claimsSchema = z.object({
  outcome_status: z.string().nullable(),
  verification_status: z.string().nullable(),
  acceptance_status: z.string().nullable(),
});
export const RECEIPT_ASSESSMENT_SCHEMA = z.object({
  evidence_status: z.enum(['recorded', 'none']),
  verification_status: z.literal('producer_reported'),
  acceptance_status: z.enum(['human_reviewed', 'awaiting_human_review']),
  outcome_status: z.string().nullable(),
});
const humanJudgmentSchema = z.object({
  outcome_status: z.string(), actor_id: z.string(), decided_at: z.string(),
  scope: z.enum(['receipt_document', 'legacy_receipt_identifier']).optional(),
  reviewed_receipt_id: z.string().nullable().optional(),
  reviewed_receipt_revision: z.string().nullable().optional(),
}).nullable();
const criterionLensSchema = z.object({ status: z.string().max(120).nullable(), note: z.string().max(1000).nullable() });
const detailCriterionSchema = z.object({
  id: z.string(), text: z.string(), status: z.string(), evidence_ids: z.array(z.string()),
  basis: z.literal('producer_reported'), confidence: z.number().min(0).max(1).nullable(),
  kind: z.string().max(120).nullable(), required: z.boolean().nullable(),
  source: z.string().max(120).nullable(), source_ref: z.string().max(512).nullable(), source_label: z.string().max(512).nullable(),
  review_state: z.string().max(120).nullable(),
  lenses: z.object({ judged: criterionLensSchema, measured: criterionLensSchema, observed: criterionLensSchema, outcome: criterionLensSchema }).nullable(),
});
const reportedBarSchema = z.object({
  basis: z.literal('producer_reported'), set_id: z.string().max(512).nullable(), version: z.number().int().positive().safe().nullable(),
  agreed_at: z.string().max(256).nullable(), agreed_by: z.string().max(512).nullable(),
  contract_hash: z.string().max(512).nullable(), declared_at: z.string().max(256).nullable(),
}).nullable();
const effectsSchema = z.object({
  receipt_stored: z.boolean(), work_status_changed: z.literal(false),
  authoritative_verification_changed: z.literal(false), human_acceptance_changed: z.literal(false),
});
const proofSchema = z.object({
  receipt_type: z.string().nullable(), status: z.enum(['in_progress', 'completed', 'failed', 'cancelled']),
  anchor: z.object({ entity_type: z.string().nullable(), entity_id: z.string().nullable(), artifact_id: z.string().nullable() }),
  artifact_type: z.string().nullable(), agent_type: z.string().nullable(), business_outcome: z.string().nullable(), model_tier: z.string().nullable(),
  evidence: z.array(z.object({ kind: z.enum(['pr', 'deploy', 'test_run', 'metric', 'link', 'note']), label: z.string(), url: z.string().nullable(), value: z.string().nullable() })), evidence_total: z.number(),
});
const receiptSummarySchema = z.object({
  receipt_id: z.string(), external_receipt_id: z.string(), summary: z.string(),
  receipt_review_revision: z.string().nullable().optional(),
  schema_version: z.string().nullable(), producer_claims: claimsSchema,
  receipt_assessment: RECEIPT_ASSESSMENT_SCHEMA, human_judgment: humanJudgmentSchema,
  criteria: z.object({ met: z.number(), unmet: z.number(), unknown: z.number() }),
}).passthrough();

export const RECEIPT_OPERATION_OUTPUT_SCHEMAS = {
  orgx_submit_work_receipt: z.object({
    ok: z.literal(true), receipt_id: z.string(), external_receipt_id: z.string(), schema_version: z.string(),
    idempotent: z.boolean(), producer_claims: claimsSchema, effects: effectsSchema,
    receipt_assessment: RECEIPT_ASSESSMENT_SCHEMA, summary: z.string(), proof: proofSchema,
    imported_at: z.string().optional(), pilot: z.object({ cohort_id: z.string(), partner_ref: z.string().optional() }).nullable().optional(),
  }).passthrough(),
  orgx_validate_work_receipt: z.object({
    ok: z.boolean(), valid: z.boolean(), schema_version: z.string().optional(),
    schema_url: z.string().optional(), issues: z.array(z.object({ path: z.string(), message: z.string() }).passthrough()).optional(),
    issue_count: z.number().optional(), issues_truncated: z.boolean().optional(),
    persistence: z.object({ stored: z.literal(false), import_requires_authentication: z.literal(true) }).optional(),
    receipt: z.object({ receipt_id: z.string(), actor_id: z.string(), runtime: z.string().nullable(), producer_reported_outcome_status: z.string(), producer_reported_verification_status: z.string(), evidence_count: z.number(), human_intervention_count: z.number() }).optional(),
  }).passthrough(),
  orgx_get_work_receipt: z.object({
    ok: z.literal(true), receipt_id: z.string(), external_receipt_id: z.string(), schema_version: z.string().nullable(),
    receipt_review_revision: z.string().nullable().optional(),
    summary: z.string(), producer_claims: claimsSchema, receipt_assessment: RECEIPT_ASSESSMENT_SCHEMA,
    objective: z.string().max(2000).nullable(), outcome_summary: z.string().max(2000).nullable(), reported_bar: reportedBarSchema,
    human_judgment: humanJudgmentSchema,
    evidence: z.array(z.object({ id: z.string(), kind: z.string(), summary: z.string(), uri: z.string().nullable() })),
    evidence_total: z.number(), criteria: z.array(detailCriterionSchema),
    criteria_total: z.number(), review_extension: receiptReviewProjectionSchema,
    proof: proofSchema,
    workstream: z.object({ id: z.string(), title: z.string(), status: z.string().nullable(), repo: z.string().nullable() }).nullable(),
    mappings: z.array(z.object({ entity_id: z.string().nullable(), entity_type: z.string().nullable(), entity_title: z.string().nullable(), status: z.string().nullable(), confidence: z.number().nullable() })),
    links: z.array(z.object({ from: z.string(), to: z.string(), relationship: z.string(), confidence: z.number().nullable() })),
    uncertain: z.array(z.string()),
  }).passthrough(),
  orgx_list_work_receipts: z.object({
    ok: z.literal(true), total: z.number(), view: z.enum(['receipts', 'workstreams', 'review']).optional(),
    results: z.array(receiptSummarySchema).optional(), window_days: z.number().optional(),
    query: workLedgerQuerySchema.optional(), receipts: z.number().optional(),
    workstreams: workLedgerOutputShape.workstreams.optional(),
    items: workLedgerOutputShape.items.optional(), criteria_proposals: workLedgerOutputShape.criteria_proposals.optional(),
    queue_limit: z.number().optional(), queue_truncated: z.boolean().optional(),
    next_calls: z.array(toolCallSchema).optional(),
  }).strict(),
  orgx_get_receipt_review_queue: z.object({
    ok: z.literal(true), total: z.number(), items: z.array(z.object({
      kind: reviewKind, subject: z.string(), question: z.string(), summary: z.string(), confidence: z.number(),
    }).passthrough()), criteria_proposals: z.array(z.object({ id: z.string() }).passthrough()),
    queue_limit: z.number().optional(), queue_truncated: z.boolean().optional(), window_days: z.number().optional(),
  }).passthrough(),
} as const;

export type ReceiptOperationId = keyof typeof RECEIPT_OPERATION_OUTPUT_SCHEMAS;
export interface ReceiptOperationTool {
  id: ReceiptOperationId;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint: boolean };
  securitySchemes: ToolSecuritySchemes;
}
const reads = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
export const RECEIPT_OPERATION_TOOLS: readonly ReceiptOperationTool[] = [
  {
    id: 'orgx_submit_work_receipt', title: 'Submit OrgX Work Receipt',
    description: 'Import one portable Agent Work Receipt v0.1 or v0.2 into the authenticated workspace ledger. Preserves the full document, including identified criteria, evidence, provenance, lineage and review extensions. Producer outcome, verification and acceptance are claims; import does not verify, accept or complete work. The canonical import enforces document limits, reserved harness names, workspace quota and content-bound idempotency. Never falls back to a legacy write after rejection.',
    inputSchema: { workspace_id: workspace, receipt: portableReceiptInput.describe('Complete portable Agent Work Receipt. Use v0.2 for identified criteria and evidence-linked results. Standard metadata and namespaced extensions carry producer data, never executable commands.'), idempotency_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/).optional().describe('Retry key bound to this document. Omit to use its content hash.') },
    annotations: { ...reads, readOnlyHint: false }, securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
  },
  {
    id: 'orgx_validate_work_receipt', title: 'Validate OrgX Work Receipt',
    description: 'Check one portable Agent Work Receipt v0.1 or v0.2 for schema and reference conformance without storing it. Checks identified criteria, evidence references and known review extensions. Conformance validates the document, not whether its evidence is true or whether work was accepted. Import separately enforces hosted compatibility and admission policy.',
    inputSchema: { receipt: portableReceiptInput }, annotations: reads, securitySchemes: [{ type: 'noauth' }],
  },
  {
    id: 'orgx_get_work_receipt', title: 'Get OrgX Work Receipt',
    description: 'Read a receipt by its ledger UUID or opaque producer receipt ID in one workspace. Returns bounded evidence and criteria, producer claims, the separately recorded human outcome, related workstream and uncertainty. Reading cannot verify or accept work. The full document remains in OrgX.',
    inputSchema: { workspace_id: workspace, receipt_id: z.string().trim().min(1).max(512) }, annotations: reads, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
  },
  {
    id: 'orgx_list_work_receipts', title: 'List OrgX Work Receipts',
    description: 'Read one bounded workspace ledger view: receipts (default), workstreams, or review. Receipt search accepts free text and exact filters: outcome, verification, accepted, type, area, repo, actor, ws, entity, initiative, pr, file, since, until, conf, unmet and status, within the 120-day window. Workstreams retain receipt rollups and confirmed mappings; review returns pending human calls and criterion proposals. Results distinguish producer claims from human judgments. Follow validated next_calls; no view resolves judgments, runs model inference, or changes work.',
    inputSchema: { workspace_id: workspace, view: z.enum(['receipts', 'workstreams', 'review']).default('receipts').describe('Read-only ledger projection. Existing calls default to receipt search.'),
      query: z.string().max(2000).default(''), kind: reviewKind.optional().describe('Optional review kind, valid only with view=review.'), limit }, annotations: reads, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
  },
  {
    id: 'orgx_get_receipt_review_queue', title: 'Get OrgX Receipt Review Queue',
    description: 'Read the workspace calls waiting for a person: outcome, work type, entity mapping, area, links and proposed criteria. Results are suggestions with confidence, not verified facts. Human outcome judgments and criterion confirmations are made in the OrgX review UI; this tool cannot resolve them.',
    inputSchema: { workspace_id: workspace, kind: reviewKind.optional(), limit }, annotations: reads, securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
  },
];

export interface ReceiptOperationContext {
  workspaceId: string | null | undefined;
  request: (path: string, init: { method: 'GET' | 'POST'; body?: string }) => Promise<Record<string, unknown>>;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const boundedString = (value: unknown, max: number): string | null => str(value)?.slice(0, max) ?? null;
const confidence = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
const positiveInteger = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const indexedCriteria = (value: unknown): Map<unknown, Record<string, unknown>> => new Map(array(value).map((item) => { const c = record(item); return [c.id, c]; }));
/** Agreement fields in a producer document are context, never authenticated human agreement. */
function reportedBar(receipt: Record<string, unknown>, intent: Record<string, unknown>) {
  const candidates = [
    record(record(receipt.extensions)['org.orgx.expectations/v1']), record(record(intent.metadata).expectations),
    record(intent.expectations), record(intent.expectation_set), record(intent.agreement), intent,
  ];
  const bar = candidates.find((c) => ['set_id', 'version', 'agreed_at', 'agreed_by', 'contract_hash', 'declared_at'].some((key) => key === 'version' ? positiveInteger(c[key]) !== null : str(c[key]) !== null));
  return bar ? {
    basis: 'producer_reported' as const, set_id: boundedString(bar.set_id, 512), version: positiveInteger(bar.version),
    agreed_at: boundedString(bar.agreed_at, 256), agreed_by: boundedString(bar.agreed_by, 512),
    contract_hash: boundedString(bar.contract_hash, 512), declared_at: boundedString(bar.declared_at, 256),
  } : null;
}
export function receiptProducerClaims(receipt: Record<string, unknown>) {
  const outcome = record(receipt.outcome);
  return { outcome_status: str(outcome.status), verification_status: str(record(receipt.verification).status), acceptance_status: str(record(outcome.acceptance).status) };
}
export function projectWorkReceiptDetail(raw: Record<string, unknown>): Record<string, unknown> {
  const data = record(raw.data ?? raw);
  const receipt = record(data.receipt);
  if (!str(receipt.receipt_id) || !str(receipt.schema_version)) throw new Error('OrgX returned an incomplete receipt document.');
  const intent = record(receipt.intent);
  const coreCriteria = array(intent.criteria);
  const trailCriteria = array(record(record(receipt.extensions)['org.orgx.trail/v1']).criteria);
  const criteria = coreCriteria.length ? coreCriteria : trailCriteria.length ? trailCriteria : array(intent.acceptance_criteria).map((text, index) => ({ id: `criterion-${index + 1}`, text }));
  const results = new Map(array(record(receipt.outcome).criteria_results).map((value) => { const r = record(value); return [r.criterion_id, r]; }));
  const expectations = indexedCriteria(record(record(receipt.extensions)['org.orgx.expectations/v1']).criteria);
  const detailCriteria = indexedCriteria(data.criteria);
  const review = record(record(receipt.extensions)['org.orgx.review/v1']);
  const evidence = array(receipt.evidence);
  const workstream = record(data.workstream);
  return {
    ok: true, receipt_id: str(data.receipt_id ?? record(data.row).id) ?? '', external_receipt_id: str(receipt.receipt_id) ?? '',
    receipt_review_revision: str(data.receipt_review_revision),
    schema_version: str(receipt.schema_version), summary: str(record(receipt.intent).summary) ?? '', proof: buildPortableReceiptProof(receipt),
    objective: boundedString(intent.objective, 2000), outcome_summary: boundedString(record(receipt.outcome).summary, 2000),
    reported_bar: reportedBar(receipt, intent),
    producer_claims: receiptProducerClaims(receipt), receipt_assessment: data.receipt_assessment ?? { evidence_status: evidence.length ? 'recorded' : 'none', verification_status: 'producer_reported', acceptance_status: 'awaiting_human_review', outcome_status: null },
    human_judgment: data.human_judgment ?? null,
    evidence: evidence.slice(0, 12).map((value) => { const e = record(value); return { id: str(e.id) ?? '', kind: str(e.kind) ?? '', summary: (str(e.summary) ?? '').slice(0, 2000), uri: str(record(e.ref).uri) }; }),
    evidence_total: evidence.length,
    criteria: criteria.slice(0, 40).map((value) => {
      const c = record(value), r = results.get(c.id), detail = detailCriteria.get(c.id) ?? {}, expectation = expectations.get(c.id) ?? {};
      const source = { ...c, ...expectation }, learnedFrom = record(source.learned_from), lenses = record(detail.lenses);
      const lens = (key: string) => { const l = record(lenses[key]); return { status: boundedString(l.s ?? l.status, 120), note: boundedString(l.note, 1000) }; };
      return {
        id: str(c.id) ?? '', text: (str(c.text) ?? '').slice(0, 2000), status: str(r?.status ?? c.status) ?? 'unknown',
        evidence_ids: array(r?.evidence_ids ?? c.evidence_ids).filter((v): v is string => typeof v === 'string').slice(0, 20),
        basis: 'producer_reported', confidence: confidence(r?.confidence ?? c.confidence ?? detail.confidence),
        kind: boundedString(c.kind ?? detail.kind, 120), required: typeof c.required === 'boolean' ? c.required : typeof detail.required === 'boolean' ? detail.required : null,
        source: boundedString(source.source ?? source.source_kind, 120), source_ref: boundedString(source.source_ref, 512),
        source_label: boundedString(source.source_label ?? learnedFrom.label ?? learnedFrom.title, 512),
        review_state: boundedString(detail.state, 120),
        lenses: Object.keys(lenses).length ? { judged: lens('judged'), measured: lens('measured'), observed: lens('observed'), outcome: lens('outcome') } : null,
      };
    }),
    criteria_total: criteria.length,
    review_extension: projectReceiptReviewExtension(review),
    workstream: str(workstream.id) ? { id: str(workstream.id)!, title: str(workstream.title) ?? '', status: str(workstream.status), repo: str(workstream.repo) } : null,
    mappings: array(data.mappings).slice(0, 10).map((value) => { const m = record(value), entity = record(m.entity); return { entity_id: str(entity.id), entity_type: str(entity.type), entity_title: str(entity.title), status: str(m.status), confidence: typeof m.confidence === 'number' ? m.confidence : null }; }),
    links: array(data.links).slice(0, 20).map((value) => { const link = record(value); return { from: str(link.from) ?? '', to: str(link.to) ?? '', relationship: str(link.relationship) ?? '', confidence: typeof link.confidence === 'number' ? link.confidence : null }; }),
    uncertain: array(data.uncertain).filter((v): v is string => typeof v === 'string').slice(0, 20),
    ...(data._widget_meta ? { _widget_meta: data._widget_meta } : {}),
  };
}

export async function executeReceiptOperation(id: ReceiptOperationId, raw: Record<string, unknown>, context: ReceiptOperationContext): Promise<Record<string, unknown>> {
  const tool = RECEIPT_OPERATION_TOOLS.find((item) => item.id === id);
  if (!tool) throw new Error(`Unknown receipt operation: ${id}`);
  // Strict top-level parsing means callers cannot add an operation selector.
  const args = z.object(tool.inputSchema).strict().parse(raw);
  if (id === 'orgx_validate_work_receipt') return context.request('/api/v1/agent-work-receipts/validate', { method: 'POST', body: JSON.stringify(args.receipt) });
  const workspaceId = workspace.parse(args.workspace_id ?? context.workspaceId ?? undefined);
  if (!workspaceId) throw new Error('Select an authenticated workspace before using the receipt ledger.');
  if (id === 'orgx_submit_work_receipt') {
    const result = await context.request('/api/v1/agent-work-receipts', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, receipt: args.receipt, ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}) }) });
    if (result.ok === false || result.error) return result;
    if (result.ok !== true || !str(result.receipt_id)) throw new Error('OrgX did not confirm receipt admission.');
    const receipt = record(args.receipt);
    return { ...result, summary: str(record(receipt.intent).summary) ?? '', proof: buildPortableReceiptProof(receipt), producer_claims: receiptProducerClaims(receipt), receipt_assessment: { evidence_status: array(receipt.evidence).length ? 'recorded' : 'none', verification_status: 'producer_reported', acceptance_status: 'awaiting_human_review', outcome_status: null }, effects: { receipt_stored: true, work_status_changed: false, authoritative_verification_changed: false, human_acceptance_changed: false } };
  }
  const query = new URLSearchParams({ workspace_id: workspaceId });
  if (id === 'orgx_list_work_receipts') {
    const view = args.view as 'receipts' | 'workstreams' | 'review';
    if ((view === 'review' && args.query) || (view !== 'review' && args.kind)) throw new Error('Ledger text applies to receipts/workstreams; kind applies only to review.');
    query.set('limit', String(args.limit));
    if (view !== 'review') query.set('q', String(args.query));
    if (args.kind) query.set('kind', String(args.kind));
    const result = await context.request(`/api/v1/work-ledger/${view}?${query}`, { method: 'GET' });
    if (result.ok === false || result.error) return result;
    const data = record(result.data ?? result);
    const first = record(array(data.results)[0]);
    const next_calls = view === 'receipts' ? [
      ...(str(first.receipt_id) ? [{ tool: 'orgx_get_work_receipt', args: { workspace_id: workspaceId, receipt_id: first.receipt_id } }] : []),
      { tool: 'orgx_list_work_receipts', args: { workspace_id: workspaceId, view: 'workstreams', limit: args.limit } },
    ] : [{ tool: 'orgx_list_work_receipts', args: { workspace_id: workspaceId, view: view === 'workstreams' ? 'review' : 'receipts', limit: args.limit } }];
    return { ...data, ok: true, view, next_calls };
  }
  let path: string;
  if (id === 'orgx_get_work_receipt') path = `/api/v1/work-ledger/receipts/${encodeURIComponent(String(args.receipt_id))}`;
  else {
    query.set('limit', String(args.limit));
    path = '/api/v1/work-ledger/review';
    if (args.kind) query.set('kind', String(args.kind));
  }
  const result = await context.request(`${path}?${query}`, { method: 'GET' });
  if (result.ok === false || result.error) return result;
  return id === 'orgx_get_work_receipt' ? projectWorkReceiptDetail(result) : { ok: true, ...record(result.data ?? result) };
}
