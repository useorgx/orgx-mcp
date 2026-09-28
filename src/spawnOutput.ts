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

/** Set by this worker, not the app: never dropped while repairing. */
const OWN_KEYS = new Set(['_v2_tool', '_action', 'routed_tool']);
const MAX_REPAIRS = 8;

export function conformSpawnPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SPAWN_KEYS.has(key) || value === null || value === undefined) continue;
    out[key] = key === 'dispatch_receipt' ? conformReceipt(value) : value;
  }
  if (out.dispatch_receipt === undefined) delete out.dispatch_receipt;
  // A field the app shapes differently from the schema (e.g. a null inside
  // next_steps) must not fail a spawn that succeeded: repair or drop only
  // the offending field.
  for (let attempt = 0; attempt < MAX_REPAIRS; attempt += 1) {
    const result = CANONICAL_OUTPUT_SCHEMAS.orgx_spawn.safeParse(out);
    if (result.success) break;
    const key = result.error.issues[0]?.path[0];
    if (typeof key !== 'string' || OWN_KEYS.has(key)) break;
    const value = out[key];
    const cleaned = Array.isArray(value)
      ? value.filter((item) => item !== null && item !== undefined)
      : null;
    if (Array.isArray(value) && cleaned && cleaned.length !== value.length) out[key] = cleaned;
    else delete out[key];
  }
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
