import type { OrgxApiEnv } from './orgxApi';
import { executeLegacyEntityBatch, type BatchCreateExistingEntityFinder } from './generated/legacyEntityBatchExecution';
import type { BatchCreateEntityInput, BatchCreateSummary } from './generated/legacyEntityBatchWire';
export type { BatchCreateEntityInput, BatchCreateEntityResult, BatchCreateSummary } from './generated/legacyEntityBatchWire';
export type { BatchCreateExistingEntityFinder } from './generated/legacyEntityBatchExecution';
export { validateEntityCreatePayloadContract } from './generated/legacyEntityBatchPreparation';

export type BatchCreateApiCaller = (params: {
  env: OrgxApiEnv;
  path: string;
  init: RequestInit;
  userId?: string | null;
}) => Promise<Response>;

/** Compatibility transport facade. Authenticated identity is still bound by callers. */
export async function batchCreateEntities(params: {
  env: OrgxApiEnv;
  callApi: BatchCreateApiCaller;
  findExistingEntity?: BatchCreateExistingEntityFinder;
  entities: BatchCreateEntityInput[];
  ownerId?: string | null;
  continueOnError: boolean;
  concurrency: number;
}): Promise<BatchCreateSummary> {
  const { env, callApi, ...command } = params;
  return executeLegacyEntityBatch({
    ...command,
    createEntity: body => callApi({ env, path: '/api/entities', init: { method: 'POST', body: JSON.stringify(body) }, userId: params.ownerId ?? null }),
  });
}
