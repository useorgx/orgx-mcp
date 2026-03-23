import { z } from 'zod';

const ATTACHABLE_ENTITY_TYPES = [
  'project',
  'initiative',
  'workstream',
  'milestone',
  'task',
  'decision',
] as const;

const ATTACHABLE_ARTIFACT_STATUSES = [
  'draft',
  'in_review',
  'approved',
  'changes_requested',
  'superseded',
  'archived',
] as const;

const entityActionAttachSchema = z
  .object({
    type: z.enum(ATTACHABLE_ENTITY_TYPES),
    id: z.string().trim().min(1),
    artifact_id: z.string().uuid().optional(),
    initiative_id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).max(500),
    artifact_type: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4_000).optional(),
    artifact_url: z.string().trim().min(1).max(2_000).optional(),
    external_url: z.string().trim().max(2_000).optional(),
    preview_markdown: z.string().max(25_000).optional(),
    status: z.enum(ATTACHABLE_ARTIFACT_STATUSES).optional(),
    metadata: z.record(z.unknown()).optional(),
    created_by_type: z.enum(['human', 'agent']).optional(),
    created_by_id: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.artifact_url && !value.external_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'action=attach requires artifact_url or external_url',
        path: ['artifact_url'],
      });
    }
  });

export type EntityActionAttachPayload = {
  entity_type: (typeof ATTACHABLE_ENTITY_TYPES)[number];
  entity_id: string;
  artifact_id?: string;
  initiative_id?: string;
  name: string;
  artifact_type: string;
  description?: string;
  artifact_url?: string;
  external_url?: string;
  preview_markdown?: string;
  status?: (typeof ATTACHABLE_ARTIFACT_STATUSES)[number];
  metadata?: Record<string, unknown>;
  created_by_type?: 'human' | 'agent';
  created_by_id?: string;
};

export function buildEntityActionAttachPayload(
  args: unknown
): EntityActionAttachPayload {
  const parsed = entityActionAttachSchema.parse(args);

  return {
    entity_type: parsed.type,
    entity_id: parsed.id,
    ...(parsed.artifact_id ? { artifact_id: parsed.artifact_id } : {}),
    ...(parsed.initiative_id ? { initiative_id: parsed.initiative_id } : {}),
    name: parsed.name,
    artifact_type: parsed.artifact_type,
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.artifact_url ? { artifact_url: parsed.artifact_url } : {}),
    ...(parsed.external_url ? { external_url: parsed.external_url } : {}),
    ...(parsed.preview_markdown
      ? { preview_markdown: parsed.preview_markdown }
      : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
    ...(parsed.created_by_type
      ? { created_by_type: parsed.created_by_type }
      : {}),
    ...(parsed.created_by_id ? { created_by_id: parsed.created_by_id } : {}),
  };
}
