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
export async function fetchContextCapsule(
  env: OrgxApiEnv,
  userId: string | null | undefined,
  workspaceId: string
): Promise<Record<string, unknown> | null> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) return null;

  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort('context capsule deadline exceeded'),
    CONTEXT_CAPSULE_FETCH_TIMEOUT_MS
  );
  try {
    const response = await callOrgxApiJson(
      env,
      CONTEXT_PACK_API_PATH,
      {
        method: 'POST',
        body: JSON.stringify(
          buildContextCapsuleRequestBody(normalizedWorkspaceId)
        ),
        signal: controller.signal,
      },
      { userId: userId ?? null }
    );
    const payload = (await response.json()) as { data?: unknown };
    const capsule = asRecord(asRecord(payload.data)?.context_capsule);
    return capsule?.schema_version === CONTEXT_CAPSULE_SCHEMA_VERSION
      ? capsule
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
