import { z } from 'zod';
import { idempotencyKeySchema } from './idempotencyKeySchema';

/** Mirrors the app's canonical ArtifactOutputFrontDoorInputSchema, never its trusted sources. */
export const outputFrontDoorInputSchema = z.object({
  answer: z.string().trim().min(1).max(2000),
  decisions: z.array(z.object({
    decisionId: z.string().uuid(),
    question: z.string().trim().min(1).max(240),
    recommendation: z.string().trim().min(1).max(500),
    impact: z.string().trim().min(1).max(500),
  }).strict()).max(3).default([]),
  checked: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  notChecked: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
}).strict();

export const workOutputArtifactSchema = z.object({
  name: z.string().trim().min(1).max(500),
  artifact_type: z.string().trim().min(1).max(120),
  location: z.union([
    z.object({ artifact_url: z.string().trim().min(1).max(2000) }).strict(),
    z.object({ external_url: z.string().url().max(2000) }).strict(),
  ]),
  description: z.string().trim().max(4000).optional(),
  preview_markdown: z.string().max(25_000).optional(),
  output_front_door: outputFrontDoorInputSchema.optional(),
}).strict();

/** Compound edits are separate keyed calls so an attachment cannot hide a partial patch. */
export function validateWorkUpdateSelection(args: Record<string, unknown>): void {
  if ((args.fields === undefined) === (args.artifact === undefined))
    throw new Error('Supply exactly one of fields or artifact. Use a separate retry key for each operation.');
  if (args.artifact !== undefined) {
    z.string().uuid().parse(args.id);
    workOutputArtifactSchema.parse(args.artifact);
  }
}

export function buildWorkOutputAttachmentRequest(args: Record<string, unknown>) {
  validateWorkUpdateSelection(args);
  const input = z.object({
    type: z.enum(['initiative', 'workstream', 'milestone', 'task']),
    id: z.string().uuid(),
    workspace_id: z.string().uuid().optional(),
    session_id: z.string().trim().min(1).optional(),
    artifact: workOutputArtifactSchema,
  }).strict().parse({
    type: args.type, id: args.id,
    ...(args.workspace_id !== undefined ? { workspace_id: args.workspace_id } : {}),
    ...(args.session_id !== undefined ? { session_id: args.session_id } : {}),
    artifact: args.artifact,
  });
  return { body: input, idempotencyKey: idempotencyKeySchema.parse(args.idempotency_key) };
}

export function readWorkOutputAttachmentAcknowledgement(raw: unknown) {
  return z.object({ data: z.object({
    artifact: z.object({ id: z.string().uuid() }).passthrough(),
    duplicate: z.boolean(),
    review_url: z.string(),
    completed: z.literal(false), accepted: z.literal(false),
  }).strict() }).passthrough().parse(raw).data;
}
