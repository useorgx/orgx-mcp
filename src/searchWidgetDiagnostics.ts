const PATH = '/telemetry/search-widget';
const TTL_SECONDS = 900;
const CODES = new Set(['rendered', 'response_timeout', 'incomplete_response', 'tool_error', 'page_error']);
const PROTOCOLS = new Set(['chatgpt', 'mcp-apps', 'mcp-apps-sdk']);
interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
interface DiagnosticEnv {
  MCP_JWT_SECRET?: string;
  MCP_SERVER_URL?: string;
  OAUTH_KV?: KvLike;
}
type Grant = { version: 1; audience: 'orgx-search-widget-diagnostics'; nonce: string; exp: number };
type Health = { rendered: number; failed: number; latest_failure_at: string | null; latest_failure_code: string | null };
const emptyHealth = (): Health => ({ rendered: 0, failed: 0, latest_failure_at: null, latest_failure_code: null });
const healthKey = (now: number) => `search-widget:health:${Math.floor(now / 3_600_000)}`;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function key(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function buildSearchDiagnosticsContext(env: DiagnosticEnv, now = Date.now()) {
  if (!env.MCP_JWT_SECRET || !env.MCP_SERVER_URL || !env.OAUTH_KV) return null;
  const origin = new URL(env.MCP_SERVER_URL).origin;
  const grant: Grant = { version: 1, audience: 'orgx-search-widget-diagnostics', nonce: crypto.randomUUID(), exp: Math.floor(now / 1000) + TTL_SECONDS };
  const payload = encode(new TextEncoder().encode(JSON.stringify(grant)));
  const signature = await crypto.subtle.sign('HMAC', await key(env.MCP_JWT_SECRET), new TextEncoder().encode(payload));
  const days = await Promise.all([now, now - 3_600_000].flatMap(at =>
    ['failed', 'rendered'].map(kind => env.OAUTH_KV!.get(healthKey(at) + ':' + kind))));
  const health = days.map(raw => {
    try { return raw ? JSON.parse(raw) as Health : emptyHealth(); } catch { return emptyHealth(); }
  });
  return {
    meta: { endpoint: origin + PATH, grant: payload + '.' + encode(new Uint8Array(signature)) },
    health: {
      window_minutes: 120,
      rendered: health.reduce((n, h) => n + h.rendered, 0),
      failed: health.reduce((n, h) => n + h.failed, 0),
      latest_failure_at: health[0].latest_failure_at ?? health[2].latest_failure_at,
      latest_failure_code: health[0].latest_failure_code ?? health[2].latest_failure_code,
    },
  };
}

/** Narrow, signed, short-lived telemetry grant; never accepts search text. */
export async function handleSearchWidgetDiagnostics(
  request: Request,
  env: DiagnosticEnv,
  report: (event: { code: string; protocol: string; failed: boolean }) => void,
  now = Date.now()
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null;
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  };
  const response = (status: number) => new Response(null, { status, headers });
  if (request.method === 'OPTIONS') return response(204);
  if (request.method !== 'POST') return response(405);
  if (!env.MCP_JWT_SECRET || !env.OAUTH_KV) return response(503);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return response(415);
  // Bound the streamed body too, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return response(400);
  let bytes = new Uint8Array();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (bytes.length + chunk.value.length > 2048) { await reader.cancel(); return response(413); }
    const joined = new Uint8Array(bytes.length + chunk.value.length);
    joined.set(bytes); joined.set(chunk.value, bytes.length); bytes = joined;
  }
  let body: { grant?: unknown; code?: unknown; protocol?: unknown };
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return response(400); }
  if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['grant', 'code', 'protocol'].includes(k)) ||
      typeof body.grant !== 'string' || typeof body.code !== 'string' || !CODES.has(body.code) ||
      typeof body.protocol !== 'string' || !PROTOCOLS.has(body.protocol)) return response(400);
  let grant: Grant;
  try {
    const [payload, signature, extra] = body.grant.split('.');
    if (!payload || !signature || extra) return response(401);
    const verified = await crypto.subtle.verify('HMAC', await key(env.MCP_JWT_SECRET), decode(signature), new TextEncoder().encode(payload));
    if (!verified) return response(401);
    grant = JSON.parse(new TextDecoder().decode(decode(payload))) as Grant;
    if (grant.version !== 1 || grant.audience !== 'orgx-search-widget-diagnostics' || typeof grant.nonce !== 'string' || !Number.isFinite(grant.exp) ||
        grant.exp <= now / 1000 || grant.exp > now / 1000 + TTL_SECONDS + 1) return response(401);
  } catch { return response(401); }
  const dedupe = `search-widget:seen:${grant.nonce}:${body.code}`;
  if (await env.OAUTH_KV.get(dedupe)) return response(204);
  await env.OAUTH_KV.put(dedupe, '1', { expirationTtl: TTL_SECONDS });
  const failed = body.code !== 'rendered';
  const aggregateKey = healthKey(now) + (failed ? ':failed' : ':rendered');
  let health = emptyHealth();
  try { const raw = await env.OAUTH_KV.get(aggregateKey); if (raw) health = JSON.parse(raw); } catch { /* fresh aggregate */ }
  health.rendered += failed ? 0 : 1;
  health.failed += failed ? 1 : 0;
  if (failed) { health.latest_failure_at = new Date(now).toISOString(); health.latest_failure_code = body.code; }
  await env.OAUTH_KV.put(aggregateKey, JSON.stringify(health), { expirationTtl: 10_800 });
  report({ code: body.code, protocol: body.protocol, failed });
  return response(204);
}
