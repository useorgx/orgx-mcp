import { z } from 'zod';

/** Bound producer observations; OrgX owns evaluation and acceptance. */
export const modalityProofInputSchema = z.object({
  kind: z.enum(['playback', 'execution', 'schema', 'render', 'runtime', 'mixed']),
  status: z.enum(['passed', 'failed', 'blocked', 'not_run']),
  artifact_version: z.literal(1),
  checked_at: z.string().datetime({ offset: true }),
  evidence_refs: z.array(z.object({
    url: z.string().url().max(2000),
    hash: z.string().trim().min(1).max(240).optional(),
    description: z.string().trim().min(1).max(2000).optional(),
  }).strict()).min(1).max(30),
}).strict();
