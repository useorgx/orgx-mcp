import { z } from 'zod';

const sectionSchema = z.object({ total: z.number().int().nonnegative().nullable(), returned: z.number().int().nonnegative(), limit: z.number().int().positive(), truncated: z.boolean().nullable() });
export const receiptReadCoverageSchema = z.object({
  status: z.enum(['partial', 'unknown']), scope: z.literal('returned receipt projection'),
  source_coverage: z.literal('unknown'), sections: z.record(sectionSchema),
  omitted: z.array(z.object({ section: z.string(), count: z.number().int().nonnegative(), reason: z.literal('presentation_limit') })),
  continuation: z.literal('unsupported'),
  clipped_fields: z.array(z.object({ path: z.string(), original_characters: z.number().int().nonnegative(), limit: z.number().int().positive(), unit: z.literal('utf16_code_unit') })),
});

/** Counts cover the supplied document only. Neither producer completeness nor a full workspace graph is implied. */
export function receiptReadCoverage(sections: Record<string, { total: number; limit: number }>, fields: Array<{ path: string; value: unknown; limit: number }> = []) {
  const entries = Object.entries(sections).map(([name, { total, limit }]) => [name, { total, limit, returned: Math.min(total, limit), truncated: total > limit }] as const);
  const omitted = entries.filter(([, s]) => s.truncated).map(([section, s]) => ({ section, count: s.total - s.returned, reason: 'presentation_limit' as const }));
  const clipped_fields = fields.filter((f) => typeof f.value === 'string' && f.value.length > f.limit)
    .map((f) => ({ path: f.path, original_characters: (f.value as string).length, limit: f.limit, unit: 'utf16_code_unit' as const }));
  return { status: omitted.length || clipped_fields.length ? 'partial' as const : 'unknown' as const, scope: 'returned receipt projection' as const,
    source_coverage: 'unknown' as const, sections: Object.fromEntries(entries), omitted, clipped_fields, continuation: 'unsupported' as const };
}
