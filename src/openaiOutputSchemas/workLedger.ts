import { z } from 'zod';

import { jsonValueSchema, nullableString, resourceSchema, toolCallSchema } from './shared';
import { interpretationMetadataShape } from './interpretation';

// The work-ledger API owns these nested documents. Keep their JSON fields
// intact as receipts and human review projections evolve independently of MCP.
const documentSchema = z.object({}).catchall(jsonValueSchema);
const countsSchema = z.record(z.number());
const workstreamShape = {
  id: z.string(),
  title: z.string(),
  repo: nullableString,
  receipts: z.array(z.string()),
  members: z.number(),
  sessions: z.number(),
  startedAt: z.string(),
  lastAt: z.string(),
  status: z.string(),
  outcomes: countsSchema,
  unmetCriteria: z.number(),
  costUsd: z.number(),
  costReported: z.number(),
  confidence: z.number().nullable(),
  weakestLink: z.number().nullable(),
  objects: z.array(z.string()),
  workTypes: countsSchema,
  areas: countsSchema,
  relationships: countsSchema,
};
const workstreamSchema = z.object(workstreamShape).catchall(jsonValueSchema);

/**
 * Named fields emitted by searchWorkLedger from GET /api/v1/work-ledger/*.
 * Some names have different types across views: search counts workstreams and
 * receipts, while list/detail views return their documents and receipt IDs.
 * The enclosing search contract stays closed at the transport boundary.
 */
export const workLedgerOutputShape = {
  // One workstream spreads the rollup fields into the result envelope.
  ...workstreamShape,
  members: z.union([z.number(), z.array(documentSchema)]),
  mapping: documentSchema.nullable(),

  scope: z.literal('work_ledger'),
  view: z.enum(['search', 'workstreams', 'review', 'receipt', 'workstream']),
  total: z.number(),
  receipts: z.union([z.number(), z.array(z.string())]),
  workstreams: z.union([z.number(), z.array(workstreamSchema)]),
  window_days: z.number(),
  next_calls: z.array(toolCallSchema),

  // Review queue, including proposals from human outcome judgments.
  items: z.array(documentSchema),
  queue_limit: z.number(),
  queue_truncated: z.boolean(),
  criteria_proposals: z.array(documentSchema),

  // One complete receipt and the team's independent assessment of it.
  receipt_id: z.string(),
  receipt_review_revision: nullableString,
  href: z.string(),
  row: documentSchema.nullable(),
  receipt: documentSchema,
  verdict: z.string(),
  criteria: z.array(documentSchema),
  outcome: documentSchema,
  acceptance: documentSchema,
  receipt_assessment: documentSchema,
  human_judgment: documentSchema.nullable(),
  workstream: workstreamSchema.nullable(),
  mappings: z.array(documentSchema),
  links: z.array(documentSchema),
  uncertain: z.array(z.string()),

};

// Search returns its parsed query instead of the entity search's raw string.
export const workLedgerQuerySchema = z.object({
  text: z.string(),
  filters: z.record(z.string()),
}).catchall(jsonValueSchema);

export const searchResourceSchema = resourceSchema.extend({
  metadata: resourceSchema.shape.metadata.unwrap().unwrap()
    .extend(interpretationMetadataShape)
    .partial()
    .catchall(jsonValueSchema)
    .nullable()
    .optional(),
}).catchall(jsonValueSchema);
