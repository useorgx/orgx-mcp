import { z } from 'zod';

const lensSchema = z.object({ status: z.string().nullable(), note: z.string().nullable(), evidence_ids: z.array(z.string()) });
export const receiptReviewProjectionSchema = z.object({
  present: z.boolean(), basis: z.literal('producer_reported'), domain: z.string().nullable(),
  criteria_total: z.number(), episodes_total: z.number(), sources_total: z.number(),
  sources: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), href: z.string().nullable() })),
  criteria: z.array(z.object({
    criterion_id: z.string(), source_check: z.string().nullable(),
    source_refs: z.array(z.object({ source_id: z.string(), quote: z.string().nullable(), href: z.string().nullable() })),
    lenses: z.object({ judged: lensSchema, measured: lensSchema, observed: lensSchema, outcome: lensSchema }),
  })),
  episodes: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string(), criterion_ids: z.array(z.string()), evidence_ids: z.array(z.string()), commit_sha: z.string().nullable() })),
});

const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown, max = 512): string | null => typeof v === 'string' ? v.slice(0, max) : null;
const ids = (v: unknown): string[] => arr(v).filter((id): id is string => typeof id === 'string').slice(0, 20);
function lens(value: unknown) {
  const entry = rec(value);
  return { status: text(entry.status), note: text(entry.note, 1000), evidence_ids: ids(entry.evidence_ids) };
}

/** A bounded reviewer packet, retaining criterion sources and all four proof lenses. */
export function projectReceiptReviewExtension(value: unknown) {
  const review = rec(value);
  const sources = arr(review.sources), criteria = arr(review.criteria), episodes = arr(review.episodes);
  return {
    present: Object.keys(review).length > 0, basis: 'producer_reported' as const, domain: text(review.domain),
    criteria_total: criteria.length, episodes_total: episodes.length, sources_total: sources.length,
    sources: sources.slice(0, 20).map((value) => { const s = rec(value); return { id: text(s.id) ?? '', type: text(s.type) ?? '', title: text(s.title) ?? '', href: text(s.href, 2048) }; }),
    criteria: criteria.slice(0, 20).map((value) => {
      const c = rec(value), lenses = rec(c.lenses);
      return { criterion_id: text(c.criterion_id) ?? '', source_check: text(c.source_check), source_refs: arr(c.source_refs).slice(0, 5).map((value) => { const s = rec(value); return { source_id: text(s.source_id) ?? '', quote: text(s.quote, 1000), href: text(s.href, 2048) }; }), lenses: { judged: lens(lenses.judged), measured: lens(lenses.measured), observed: lens(lenses.observed), outcome: lens(lenses.outcome) } };
    }),
    episodes: episodes.slice(0, 20).map((value) => { const e = rec(value); return { id: text(e.id) ?? '', kind: text(e.kind) ?? '', title: text(e.title) ?? '', criterion_ids: ids(e.criterion_ids), evidence_ids: ids(e.evidence_ids), commit_sha: text(rec(e.commit).sha) }; }),
  };
}
