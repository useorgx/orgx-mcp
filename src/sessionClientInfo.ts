/**
 * Session Client Info — server-side attribution from the MCP handshake.
 *
 * MCP clients identify themselves exactly once, in the `initialize` request's
 * `clientInfo` (name + version). Agents almost never repeat that identity in
 * the optional `_context` param on tool calls, so attribution built only on
 * `_context` goes dark for most sessions. This module captures `clientInfo`
 * at the transport boundary and persists it per MCP session in KV so every
 * subsequent tool-call telemetry record can fall back to the handshake
 * identity when the agent supplied nothing.
 */

export type McpHandshakeClientInfo = {
  name: string;
  version?: string;
};

export const SESSION_CLIENT_INFO_KV_PREFIX = 'mcp_client_info:';

/** Sessions outlive deploys but not refresh-token windows (30 days). */
export const SESSION_CLIENT_INFO_TTL_SECONDS = 30 * 24 * 3600;

type KvNamespaceLike = {
  get(key: string, type: 'json'): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Extract `params.clientInfo` from a JSON-RPC `initialize` request body.
 * Returns null for any other method or when the client sent no usable name.
 */
export function parseInitializeClientInfo(
  body: unknown
): McpHandshakeClientInfo | null {
  const record = asRecord(body);
  if (record.method !== 'initialize') return null;
  const clientInfo = asRecord(asRecord(record.params).clientInfo);
  const name =
    typeof clientInfo.name === 'string' ? clientInfo.name.trim() : '';
  if (!name) return null;
  const version =
    typeof clientInfo.version === 'string' && clientInfo.version.trim()
      ? clientInfo.version.trim()
      : undefined;
  return { name, ...(version ? { version } : {}) };
}

/**
 * Duck-typed access to the worker's OAUTH_KV binding. The transport helpers
 * are generic over Env, so the binding is resolved at runtime the same way
 * isOrgxApiTelemetryConfigured resolves the API credentials.
 */
export function resolveSessionClientInfoKv(env: unknown): KvNamespaceLike | null {
  const kv = asRecord(env).OAUTH_KV as Partial<KvNamespaceLike> | undefined;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    return kv as KvNamespaceLike;
  }
  return null;
}

export async function putSessionClientInfo(
  kv: KvNamespaceLike,
  sessionId: string,
  info: McpHandshakeClientInfo
): Promise<void> {
  try {
    await kv.put(
      `${SESSION_CLIENT_INFO_KV_PREFIX}${sessionId}`,
      JSON.stringify({ name: info.name, version: info.version ?? null }),
      { expirationTtl: SESSION_CLIENT_INFO_TTL_SECONDS }
    );
  } catch (error) {
    console.warn('[mcp:client-info] failed to persist handshake clientInfo', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getSessionClientInfo(
  kv: KvNamespaceLike,
  sessionId: string
): Promise<McpHandshakeClientInfo | null> {
  try {
    const stored = asRecord(
      await kv.get(`${SESSION_CLIENT_INFO_KV_PREFIX}${sessionId}`, 'json')
    );
    const name = typeof stored.name === 'string' ? stored.name.trim() : '';
    if (!name) return null;
    const version =
      typeof stored.version === 'string' && stored.version.trim()
        ? stored.version.trim()
        : undefined;
    return { name, ...(version ? { version } : {}) };
  } catch (error) {
    console.warn('[mcp:client-info] failed to read handshake clientInfo', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
