import type { ReceiptProof, ReceiptProofEvidenceKind } from './receiptProof';

const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown, max = 280): string | null => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
function url(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try { const parsed = new URL(v); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.toString() : null; } catch { return null; }
}
const kinds: Record<string, ReceiptProofEvidenceKind> = { pr: 'pr', pull_request: 'pr', deploy: 'deploy', deployment: 'deploy', test_run: 'test_run', metric: 'metric', link: 'link' };

/** A producer proof echo for the existing card, never an OrgX verification verdict. */
export function buildPortableReceiptProof(receipt: Record<string, unknown>): ReceiptProof {
  const intent = rec(receipt.intent), outcome = rec(receipt.outcome), actor = rec(receipt.actor);
  const refs = arr(rec(receipt.lineage).references).map((value) => rec(rec(value).ref)).filter((ref) => /orgx/i.test(String(ref.system)));
  const work = refs.find((ref) => ['initiative', 'workstream', 'milestone', 'task'].includes(String(ref.type)));
  const artifact = arr(receipt.artifacts).map(rec).find((a) => /orgx/i.test(String(rec(a.ref).system)) && rec(a.ref).type === 'artifact');
  const evidence = arr(receipt.evidence);
  const status: ReceiptProof['status'] = outcome.status === 'cancelled' ? 'cancelled' : ['failed', 'blocked'].includes(String(outcome.status)) ? 'failed' : ['succeeded', 'partially_succeeded'].includes(String(outcome.status)) ? 'completed' : 'in_progress';
  return {
    receipt_type: text(rec(intent.metadata).receipt_type, 64) ?? 'proof', status,
    anchor: { entity_type: text(work?.type, 32), entity_id: text(work?.id, 512), artifact_id: text(rec(artifact?.ref).id, 512) },
    artifact_type: text(artifact?.kind, 64), agent_type: text(actor.display_name ?? actor.id, 64),
    business_outcome: text(intent.objective), model_tier: null,
    evidence: evidence.slice(0, 12).map((value) => { const entry = rec(value); return { kind: kinds[String(entry.kind)] ?? 'note', label: text(entry.summary) ?? String(entry.id ?? 'Evidence'), url: url(rec(entry.ref).uri), value: null }; }),
    evidence_total: evidence.length,
  };
}
