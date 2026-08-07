import { z } from 'zod';

import {
  buildFounderTeamArtifactMetadata,
  FOUNDER_TEAM_COMPANY_STAGES,
} from './artifactContracts';

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
    metadata: z.record(z.string(), z.unknown()).optional(),
    agent_type: z.string().trim().min(1).max(120).optional(),
    company_stage: z.enum(FOUNDER_TEAM_COMPANY_STAGES).optional(),
    business_outcome: z.string().trim().min(1).max(1_000).optional(),
    owner: z.string().trim().min(1).max(200).optional(),
    review_date: z.string().trim().min(1).max(120).optional(),
    verification: z.array(z.string().trim().min(1).max(2_000)).optional(),
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
  agent_type?: string;
  company_stage?: (typeof FOUNDER_TEAM_COMPANY_STAGES)[number];
  business_outcome?: string;
  owner?: string;
  review_date?: string;
  verification?: string[];
  created_by_type?: 'human' | 'agent';
  created_by_id?: string;
};

/**
 * Fold server-resolved client attribution into the attach payload.
 *
 * `/api/client/artifacts` validates its body with a `.strict()` schema that has
 * no `source_client` key, and `work_artifacts` has no such column — so sending
 * it at the top level makes the server reject its own injected field
 * ("Unrecognized key: source_client"). `metadata` is an open record on both the
 * contract and the table, and is where the builder already parks the other
 * derived attribution fields (agent_type, owner, ...), so attribution lands
 * there instead.
 */
export function withAttachSourceClient(
  payload: EntityActionAttachPayload,
  sourceClient: string | null | undefined
): EntityActionAttachPayload {
  if (!sourceClient) return payload;
  return {
    ...payload,
    metadata: { ...(payload.metadata ?? {}), source_client: sourceClient },
  };
}

export function buildEntityActionAttachPayload(
  args: unknown
): EntityActionAttachPayload {
  const parsed = entityActionAttachSchema.parse(args);
  const artifactContractMetadata = buildFounderTeamArtifactMetadata({
    agent_type: parsed.agent_type,
    company_stage: parsed.company_stage,
    business_outcome: parsed.business_outcome,
    owner: parsed.owner,
    review_date: parsed.review_date,
    verification: parsed.verification,
  });
  const metadata = {
    ...(parsed.metadata ?? {}),
    ...(artifactContractMetadata ?? {}),
  };

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
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(parsed.created_by_type
      ? { created_by_type: parsed.created_by_type }
      : {}),
    ...(parsed.created_by_id ? { created_by_id: parsed.created_by_id } : {}),
  };
}
