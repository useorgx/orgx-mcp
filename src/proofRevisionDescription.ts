import { z } from 'zod';

// Mirrors the core predecessor schema; changes require cross-repository parity.
export const ArtifactProofPredecessorSchema = z.object({
  artifact_id: z.string().uuid(),
  expected_version: z.number().int().positive().max(2_147_483_647),
  expected_updated_at: z.string().datetime({ offset: true }),
}).strict();
export type ArtifactProofPredecessor = z.infer<typeof ArtifactProofPredecessorSchema>;

export const PROOF_REVISION_DESCRIPTION_PREFIX = 'orgx:proof-revision:v1:';
const revisionNamespace = 'orgx:proof-revision:';
const envelopeSchema = z.object({
  predecessor: ArtifactProofPredecessorSchema,
  description: z.string().trim().max(4000).optional(),
}).strict();

export function isProofRevisionDescription(description: unknown): boolean {
  return typeof description === 'string' && description.trim().startsWith(revisionNamespace);
}

/** A documented transport encoding, never review, acceptance or status authority. */
export function normalizeProofRevisionDescription<T extends {
  description?: string | null;
  predecessor?: ArtifactProofPredecessor;
}>(artifact: T): T {
  if (!isProofRevisionDescription(artifact.description)) return artifact;
  const description = artifact.description!.trim();
  if (description.length > 4000) throw new Error('OrgX proof revision description exceeds 4000 characters.');
  if (!description.startsWith(PROOF_REVISION_DESCRIPTION_PREFIX))
    throw new Error('OrgX proof revision description version is unsupported.');
  const encoded = description.slice(PROOF_REVISION_DESCRIPTION_PREFIX.length);
  let material: unknown;
  try { material = JSON.parse(encoded); }
  catch { throw new Error('OrgX proof revision description must contain valid JSON.'); }
  // Requiring compact JSON also rejects duplicate members instead of silently
  // choosing whichever revision witness appears last in an ambiguous object.
  if (JSON.stringify(material) !== encoded)
    throw new Error('OrgX proof revision description must use compact JSON without duplicate members.');
  const envelope = envelopeSchema.parse(material);
  if (isProofRevisionDescription(envelope.description))
    throw new Error('OrgX proof revision descriptions cannot contain another revision envelope.');
  const typed = artifact.predecessor === undefined
    ? undefined
    : ArtifactProofPredecessorSchema.parse(artifact.predecessor);
  if (typed && JSON.stringify(typed) !== JSON.stringify(envelope.predecessor))
    throw new Error('OrgX typed and encoded proof predecessor must agree.');
  const { description: _encodedDescription, ...ordinary } = artifact;
  return {
    ...ordinary,
    ...(envelope.description === undefined ? {} : { description: envelope.description }),
    predecessor: typed ?? envelope.predecessor,
  } as T;
}
