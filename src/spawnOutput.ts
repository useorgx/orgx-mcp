import { CANONICAL_OUTPUT_SCHEMAS } from './openaiOutputSchemas/canonical';

/**
 * orgx_spawn returns what the app returned, and its output schema is strict:
 * unknown keys, nulls, or extra receipt fields fail the whole tool call even
 * when the spawn succeeded (2026-09-28: dispatch_receipt.publishId null and
 * the claim reconciler's reasonCode/claimLatencyMs rejected every successful
 * task-less spawn). Project the payload onto the published schema instead.
 */
const SPAWN_KEYS = new Set(Object.keys(CANONICAL_OUTPUT_SCHEMAS.orgx_spawn.shape));
const RECEIPT_KEYS = ['dispatch', 'jobStatus', 'acceptedAt', 'publishId'] as const;

export function conformSpawnPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SPAWN_KEYS.has(key) || value === null || value === undefined) continue;
    out[key] = key === 'dispatch_receipt' ? conformReceipt(value) : value;
  }
  if (out.dispatch_receipt === undefined) delete out.dispatch_receipt;
  return out;
}

function conformReceipt(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RECEIPT_KEYS) {
    if (typeof receipt[key] === 'string' && receipt[key]) out[key] = receipt[key];
  }
  return out;
}
