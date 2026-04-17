/**
 * entity_action action=ship_batch payload builder.
 *
 * ship_batch is a milestone-only action that atomically attaches one artifact
 * and marks multiple subcomponent tasks complete. Used when a single PR covers
 * several subcomponent tasks under the same milestone.
 *
 * The orgx server endpoint is POST /api/entities/milestone/:id/ship_batch.
 */
import { z } from 'zod';

const SHIP_BATCH_ARTIFACT_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'changes_requested',
  'superseded',
  'archived',
] as const;

const shipBatchArtifactSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    artifact_type: z.string().trim().min(1).max(120),
    artifact_url: z.string().trim().min(1).max(2_000).optional(),
    external_url: z.string().trim().max(2_000).optional(),
    artifact_hash: z.string().trim().max(200).optional(),
    status: z.enum(SHIP_BATCH_ARTIFACT_STATUSES).optional(),
    preview_markdown: z.string().max(25_000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.artifact_url && !value.external_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ship_batch artifact requires artifact_url or external_url',
        path: ['artifact_url'],
      });
    }
  });

const shipBatchInputSchema = z
  .object({
    milestone_id: z.string().trim().min(1),
    artifact: shipBatchArtifactSchema,
    quality_score: z.number().min(0).max(5).optional(),
    task_ids: z.array(z.string().uuid()).optional(),
    note: z.string().trim().max(4_000).optional(),
    user_id: z.string().trim().min(1).optional(),
  })
  .strict();

export type ShipBatchPayload = {
  artifact: z.infer<typeof shipBatchArtifactSchema>;
  quality_score?: number;
  task_ids?: string[];
  note?: string;
  reason?: string;
  user_id?: string;
};

export function buildEntityActionShipBatchPayload(args: unknown): {
  milestone_id: string;
  body: ShipBatchPayload;
} {
  const parsed = shipBatchInputSchema.parse(args);

  const body: ShipBatchPayload = {
    artifact: parsed.artifact,
  };
  if (parsed.quality_score !== undefined) body.quality_score = parsed.quality_score;
  if (parsed.task_ids && parsed.task_ids.length > 0)
    body.task_ids = parsed.task_ids;
  if (parsed.note) {
    body.note = parsed.note;
    body.reason = parsed.note;
  }
  if (parsed.user_id) body.user_id = parsed.user_id;

  return { milestone_id: parsed.milestone_id, body };
}
