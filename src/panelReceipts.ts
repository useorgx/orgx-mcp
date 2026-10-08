/**
 * The OrgX panel's receipts: the work agents did, as the Work Ledger records
 * it (Agent Work Receipts), with each acceptance criterion's verdict.
 *
 * Read through the ledger API the model already uses (orgx_search
 * scope=work_ledger): GET /api/v1/work-ledger/receipts?q= for a range or a
 * filter (pr:3236), and /receipts/{id} for one receipt in full. This module
 * only shapes those payloads for the panel; it never invents a verdict. A
 * criterion the ledger has no evidence for stays "unknown", and the ledger's
 * own list of what is uncertain is passed through as written.
 */

import { normalizeExpectationSource, type ExpectationSource } from './expectations';

export const PANEL_RECEIPT_LIMIT = 50;
export const PANEL_RECEIPT_CRITERIA_MAX = 40;

export type PanelCriterionStatus = 'met' | 'unmet' | 'unknown';

export interface PanelReceiptRow {
  id: string;
  at: string | null;
  actor: string | null;
  summary: string;
  /** succeeded | partially_succeeded | failed | blocked | … as the ledger says. */
  outcome: string | null;
  /** verified | unverified | … as the ledger says. */
  verification: string | null;
  /** accepted | rejected | pending, or null when no one has ruled. */
  accepted: string | null;
  work_type: string | null;
  area: string | null;
  entity_title: string | null;
  criteria: { met: number; unmet: number; unknown: number };
  prs: string[];
  /** The ledger's least-sure confidence across outcome, criteria and type. */
  confidence: number | null;
}

export interface PanelReceipts {
  status: 'ok' | 'unavailable';
  /** The query sent to the ledger: a range filter or a lookup like pr:3236. */
  query: string;
  total: number;
  items: PanelReceiptRow[];
  /** Why the read failed, in the panel's words; null when it did not. */
  reason: string | null;
}

export interface PanelReceiptCriterion {
  id: string;
  text: string;
  kind: string | null;
  status: PanelCriterionStatus;
  confidence: number | null;
  /** Where the check came from (your rule, the kind of work, a learned call…), when the ledger says. */
  source?: ExpectationSource | null;
  /** For a learned check: the call that produced it, in words, when the API names it. */
  source_label?: string | null;
}

/** The agreed bar a receipt was judged against. */
export interface PanelReceiptBar {
  agreed_at: string | null;
  agreed_by: string | null;
}

export interface PanelReceiptArtifact {
  kind: string;
  name: string;
  /** A link when the artifact is a URL or a GitHub PR; otherwise null. */
  url: string | null;
}

export interface PanelReceiptDetail {
  status: 'ok' | 'unavailable';
  id: string;
  row: PanelReceiptRow | null;
  objective: string | null;
  outcome_summary: string | null;
  criteria: PanelReceiptCriterion[];
  artifacts: PanelReceiptArtifact[];
  /** The ledger's own list of what is still uncertain about this receipt. */
  uncertain: string[];
  workstream_title: string | null;
  cost_usd: number | null;
  completed_at: string | null;
  reason: string | null;
  /** The bar this receipt was judged against, when the ledger names an agreement. */
  bar?: PanelReceiptBar | null;
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const TRAIL_EXT = 'org.orgx.trail/v1';

/** The ledger query for a range: receipts that started on or after its first day. */
export function receiptRangeQuery(range: 'today' | '7d' | '30d', now: Date = new Date()): string {
  const days = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  return `since:${start.toISOString().slice(0, 10)}`;
}

/** One ledger row (rowOf in the app) shaped for the panel. */
export function panelReceiptRow(raw: unknown): PanelReceiptRow | null {
  const r = asRec(raw);
  const id = str(r?.externalId) ?? str(r?.id);
  const summary = str(r?.summary);
  if (!r || !id || !summary) return null;
  const crit = asRec(r.criteria);
  const entity = asRec(r.entity);
  return {
    id,
    at: str(r.at),
    actor: str(r.actor),
    summary: clip(summary, 280),
    outcome: str(r.outcome),
    verification: str(r.verification),
    accepted: str(r.accepted),
    work_type: str(r.workType),
    area: str(r.area),
    entity_title: str(entity?.title),
    criteria: { met: count(crit?.met), unmet: count(crit?.unmet), unknown: count(crit?.unknown) },
    prs: Array.isArray(r.prs) ? r.prs.map(str).filter((x): x is string => Boolean(x)).slice(0, 6) : [],
    confidence: num(r.confidence),
  };
}

/** GET /api/v1/work-ledger/receipts payload → the panel's list, or unavailable. */
export function buildPanelReceipts(payload: unknown, query: string, reason: string | null = null): PanelReceipts {
  const p = asRec(payload);
  const data = asRec(p?.data) ?? p;
  const results = Array.isArray(data?.results) ? data.results : null;
  if (!results) return { status: 'unavailable', query, total: 0, items: [], reason: reason ?? 'The Work Ledger did not answer.' };
  const items = results.map(panelReceiptRow).filter((x): x is PanelReceiptRow => Boolean(x)).slice(0, PANEL_RECEIPT_LIMIT);
  return { status: 'ok', query, total: count(data?.total) || items.length, items, reason: null };
}

function criterionStatus(value: unknown): PanelCriterionStatus {
  const s = String(value ?? '').toLowerCase();
  return s === 'met' || s === 'passed' || s === 'pass' ? 'met' : s === 'unmet' || s === 'failed' || s === 'fail' ? 'unmet' : 'unknown';
}

/** Declared criteria with their results (v0.2 core fields), else the trail extension: the app's criteriaOf. */
function criteriaOfReceipt(receipt: Rec): PanelReceiptCriterion[] {
  const intent = asRec(receipt.intent);
  const outcome = asRec(receipt.outcome);
  const declared = Array.isArray(intent?.criteria) ? intent.criteria : [];
  if (declared.length) {
    const results = new Map<string, Rec>();
    for (const x of Array.isArray(outcome?.criteria_results) ? outcome.criteria_results : []) {
      const rec = asRec(x);
      const cid = str(rec?.criterion_id);
      if (rec && cid) results.set(cid, rec);
    }
    return declared.flatMap((c) => {
      const rec = asRec(c);
      const id = str(rec?.id);
      const text = str(rec?.text);
      if (!id || !text) return [];
      const result = results.get(id);
      return [{ id, text: clip(text, 400), kind: str(rec?.kind), status: criterionStatus(result?.status), confidence: num(result?.confidence), ...criterionSource(rec!) }];
    });
  }
  const ext = asRec(asRec(receipt.extensions)?.[TRAIL_EXT]);
  return (Array.isArray(ext?.criteria) ? ext.criteria : []).flatMap((c) => {
    const rec = asRec(c);
    const id = str(rec?.id);
    const text = str(rec?.text);
    if (!id || !text) return [];
    return [{ id, text: clip(text, 400), kind: str(rec?.kind), status: criterionStatus(rec?.status), confidence: num(rec?.confidence), ...criterionSource(rec!) }];
  });
}

/**
 * A criterion's source and, for a learned one, the call behind it. Only what
 * the ledger wrote: no source means no chip, and a learned check without a
 * named call says "learned" and nothing more.
 */
function criterionSource(rec: Rec): { source?: ExpectationSource; source_label?: string } {
  const source = normalizeExpectationSource(rec.source ?? rec.source_kind);
  if (!source) return {};
  const from = asRec(rec.learned_from);
  const label =
    str(rec.source_label) ??
    str(from?.label) ??
    str(from?.title) ??
    (str(from?.pr) ? `#${String(from!.pr).replace(/^#/, '')}` : null);
  return label && source === 'learned' ? { source, source_label: clip(label, 120) } : { source };
}

/** The agreement a receipt's criteria came from: intent.expectations, intent.agreement, or the receipt's extension. */
function barOf(receipt: Rec, intent: Rec | null): PanelReceiptBar | null {
  const ext = asRec(asRec(receipt.extensions)?.['org.orgx.expectations/v1']);
  for (const candidate of [asRec(intent?.expectations), asRec(intent?.expectation_set), asRec(intent?.agreement), ext]) {
    const agreedAt = str(candidate?.agreed_at);
    if (agreedAt) return { agreed_at: agreedAt, agreed_by: str(candidate?.agreed_by) };
  }
  const agreedAt = str(intent?.agreed_at);
  return agreedAt ? { agreed_at: agreedAt, agreed_by: str(intent?.agreed_by) } : null;
}

function artifactUrl(kind: string, ref: Rec | null): string | null {
  const id = str(ref?.id);
  if (!id) return null;
  if (/^https?:\/\//i.test(id)) return id;
  const meta = asRec(ref?.metadata);
  const url = str(meta?.url) ?? str(meta?.html_url);
  if (url && /^https?:\/\//i.test(url)) return url;
  // "owner/repo#123" is how trail import names a GitHub pull request.
  const pr = kind === 'pull_request' ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id) : null;
  return pr ? `https://github.com/${pr[1]}/pull/${pr[2]}` : null;
}

/** GET /api/v1/work-ledger/receipts/{id} payload → the panel's receipt, or unavailable. */
export function buildPanelReceiptDetail(payload: unknown, id: string, reason: string | null = null): PanelReceiptDetail {
  const p = asRec(payload);
  const data = asRec(p?.data) ?? p;
  const receipt = asRec(data?.receipt);
  const empty: PanelReceiptDetail = {
    status: 'unavailable', id, row: null, objective: null, outcome_summary: null, criteria: [], artifacts: [],
    uncertain: [], workstream_title: null, cost_usd: null, completed_at: null, reason: reason ?? 'The Work Ledger did not return this receipt.',
  };
  if (!receipt) return empty;
  const intent = asRec(receipt.intent);
  const outcome = asRec(receipt.outcome);
  const artifacts = (Array.isArray(receipt.artifacts) ? receipt.artifacts : []).flatMap((a) => {
    const rec = asRec(a);
    const kind = str(rec?.kind) ?? 'artifact';
    const ref = asRec(rec?.ref);
    const name = str(rec?.name) ?? str(ref?.id);
    return name ? [{ kind, name: clip(name, 160), url: artifactUrl(kind, ref) }] : [];
  }).slice(0, 20);
  const timestamps = asRec(receipt.timestamps);
  return {
    status: 'ok',
    id: str(receipt.receipt_id) ?? id,
    row: panelReceiptRow(data?.row),
    objective: str(intent?.objective),
    outcome_summary: str(outcome?.summary) ? clip(String(outcome!.summary), 600) : null,
    criteria: criteriaOfReceipt(receipt).slice(0, PANEL_RECEIPT_CRITERIA_MAX),
    artifacts,
    uncertain: (Array.isArray(data?.uncertain) ? data.uncertain : []).map(str).filter((x): x is string => Boolean(x)).slice(0, 10).map((x) => clip(x, 240)),
    workstream_title: str(asRec(data?.workstream)?.title),
    cost_usd: num(asRec(receipt.cost)?.total),
    completed_at: str(timestamps?.completed_at),
    reason: null,
    bar: barOf(receipt, intent),
  };
}

/** A failed ledger read in the panel's words: the status and the API's message, never a stack. */
export function ledgerFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const code = (error as { status?: unknown } | null)?.status;
  const status = typeof code === 'number' ? String(code) : /\b(4\d\d|5\d\d)\b/.exec(message)?.[1];
  if (status === '401' || status === '403') return 'The Work Ledger needs you signed in to this workspace.';
  if (status === '404') return 'The Work Ledger has nothing for this yet.';
  if (/abort|timeout|timed out/i.test(message)) return 'The Work Ledger took too long to answer.';
  return status ? `The Work Ledger answered ${status}.` : 'The Work Ledger could not be reached.';
}
