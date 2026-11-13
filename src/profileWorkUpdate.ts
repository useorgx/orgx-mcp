import { z } from 'zod';
import { idempotencyKeySchema } from './idempotencyKeySchema';

// Older app routes have strict bodies and reject these controls before writing.
// Do not remove them to make an unsupported deployment accept the request.
export const PROFILE_WORK_RETRY_CONTRACT = 'profile_work_update_v1';
const retryReceipt = z.object({
  retry_contract: z.literal(PROFILE_WORK_RETRY_CONTRACT),
  idempotency_key: idempotencyKeySchema,
  idempotent_replay: z.boolean(),
}).passthrough();

const source = z.object({ kind: z.string().max(40), label: z.string().max(400) }).strict();
/** Same draft edits as the app's barDraftSchemas; publication is not an edit. */
const qualityBarPatch = z.union([
  z.object({ part: z.literal('criteria'), decide: z.boolean().optional(),
    items: z.array(z.object({ key: z.string().min(1).max(120), name: z.string().max(120), weight: z.number().min(0).max(1), question: z.string().max(600), source }).strict()).max(12).optional(),
    checks: z.array(z.object({ id: z.string().min(1).max(120), label: z.string().min(1).max(160), description: z.string().min(1).max(600), blocking: z.boolean(), checkerId: z.string().min(1).max(160), checkerVersion: z.string().min(1).max(40), added: z.boolean(), source }).strict()).max(20).optional(),
  }).strict(),
  z.object({ part: z.literal('line'), value: z.number().min(30).max(100).optional(), decide: z.boolean().optional() }).strict(),
  z.object({ part: z.literal('references'), pinned: z.record(z.string().guid(), z.boolean()).optional(), decide: z.boolean().optional() }).strict(),
  z.object({ part: z.literal('calibration'), choice: z.enum(['after_publish', 'not_now']).optional(), decide: z.boolean().optional() }).strict(),
  z.object({ part: z.literal('shipRule'), choice: z.enum(['approve_every', 'clear_when_trusted']).optional(), decide: z.boolean().optional() }).strict(),
  z.object({ part: z.literal('reopen'), target: z.enum(['criteria', 'line', 'references', 'calibration', 'shipRule']) }).strict(),
]);

export const qualityBarPatchFields = z.object({ patches: z.array(qualityBarPatch).min(1).max(8) }).strict();
/**
 * One thing every agent should know about the workspace (what we sell, who buys it...).
 * The app stores a written fact as derived, not confirmed, and never replaces a fact a
 * person confirmed, so there is no readiness field to send.
 */
export const workspaceFactWrite = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,47}$/),
  text: z.string().trim().min(1).max(320),
  label: z.string().trim().min(1).max(60).optional(),
  source: z.string().trim().min(1).max(120).optional(),
}).strict();
export const workspaceProfileFields = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  facts: z.array(workspaceFactWrite).min(1).max(12).optional(),
}).strict().refine((fields) => fields.name !== undefined || fields.description !== undefined || fields.facts !== undefined, 'Provide name, description or facts.');
const kindKey = z.string().trim().min(1).max(200).regex(/^[a-z0-9_.-]+$/i);

export function validateProfileWorkUpdate(args: Record<string, unknown>): void {
  if (args.type === 'quality_bar' || args.type === 'workspace') {
    if (args.artifact !== undefined) throw new Error('Workspace and quality_bar accept fields only.');
    if (args.type === 'quality_bar') {
      kindKey.parse(args.id);
      qualityBarPatchFields.parse(args.fields);
    } else {
      z.string().guid().parse(args.id);
      workspaceProfileFields.parse(args.fields);
      if (args.workspace_id !== undefined && args.workspace_id !== args.id)
        throw new Error('workspace_id must match the workspace id being edited.');
    }
    return;
  }
  if (args.fields && typeof args.fields === 'object' && 'patches' in args.fields)
    throw new Error('fields.patches applies to type quality_bar only.');
}

export async function executeProfileWorkUpdate(
  args: Record<string, unknown>,
  request: (path: string, init: { method: string; body: string; headers: Record<string, string> }) => Promise<Record<string, unknown>>,
) {
  validateProfileWorkUpdate(args);
  const key = idempotencyKeySchema.parse(args.idempotency_key);
  const headers = { 'Idempotency-Key': key };
  const retry = { retry_contract: PROFILE_WORK_RETRY_CONTRACT, idempotency_key: key };
  const workspaceId = args.workspace_id === undefined ? undefined : z.string().guid().parse(args.workspace_id);
  let data: Record<string, unknown>;
  let message: string;
  let raw: Record<string, unknown>;
  if (args.type === 'quality_bar') {
    const fields = qualityBarPatchFields.parse(args.fields);
    raw = await request('/api/v1/quality-bars/drafts', { method: 'POST', headers,
      body: JSON.stringify({ kind_key: kindKey.parse(args.id), patches: fields.patches, ...(workspaceId ? { workspace_id: workspaceId } : {}), ...retry }),
    });
    const saved = z.object({ draft: z.object({ id: z.string().guid(), kindKey, status: z.literal('open') }).passthrough(),
      review_path: z.string().startsWith('/settings/quality/'), publish: z.literal('person_only'), created: z.boolean(),
    }).passthrough().parse(raw.data);
    if (saved.draft.kindKey !== args.id) throw new Error('Quality bar acknowledgement does not match the requested kind.');
    data = { id: saved.draft.id, type: 'quality_bar', name: saved.draft.kindKey, status: saved.draft.status,
      review_path: saved.review_path, publish: saved.publish, draft: saved.draft };
    message = `Draft saved. A person publishes it at ${saved.review_path}.`;
  } else if (args.type === 'workspace') {
    raw = await request('/api/v1/workspaces/profile', { method: 'PATCH', headers,
      body: JSON.stringify({ ...workspaceProfileFields.parse(args.fields), workspace_id: args.id, ...retry }),
    });
    const saved = z.object({ workspace: z.object({ id: z.string().guid(), name: z.string(), description: z.string().nullable() }).passthrough(),
      facts: z.object({ written: z.array(z.string()), skipped_confirmed: z.array(z.string()) }).optional() }).parse(raw.data);
    if (saved.workspace.id !== args.id) throw new Error('Workspace acknowledgement does not match the requested workspace.');
    data = saved.facts ? { ...saved.workspace, facts: saved.facts } : saved.workspace;
    message = !saved.facts ? 'Workspace updated.'
      : `${saved.facts.written.length} fact(s) saved as derived; a person confirms them.${saved.facts.skipped_confirmed.length ? ` Not changed, already confirmed by a person: ${saved.facts.skipped_confirmed.join(', ')}.` : ''}`;
  } else {
    throw new Error('Unsupported profile work update.');
  }
  const receipt = retryReceipt.parse(raw.data);
  if (receipt.idempotency_key !== key) throw new Error('Profile write acknowledgement does not match the retry key.');
  return { _v2_tool: 'orgx_write' as const, operation: 'update' as const, ok: true, updated: true,
    type: String(args.type), id: String(args.id), data, message, idempotent_replay: receipt.idempotent_replay, ...(raw.meta ? { meta: raw.meta } : {}) };
}
