import { z } from 'zod';
import { jsonValueSchema } from './openaiOutputSchemas/shared';

const detail = z.record(jsonValueSchema);
export const WORKFLOW_COMPLETION_OUTPUT_SCHEMA = z.object({
  data: z.object({
    completed: z.boolean().optional(), state: z.string().optional(), proof_attached: z.boolean().optional(),
    artifact: detail.nullable().optional(), verification: detail.nullable().optional(), completion: detail.nullable().optional(),
    partial: z.boolean().optional(), error: z.union([z.string(), z.object({ code: z.string(), message: z.string() }).strict()]).optional(),
  }).catchall(jsonValueSchema),
  meta: z.object({ apiVersion: z.literal('1'), workspaceId: z.string().nullable(), implementation: z.enum(['core', 'compatibility']).optional() }).strict(),
}).strict();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable retries bind the exact declared producer material, never authority. */
export async function taskProofCompletionRequest(args: Record<string, unknown>) {
  const artifact = args.artifact && typeof args.artifact === 'object' ? args.artifact as Record<string, unknown> : null;
  const body = {
    ...(args.workspace_id ? { workspace_id: args.workspace_id } : {}),
    type: 'task', id: args.id,
    ...(artifact ? { artifact: {
      name: artifact.name ?? 'Task completion proof', artifact_type: artifact.artifact_type,
      artifact_url: artifact.artifact_url ?? artifact.external_url,
      ...(artifact.description !== undefined ? { description: artifact.description } : {}),
      ...(artifact.preview_markdown !== undefined ? { preview_markdown: artifact.preview_markdown } : {}),
      ...(artifact.artifact_hash !== undefined ? { artifact_hash: artifact.artifact_hash } : {}),
      ...(artifact.atomic_unit_type !== undefined ? { atomic_unit_type: artifact.atomic_unit_type } : {}),
      ...(artifact.modality_proof !== undefined ? { modality_proof: artifact.modality_proof } : {}),
      ...(args.verification !== undefined ? { verification: args.verification } : {}),
      ...(args.quality_score !== undefined ? { quality_score: args.quality_score } : {}),
    } } : {}),
    ...(args.note !== undefined ? { summary: args.note } : {}),
  };
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(body)));
  const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { body, idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : `mcp-proof:${digest}` };
}
