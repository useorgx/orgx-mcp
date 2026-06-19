/**
 * Context-pack backbone (M).
 *
 * Fetches the compiled AgentContextPack for an entity from the app's
 * POST /api/client/context-pack endpoint, so any MCP client — including hookless
 * ones (Codex) — can start briefed by its first call. Attached additively to
 * orgx_inspect's response. Never throws.
 *
 * @module contextPack
 */
import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

const PACKABLE_TYPES = new Set(['initiative', 'workstream', 'task']);

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
      '/api/client/context-pack',
      { method: 'POST', body: JSON.stringify(buildContextPackRequestBody(anchor)) },
      { userId: userId ?? null }
    );
    const payload = (await response.json()) as { ok?: boolean; data?: unknown };
    return payload?.data ?? null;
  } catch {
    return null;
  }
}
