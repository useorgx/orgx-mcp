import { z } from 'zod';

import { jsonValueSchema } from './shared';

const documentSchema = z.object({}).catchall(jsonValueSchema);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

// The canonical app loader verifies the complete interpretation and ledger
// hash. These transport fields preserve its provenance and assurance without
// treating a content hash as an independent witness or accepted work.
export const interpretationMetadataShape = {
  interpretation: documentSchema,
  event_id: z.string().uuid(),
  event_hash: digestSchema,
  global_sequence: z.number().int().nonnegative(),
  assurance_rung: z.number().int().min(0).max(5).nullable(),
};
