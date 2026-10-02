/**
 * The proof a receipt claims, as the proof-receipt widget draws it.
 *
 * orgx_submit_receipt forwards the submitted receipt to the API, whose
 * response names only the stored record (receipt_id, hash, timestamps). The
 * widget needs what was claimed to show the proof, the gap and the next move
 * (canvas Q5), so the worker echoes a bounded projection of the submitted
 * input: the anchor, the stated outcome, and the evidence as typed rows.
 *
 * Nothing here is inferred. Every value is the caller's own input, clipped;
 * URLs are kept only when they parse as http(s), and the evidence list is
 * capped with the true total beside it.
 */

export const RECEIPT_PROOF_EVIDENCE_LIMIT = 12;

const LABEL_MAX = 160;
const NOTE_MAX = 280;

export type ReceiptProofEvidenceKind =
  | 'pr'
  | 'deploy'
  | 'test_run'
  | 'metric'
  | 'link'
  | 'note';

export interface ReceiptProofEvidence {
  kind: ReceiptProofEvidenceKind;
  label: string;
  url: string | null;
  value: string | null;
}

export interface ReceiptProof {
  receipt_type: string | null;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  anchor: {
    entity_type: string | null;
    entity_id: string | null;
    artifact_id: string | null;
  };
  artifact_type: string | null;
  agent_type: string | null;
  business_outcome: string | null;
  model_tier: string | null;
  evidence: ReceiptProofEvidence[];
  evidence_total: number;
}

type JsonRecord = Record<string, unknown>;

function text(value: unknown, max = LABEL_MAX): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function urlList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.map(httpUrl).filter((url): url is string => url !== null);
}

/** "github.com/acme/checkout/pull/2291" → "PR 2291 · acme/checkout". */
function prLabel(url: string): string {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:pull|merge_requests|pulls)\/(\d+)/);
  return match ? `PR ${match[3]} · ${match[1]}/${match[2]}` : linkLabel(url);
}

/** Host and the last path segment, without the scheme. */
function linkLabel(url: string): string {
  const parsed = new URL(url);
  const tail = parsed.pathname.split('/').filter(Boolean).slice(-2).join('/');
  return text(tail ? `${parsed.host}/${tail}` : parsed.host) ?? parsed.host;
}

function metricValue(metric: JsonRecord): string | null {
  const raw = metric.value;
  const value =
    typeof raw === 'number' && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === 'string' && raw.trim()
      ? raw.trim()
      : null;
  if (value === null) return null;
  const unit = text(metric.unit, 24);
  return text(unit ? `${value} ${unit}` : value, 48);
}

function readEvidence(evidence: unknown): ReceiptProofEvidence[] {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const record = evidence as JsonRecord;
  const rows: ReceiptProofEvidence[] = [];
  for (const url of urlList(record.prs)) {
    rows.push({ kind: 'pr', label: prLabel(url), url, value: null });
  }
  for (const url of urlList(record.deploys)) {
    rows.push({ kind: 'deploy', label: `Deploy · ${linkLabel(url)}`, url, value: null });
  }
  for (const url of urlList(record.test_runs)) {
    rows.push({ kind: 'test_run', label: `Test run · ${linkLabel(url)}`, url, value: null });
  }
  if (Array.isArray(record.metrics)) {
    for (const item of record.metrics) {
      if (!item || typeof item !== 'object') continue;
      const metric = item as JsonRecord;
      const name = text(metric.name);
      if (!name) continue;
      rows.push({ kind: 'metric', label: name, url: null, value: metricValue(metric) });
    }
  }
  for (const url of urlList(record.links)) {
    rows.push({ kind: 'link', label: linkLabel(url), url, value: null });
  }
  const notes = text(record.notes, NOTE_MAX);
  if (notes) rows.push({ kind: 'note', label: notes, url: null, value: null });
  return rows;
}

const RECEIPT_STATUSES = new Set(['in_progress', 'completed', 'failed', 'cancelled']);

export function buildReceiptProof(args: JsonRecord): ReceiptProof {
  const evidence = readEvidence(args.evidence);
  const status = typeof args.status === 'string' && RECEIPT_STATUSES.has(args.status)
    ? (args.status as ReceiptProof['status'])
    : 'completed';
  return {
    receipt_type: text(args.receipt_type, 64),
    status,
    anchor: {
      entity_type: text(args.entity_type, 32),
      entity_id: text(args.entity_id, 64),
      artifact_id: text(args.artifact_id, 64),
    },
    artifact_type: text(args.artifact_type, 64),
    agent_type: text(args.agent_type, 64),
    business_outcome: text(args.business_outcome, NOTE_MAX),
    model_tier: text(args.model_tier, 32),
    evidence: evidence.slice(0, RECEIPT_PROOF_EVIDENCE_LIMIT),
    evidence_total: evidence.length,
  };
}
