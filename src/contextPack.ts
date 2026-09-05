/**
 * Context-pack backbone (M).
 *
 * Fetches the compiled AgentContextPack for an entity from the app's
 * POST /api/v1/context-pack endpoint, so any MCP client — including hookless
 * ones (Codex) — can start briefed by its first call. Attached additively to
 * orgx_inspect's response. Never throws.
 *
 * @module contextPack
 */
import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';
import { applyContextTransfer, type ContextContinuation } from './contextContinuation';

// Optional transport acceleration. Current auth and current app preparation run on every call.
const continuationBases = new Map<string, ContextContinuation>();
let continuationBytes = 0;
function retainContinuation(key: string, base: ContextContinuation) {
  const size = new TextEncoder().encode(base.serialized).byteLength;
  const previous = continuationBases.get(key);
  if (previous) { continuationBytes -= new TextEncoder().encode(previous.serialized).byteLength; continuationBases.delete(key); }
  if (size > 1024 * 1024) return;
  while (continuationBases.size >= 32 || continuationBytes + size > 8 * 1024 * 1024) {
    const oldest = continuationBases.keys().next().value;
    if (oldest === undefined) break;
    continuationBytes -= new TextEncoder().encode(continuationBases.get(oldest)!.serialized).byteLength;
    continuationBases.delete(oldest);
  }
  continuationBases.set(key, base); continuationBytes += size;
}

const PACKABLE_TYPES = new Set(['initiative', 'workstream', 'task']);
export const CONTEXT_PACK_API_PATH = '/api/v1/context-pack';
export const CONTEXT_CAPSULE_SCHEMA_VERSION = 'orgx.context-capsule/v1';
export const CONTEXT_CAPSULE_FETCH_TIMEOUT_MS = 4_000;

export interface ContextPackAnchor {
  type: string;
  id: string;
}

/** Pure: the request body the app endpoint expects. */
export function buildContextPackRequestBody(
  anchor: ContextPackAnchor
): Record<string, string> {
  return { entity_type: anchor.type, entity_id: anchor.id };
}

/** Pure: workspace-scoped request body for the additive v1 context capsule. */
export function buildContextCapsuleRequestBody(
  workspaceId: string
): Record<string, string> {
  return { workspace_id: workspaceId };
}

/** Pure: only initiative/workstream/task anchors are packable. */
export function isPackableAnchor(anchor: ContextPackAnchor): boolean {
  return Boolean(anchor.id) && PACKABLE_TYPES.has(anchor.type);
}

/**
 * Fetch the AgentContextPack for an entity. Returns null on any failure (or a
 * non-packable anchor) so callers can attach it additively without risk.
 */
export async function fetchContextPack(
  env: OrgxApiEnv,
  userId: string | null | undefined,
  anchor: ContextPackAnchor
): Promise<unknown | null> {
  if (!isPackableAnchor(anchor)) return null;
  try {
    const response = await callOrgxApiJson(
      env,
      CONTEXT_PACK_API_PATH,
      { method: 'POST', body: JSON.stringify(buildContextPackRequestBody(anchor)) },
      { userId: userId ?? null }
    );
    const payload = (await response.json()) as { ok?: boolean; data?: unknown };
    return payload?.data ?? null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Fetch the workspace Context Capsule without making bootstrap availability
 * depend on this additive projection. The strict local deadline is shorter
 * than the general API timeout because a missing capsule must degrade to null,
 * not stall the agent's first call.
 */
export async function fetchContextPreparation(
  env: OrgxApiEnv,
  userId: string | null | undefined,
  workspaceId: string,
  initiativeId?: string
): Promise<{ context_capsule: Record<string, unknown> | null; context_delivery: Record<string, unknown> | null; context_pack: Record<string, unknown> | null } | null> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) return null;

  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort('context capsule deadline exceeded'),
    CONTEXT_CAPSULE_FETCH_TIMEOUT_MS
  );
  try {
    const key = JSON.stringify([env.ORGX_API_URL, userId, normalizedWorkspaceId, initiativeId]);
    const previous = continuationBases.get(key);
    const fetchPreparation = async (base?: ContextContinuation, prepared = false) => {
    const response = await callOrgxApiJson(
      env,
      CONTEXT_PACK_API_PATH,
      {
        method: 'POST',
        body: JSON.stringify(
          { ...buildContextCapsuleRequestBody(normalizedWorkspaceId),
            ...(initiativeId ? { initiative_id: initiativeId } : {}),
            ...(prepared ? { response_profile: 'prepared' } : {
              delivery_mode: 'delta',
              ...(base ? { acknowledged_context_version: base.version } : {})
            }) }
        ),
        signal: controller.signal,
      },
      { userId: userId ?? null }
    );
    const payload = (await response.json()) as { data?: unknown };
    const responseData = asRecord(payload.data);
    if (!responseData) return null;
    // Older app releases ignore the additive request and return the established full shape.
    if (!responseData.context_transfer) return responseData;
    const restored = await applyContextTransfer(responseData, base);
    retainContinuation(key, restored);
    return restored.data;
    };
    let data: Record<string, unknown> | null;
    try { data = await fetchPreparation(initiativeId ? previous : undefined, !initiativeId); }
    catch (error) {
      if (controller.signal.aborted || (initiativeId && !previous)) throw error;
      // Oversized prepared context uses the existing full/continuation path,
      // with the same owner, workspace and total deadline.
      data = await fetchPreparation(initiativeId ? undefined : previous);
    }
    const capsule = asRecord(data?.context_capsule);
    if (!data) return null;
    return {
      context_capsule: capsule?.schema_version === CONTEXT_CAPSULE_SCHEMA_VERSION ? capsule : null,
      context_delivery: asRecord(data.context_delivery),
      context_pack: initiativeId ? data : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

/** Compatibility helper for consumers that only need the capsule. */
export async function fetchContextCapsule(
  env: OrgxApiEnv, userId: string | null | undefined, workspaceId: string
): Promise<Record<string, unknown> | null> {
  return (await fetchContextPreparation(env, userId, workspaceId))?.context_capsule ?? null;
}
