import { z } from 'zod';

const uuid = z.string().uuid();
const nullableText = z.string().min(1).max(300).nullable();
const finiteAmount = z.number().finite().nonnegative().nullable();

/** Additive app projection. Producer metadata must never supply these sources. */
export const artifactOutputFrontDoorSchema = z.object({
  schemaVersion: z.literal('artifact_output_front_door.v1'),
  answer: z.string().min(1).max(2000),
  decisions: z.array(z.object({
    id: uuid,
    question: z.string().min(1).max(240),
    recommendation: z.string().min(1).max(500),
    impact: z.string().min(1).max(500),
    href: z.string(),
  }).strict().refine((value) => value.href === `/decisions/${value.id}`)).max(3),
  checked: z.array(z.string().min(1).max(500)).max(8),
  notChecked: z.array(z.string().min(1).max(500)).max(8),
  evidenceBasis: z.literal('producer_reported'),
  context: z.object({
    state: z.enum(['loaded', 'partial', 'missing', 'unavailable', 'unknown']),
    summary: z.string().min(1).max(1000),
    runId: uuid.nullable(),
  }).strict(),
  files: z.array(z.object({
    artifactId: uuid,
    name: z.string().min(1).max(300),
    mimeType: z.string().min(1).max(150).nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    purpose: z.string().min(1).max(500),
    href: z.string(),
  }).strict().refine((value) => value.href === `/artifacts/${value.artifactId}`)).max(100),
  receipt: z.object({
    href: z.string().nullable(),
    runId: uuid.nullable(),
    costUsd: finiteAmount,
    expertMinutes: finiteAmount,
    qualityBar: nullableText,
  }).strict().refine((value) => value.href === (value.runId ? `/console/runs/${value.runId}` : null)),
}).strict();

export type ArtifactOutputFrontDoor = z.infer<typeof artifactOutputFrontDoorSchema>;

/** An artifact's own narrative metadata is not a canonical review projection. */
export function canonicalOutputFrontDoor(envelope: {
  reviewContractSource?: unknown;
  reviewContract?: Record<string, unknown> | null;
}): ArtifactOutputFrontDoor | null {
  if (envelope.reviewContractSource !== 'canonical' ||
      envelope.reviewContract?.schemaVersion !== 'artifact_review_contract.v1') return null;
  const parsed = artifactOutputFrontDoorSchema.safeParse(envelope.reviewContract.frontDoor);
  return parsed.success ? parsed.data : null;
}
