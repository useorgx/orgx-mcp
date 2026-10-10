/**
 * Widget UX telemetry: how the OrgX panel behaves inside a host.
 *
 * The widget runs in a host's sandbox and cannot reach PostHog or Sentry
 * itself (its CSP allows only this origin), so it posts a small, bounded
 * batch of events here and the worker forwards them. The channel is the
 * same shape as the search widget's diagnostics: a signed, short-lived grant
 * travels in the panel tool's result `_meta`, and only a request carrying a
 * valid grant is accepted. The grant names the viewer and workspace the
 * panel was read for, so events land on the same PostHog person as the
 * tool calls that produced them; the widget never sees those ids as data it
 * can change.
 *
 * Closed schema: event names, property keys and string values are all from
 * fixed lists here, numbers are bounded, and anything else is dropped before
 * it is reported. Decision titles, receipt text, prompts and error messages
 * never travel on this channel.
 */

export const WIDGET_TELEMETRY_PATH = '/telemetry/widget';
export const WIDGET_TELEMETRY_META_KEY = 'orgx/widgetTelemetry';
const AUDIENCE = 'orgx-widget-telemetry';
/** A grant lives as long as a panel session plausibly does; every snapshot read carries a fresh one. */
const TTL_SECONDS = 4 * 3600;
const MAX_BODY_BYTES = 8192;
const MAX_EVENTS_PER_BATCH = 25;
const MAX_EVENTS_PER_GRANT = 400;
const MAX_NUMBER = 10_000_000;
const MAX_STRING = 48;
const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,47}$/i;
/** Keys with a fixed type; a label where a number belongs is dropped, not kept. */
const BOOLEAN_KEYS = new Set(['cold', 'warm', 'ok', 'agent_picked']);
const NUMBER_KEYS = new Set(['ttfc_ms', 'latency_ms', 'step_index']);

export const WIDGET_IDS = ['orgx-panel'] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

/** Event name → the property keys it may carry. Everything else is dropped. */
export const WIDGET_EVENTS: Record<string, readonly string[]> = {
  panel_opened: ['host', 'platform', 'display_mode', 'safe_source', 'cold', 'ttfc_ms'],
  panel_tab_switched: ['panel_from_tab', 'panel_tab', 'latency_ms', 'warm'],
  panel_read: ['panel_read_kind', 'panel_trigger', 'latency_ms', 'ok', 'error_code'],
  panel_decision: ['panel_decision_action', 'panel_outcome', 'latency_ms', 'ok', 'error_code'],
  panel_start_sent: ['panel_verb', 'agent_picked', 'panel_outcome'],
  panel_workspace_switched: ['ok', 'latency_ms', 'error_code'],
  panel_error: ['panel_error_code', 'panel_read_kind', 'error_code'],
  panel_tour: ['panel_tour_outcome', 'step_index'],
};

export type WidgetTelemetryGrant = {
  version: 1;
  audience: typeof AUDIENCE;
  widget: WidgetId;
  nonce: string;
  exp: number;
  /** The viewer the panel was read for; the PostHog distinct id. */
  sub?: string;
  /** The workspace the panel was read for. */
  wid?: string;
};

export type WidgetTelemetryEvent = {
  name: string;
  properties: Record<string, string | number | boolean>;
};

export type WidgetTelemetryReport = {
  widget: WidgetId;
  protocol: string;
  subject: string | null;
  workspaceId: string | null;
  events: WidgetTelemetryEvent[];
};

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
export interface WidgetTelemetryEnv {
  MCP_JWT_SECRET?: string;
  MCP_SERVER_URL?: string;
  OAUTH_KV?: KvLike;
}

const PROTOCOLS = new Set(['chatgpt', 'mcp-apps', 'mcp-apps-sdk', 'standalone']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function key(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** The `_meta` the panel tool attaches to its result: where to post, and the grant to post with. */
export async function buildWidgetTelemetryContext(
  env: WidgetTelemetryEnv,
  params: { widget: WidgetId; userId?: string | null; workspaceId?: string | null },
  now = Date.now()
): Promise<{ endpoint: string; grant: string } | null> {
  if (!env.MCP_JWT_SECRET || !env.MCP_SERVER_URL || !env.OAUTH_KV) return null;
  const origin = new URL(env.MCP_SERVER_URL).origin;
  const grant: WidgetTelemetryGrant = {
    version: 1,
    audience: AUDIENCE,
    widget: params.widget,
    nonce: crypto.randomUUID(),
    exp: Math.floor(now / 1000) + TTL_SECONDS,
    ...(params.userId ? { sub: params.userId } : {}),
    ...(params.workspaceId && UUID.test(params.workspaceId) ? { wid: params.workspaceId } : {}),
  };
  const payload = encode(new TextEncoder().encode(JSON.stringify(grant)));
  const signature = await crypto.subtle.sign('HMAC', await key(env.MCP_JWT_SECRET), new TextEncoder().encode(payload));
  return { endpoint: origin + WIDGET_TELEMETRY_PATH, grant: payload + '.' + encode(new Uint8Array(signature)) };
}

async function verifyGrant(env: WidgetTelemetryEnv, value: string, now: number): Promise<WidgetTelemetryGrant | null> {
  try {
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) return null;
    const verified = await crypto.subtle.verify('HMAC', await key(env.MCP_JWT_SECRET!), decode(signature), new TextEncoder().encode(payload));
    if (!verified) return null;
    const grant = JSON.parse(new TextDecoder().decode(decode(payload))) as WidgetTelemetryGrant;
    if (grant.version !== 1 || grant.audience !== AUDIENCE || !(WIDGET_IDS as readonly string[]).includes(grant.widget) ||
        typeof grant.nonce !== 'string' || !Number.isFinite(grant.exp) ||
        grant.exp <= now / 1000 || grant.exp > now / 1000 + TTL_SECONDS + 1) return null;
    return grant;
  } catch {
    return null;
  }
}

/** One event as the widget sent it, reduced to the closed schema; null when its name is unknown. */
export function boundWidgetEvent(raw: unknown): WidgetTelemetryEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { name, props } = raw as { name?: unknown; props?: unknown };
  if (typeof name !== 'string' || !WIDGET_EVENTS[name]) return null;
  const allowed = WIDGET_EVENTS[name];
  const properties: Record<string, string | number | boolean> = {};
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (!allowed.includes(k)) continue;
      if (BOOLEAN_KEYS.has(k)) { if (typeof v === 'boolean') properties[k] = v; }
      else if (NUMBER_KEYS.has(k)) { if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_NUMBER) properties[k] = Math.round(v); }
      else if (typeof v === 'string' && v.length <= MAX_STRING && TOKEN.test(v)) properties[k] = v;
    }
  }
  return { name, properties };
}

/**
 * POST {grant, protocol, events:[{name, props}]} → 204. Rejects anything
 * outside the schema without reporting it, bounds the body and the count of
 * events a grant may send, and never offers a read.
 */
export async function handleWidgetTelemetry(
  request: Request,
  env: WidgetTelemetryEnv,
  report: (report: WidgetTelemetryReport) => void,
  now = Date.now()
): Promise<Response | null> {
  if (new URL(request.url).pathname !== WIDGET_TELEMETRY_PATH) return null;
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
  // A keepalive flush from a closing page may arrive as text/plain; the body is still JSON.
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^(application\/json|text\/plain)/.test(contentType)) return response(415);
  const reader = request.body?.getReader();
  if (!reader) return response(400);
  let bytes = new Uint8Array();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (bytes.length + chunk.value.length > MAX_BODY_BYTES) { await reader.cancel(); return response(413); }
    const joined = new Uint8Array(bytes.length + chunk.value.length);
    joined.set(bytes); joined.set(chunk.value, bytes.length); bytes = joined;
  }
  let body: { grant?: unknown; protocol?: unknown; events?: unknown };
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return response(400); }
  if (!body || typeof body !== 'object' || Object.keys(body).some((k) => !['grant', 'protocol', 'events'].includes(k)) ||
      typeof body.grant !== 'string' || typeof body.protocol !== 'string' || !PROTOCOLS.has(body.protocol) ||
      !Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS_PER_BATCH) return response(400);
  const grant = await verifyGrant(env, body.grant, now);
  if (!grant) return response(401);
  const events = body.events.map(boundWidgetEvent).filter((e): e is WidgetTelemetryEvent => e !== null);
  if (!events.length) return response(400);
  // A grant may send only so much. KV is not atomic; this is a ceiling, not a meter.
  const countKey = `widget-telemetry:count:${grant.nonce}`;
  let count = 0;
  try { count = Number((await env.OAUTH_KV.get(countKey)) ?? 0) || 0; } catch { count = 0; }
  if (count >= MAX_EVENTS_PER_GRANT) return response(429);
  await env.OAUTH_KV.put(countKey, String(count + events.length), { expirationTtl: TTL_SECONDS });
  report({
    widget: grant.widget,
    protocol: body.protocol,
    subject: typeof grant.sub === 'string' && grant.sub ? grant.sub : null,
    workspaceId: typeof grant.wid === 'string' && UUID.test(grant.wid) ? grant.wid : null,
    events,
  });
  return response(204);
}
