import { batchCreateEntities, type BatchCreateApiCaller, type BatchCreateExistingEntityFinder } from './batchCreate';
import { getLegacyScaffoldBatchNodeShapeIssue, LEGACY_SCAFFOLD_BATCH_CAPABILITY } from './generated/legacyScaffoldBatchProfile';
import { LEGACY_ENTITY_BATCH_VERSION, type BatchCreateEntityInput, type BatchCreateSummary } from './generated/legacyEntityBatchWire';
import { LegacyEntityBatchSummarySchema } from './generated/legacyEntityBatchResponse';
import type { OrgxApiEnv } from './orgxApi';

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Only populated from an authenticated existing bootstrap read, never tool args. */
export class LegacyBatchCapabilityCache {
  constructor(private readonly now: () => number = () => Date.now()) {}
  private discovery: { actor: string; workspace: string; expires: number } | null = null;
  observe(payload: unknown, actor: string | null | undefined): void {
    this.discovery = null;
    const data = record(record(payload)?.data);
    const workspace = record(data?.workspace)?.id;
    const capability = record(record(data?.workflow_contracts)?.legacy_scaffold_batch);
    if (!actor || typeof workspace !== 'string' || !capability ||
      capability.version !== LEGACY_SCAFFOLD_BATCH_CAPABILITY.version ||
      capability.profile !== LEGACY_SCAFFOLD_BATCH_CAPABILITY.profile ||
      capability.max_request_bytes !== LEGACY_SCAFFOLD_BATCH_CAPABILITY.max_request_bytes) return;
    this.discovery = { actor, workspace, expires: this.now() + 5 * 60 * 1000 };
  }
  supports(actor: string | null | undefined, workspace: string | null | undefined): boolean {
    return Boolean(this.discovery && this.discovery.actor === actor && this.discovery.workspace === workspace && this.discovery.expires > this.now());
  }
}

function fitsProfile(entities: BatchCreateEntityInput[], workspace: string, owner: string | null | undefined): boolean {
  return entities.length > 0 && entities.every(value => {
    if (getLegacyScaffoldBatchNodeShapeIssue(value)) return false;
    const node = record(value)!;
    // These existing forms require broader server admission or the legacy
    // finder. Select compatibility before any writes, preserving their behavior.
    if (node.objective_ids != null || node.workspace_ref != null || node.command_center_ref != null || node.run_ref != null || node.run_id != null || node.context != null) return false;
    for (const field of ['workspace_id', 'command_center_id']) if (node[field] != null && node[field] !== workspace) return false;
    for (const field of ['owner_id', 'user_id']) if (node[field] != null && node[field] !== owner) return false;
    return true;
  });
}

/** Select exactly once before writing. No exception or HTTP response replays a batch. */
export async function runCompatibleLegacyBatch(params: {
  env: OrgxApiEnv; callApi: BatchCreateApiCaller; findExistingEntity?: BatchCreateExistingEntityFinder;
  entities: BatchCreateEntityInput[]; ownerId?: string | null; continueOnError: boolean; concurrency: number;
  actorUserId: string | null; capabilityActorUserId?: string | null; workspaceId: string | null; capabilityCache: LegacyBatchCapabilityCache;
}): Promise<BatchCreateSummary> {
  const { actorUserId, capabilityActorUserId = actorUserId, workspaceId, capabilityCache, ...legacy } = params;
  const eligible = !params.findExistingEntity && actorUserId && workspaceId &&
    (params.ownerId == null || params.ownerId === actorUserId) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId) &&
    capabilityCache.supports(capabilityActorUserId, workspaceId) && fitsProfile(params.entities, workspaceId, params.ownerId);
  if (!eligible) return batchCreateEntities(legacy);
  const body = JSON.stringify({ version: LEGACY_ENTITY_BATCH_VERSION, workspace_id: workspaceId,
    entities: params.entities, owner_id: params.ownerId, continue_on_error: params.continueOnError, concurrency: params.concurrency });
  if (new TextEncoder().encode(body).byteLength > LEGACY_SCAFFOLD_BATCH_CAPABILITY.max_request_bytes) return batchCreateEntities(legacy);
  try {
    const response = await params.callApi({ env: params.env, path: '/api/v1/workflows/legacy-scaffold-batch',
      init: { method: 'POST', body }, userId: actorUserId });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = record(await response.json());
    const meta = record(payload?.meta);
    const parsed = LegacyEntityBatchSummarySchema.safeParse(payload?.data);
    if (!parsed.success || meta?.batchVersion !== LEGACY_ENTITY_BATCH_VERSION || meta?.workspaceId !== workspaceId || parsed.data.total !== params.entities.length) throw new Error('Invalid batch response');
    return parsed.data;
  } catch {
    throw new Error('Batch outcome requires reconciliation. Do not retry, replay, or fall back to per-entity creation.');
  }
}
