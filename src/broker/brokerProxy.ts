/**
 * The OrgX MCP broker: a pass-through Streamable HTTP route,
 *
 *   https://mcp.useorgx.com/c/<connectionId>[/<variant>]
 *   Authorization: Bearer oxrun2.<payload>.<sig>   (audience orgx-broker)
 *
 * so a harness (Claude Code, Codex, Cursor, OpenClaw, the Anthropic and
 * OpenAI MCP connectors) reaches a workspace's vendor MCP server while only
 * ever holding a short-lived, run-scoped OrgX token. Per request:
 *
 *   1. verify the broker token: signature, audience, expiry, run binding, and
 *      that `conns` names this connection;
 *   2. ask the app whether the run is still active (cached a few seconds);
 *      refuse once it has ended or the token's jti was revoked;
 *   3. get the connection's upstream from the app: vendor URL and auth
 *      headers, the vendor token refreshed server-side under a lock;
 *   4. forward, with vendor scoping (GitHub toolsets / readonly) already in
 *      the upstream; on a vendor 401, force one refresh and retry;
 *   5. pass `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID` and SSE
 *      streams through unchanged, so sessions and resumability work;
 *   6. forward only the tool surface (`initialize`, `ping`, `tools/list`,
 *      `tools/call`, client notifications and replies to server requests),
 *      filter `tools/list` and refuse `tools/call` outside the run's grant
 *      and the person's connector permissions (see brokerPolicy.ts);
 *   7. log metadata only: connection, method, tool, status, duration. Never
 *      a payload, a header value or a token.
 */

import { validateMcpRequestOrigin, type McpOriginValidationEnv } from '../mcpOriginValidation';
import { withSecurityHeaders } from '../securityHeaders';
import {
  BrokerAppClient,
  isAppError,
  type BrokerAppCache,
  type BrokerAppEnv,
  type BrokerUpstream,
} from './brokerAppClient';
import { decideTool, filterToolList, refusedCallResult, ToolCatalogCache, type McpTool } from './brokerPolicy';
import { brokerTokenSecret, verifyBrokerToken, type BrokerTokenPayload } from './brokerToken';
import { parseSseMessages, rewriteJsonRpc, rewriteSseStream } from './sseRewrite';

export type BrokerEnv = BrokerAppEnv &
  McpOriginValidationEnv & {
    ORGX_RUN_MCP_TOKEN_SECRET?: string;
    /** `off` refuses every broker request (kill switch). */
    ORGX_MCP_BROKER?: string;
  };

export interface BrokerDeps {
  /** Upstream (vendor) fetch. */
  fetch?: typeof fetch;
  /** App fetch; defaults to `fetch`. */
  appFetch?: typeof fetch;
  now?: () => number;
  appCache?: BrokerAppCache;
  toolCache?: ToolCatalogCache;
  log?: (entry: Record<string, unknown>) => void;
}

const ROUTE = /^\/c\/([A-Za-z0-9_-]{1,80})(?:\/([a-z0-9_,/-]{1,120}))?\/?$/;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FORWARD_REQUEST_HEADERS = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const RETURN_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control'];
const isolateToolCache = new ToolCatalogCache();
/** Requests the gateway forwards; plus `notifications/*` and replies (no `method`). */
const FORWARDED_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown };
type Refusal = {
  message: JsonRpcMessage;
  answer: { result: Record<string, unknown> } | { error: { code: number; message: string } };
};

function isMessageObject(value: unknown): value is JsonRpcMessage {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Exact method names only; anything else never reaches the vendor. */
function forwardable(message: JsonRpcMessage): boolean {
  if (!Object.hasOwn(message, 'method')) return true; // a reply to a server request
  const method = message.method;
  return typeof method === 'string' && (FORWARDED_METHODS.has(method) || method.startsWith('notifications/'));
}

/** `type/subtype`, lowercased, without parameters. */
function mediaType(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
    })
  );
}

function unauthorized(reason: string): Response {
  return json(
    401,
    { error: 'invalid_token', reason },
    { 'www-authenticate': `Bearer realm="orgx-broker", error="invalid_token"` }
  );
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  return header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() || null : null;
}

function defaultLog(entry: Record<string, unknown>) {
  console.info('[mcp-broker]', JSON.stringify(entry));
}

/** Handle `/c/...`; null for every other path. */
export async function handleBrokerRequest(
  request: Request,
  env: BrokerEnv,
  deps: BrokerDeps = {}
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/c/')) return null;
  const route = ROUTE.exec(url.pathname);
  if (!route) return json(404, { error: 'not_found' });
  const [, connectionId, variant = null] = route;
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? defaultLog;
  const base = { connection: connectionId, http_method: request.method };

  if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
    return json(405, { error: 'method_not_allowed' }, { allow: 'GET, POST, DELETE' });
  }
  const invalidOrigin = validateMcpRequestOrigin(request, env);
  if (invalidOrigin) return withSecurityHeaders(invalidOrigin);
  if (env.ORGX_MCP_BROKER?.trim().toLowerCase() === 'off') {
    return json(503, { error: 'broker_disabled' });
  }
  const secret = brokerTokenSecret(env);
  if (!secret || !env.ORGX_BROKER_SERVICE_KEY) return json(503, { error: 'broker_unconfigured' });

  // 1. The token, and this connection in it.
  const token = bearer(request);
  const verified = await verifyBrokerToken(token, secret, now());
  if (!verified.ok) {
    log({ ...base, status: 401, reason: verified.reason, duration_ms: now() - started });
    return unauthorized(verified.reason);
  }
  const payload = verified.payload;
  const grant = Object.hasOwn(payload.conns, connectionId) ? payload.conns[connectionId] : undefined;
  const who = { ...base, wid: payload.wid, rid: payload.rid };
  if (!grant) {
    log({ ...who, status: 403, reason: 'connection_not_granted', duration_ms: now() - started });
    return json(403, { error: 'connection_not_granted' });
  }

  const app = new BrokerAppClient(env, { fetch: deps.appFetch ?? deps.fetch, now, cache: deps.appCache });

  // 2. The run is still active.
  const status = await app.runStatus(token as string, payload);
  if (isAppError(status) || !status.active) {
    const reason = isAppError(status) ? status.error : status.reason;
    const code = isAppError(status) ? status.status : 403;
    log({ ...who, status: code, reason, duration_ms: now() - started });
    return json(code, { error: isAppError(status) ? reason : 'run_inactive', reason });
  }

  // 3. The vendor upstream.
  let upstream = await app.upstream(token as string, payload, connectionId, variant);
  if (isAppError(upstream)) {
    log({ ...who, status: upstream.status, reason: upstream.error, duration_ms: now() - started });
    return json(upstream.status, { error: upstream.error });
  }

  const toolCache = deps.toolCache ?? isolateToolCache;
  const catalogKey = `${payload.jti}|${connectionId}|${variant ?? ''}`;
  const forwardHeaders = (up: BrokerUpstream) => {
    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(up.headers)) headers.set(name, value);
    headers.set('user-agent', 'orgx-mcp-broker/1');
    return headers;
  };
  const upstreamFetch = deps.fetch ?? fetch;

  // 6a. Inspect a POST body: refuse other methods, and tools/call outside
  // policy, before anything leaves.
  let body: string | undefined;
  let messages: JsonRpcMessage[] = [];
  let isBatch = false;
  /** A batch is refused as a whole: every request in it gets an answer. */
  const refuse = (refused: Refusal[]): Response => {
    const answers = messages
      .filter((m) => m.id !== undefined && m.method !== undefined)
      .map((m) => ({
        jsonrpc: '2.0',
        id: m.id,
        ...(refused.find((r) => r.message === m)?.answer ?? {
          result: refusedCallResult(String(m.method), { allow: false, code: 'not_allowed', risk: null }),
        }),
      }));
    // Only notifications in it: nothing to answer, nothing was sent.
    if (answers.length === 0) return withSecurityHeaders(new Response(null, { status: 202 }));
    return json(200, isBatch ? answers : answers[0]);
  };
  /** Decide every tools/call in the body against `up`'s policy; a refusal, or null. */
  const refuseCalls = async (up: BrokerUpstream): Promise<Response | null> => {
    const calls = messages.filter((m) => m.method === 'tools/call');
    if (!calls.length) return null;
    const catalog = await toolCatalog(up);
    const refused: Refusal[] = [];
    for (const call of calls) {
      const name = typeof call.params?.name === 'string' ? call.params.name : '';
      const decision = decideTool(name, catalog?.get(name), grant, up.policy);
      if (!decision.allow) {
        refused.push({ message: call, answer: { result: refusedCallResult(name, decision) } });
        log({ ...who, method: 'tools/call', tool: name, status: 200, decision: decision.code, duration_ms: now() - started });
      }
    }
    return refused.length ? refuse(refused) : null;
  };
  if (request.method === 'POST') {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    isBatch = Array.isArray(parsed);
    const elements: unknown[] = isBatch ? (parsed as unknown[]) : [parsed];
    // Every element an object: no nested batches, no bare values.
    if (!elements.every(isMessageObject)) {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    messages = elements;
    // Forward what was decided on, never the raw text: with duplicate keys a
    // first-key-wins vendor parser could read another method or tool.
    body = JSON.stringify(parsed);
    const unavailable = messages.filter((m) => !forwardable(m));
    if (unavailable.length) {
      for (const m of unavailable) {
        log({ ...who, method: String(m.method).slice(0, 80), status: 200, decision: 'method_not_available', duration_ms: now() - started });
      }
      return refuse(
        unavailable.map((message) => ({
          message,
          answer: { error: { code: -32601, message: 'Method not available through the OrgX broker' } },
        }))
      );
    }
    const refused = await refuseCalls(upstream);
    if (refused) return refused;
  }

  // 4. Forward; a vendor 401 forces one refresh and one retry.
  const send = (up: BrokerUpstream) =>
    upstreamFetch(up.url, { method: request.method, headers: forwardHeaders(up), body });
  let response: Response;
  try {
    response = await send(upstream);
    if (response.status === 401) {
      app.forget(payload, connectionId, variant);
      const refreshed = await app.upstream(token as string, payload, connectionId, variant, true);
      if (!isAppError(refreshed)) {
        upstream = refreshed;
        // The refreshed upstream carries the current policy: decide again.
        const refusedNow = await refuseCalls(upstream);
        if (refusedNow) return refusedNow;
        response = await send(upstream);
      }
    }
  } catch {
    log({ ...who, method: methodsOf(messages), status: 503, reason: 'upstream_unreachable', duration_ms: now() - started });
    return json(503, { error: 'upstream_unreachable' });
  }
  if (response.status === 401 || response.status === 403) {
    // Never hand the vendor's auth challenge to the harness: it would start
    // an OAuth flow against the vendor with OrgX's connection.
    log({ ...who, method: methodsOf(messages), status: 424, reason: `vendor_${response.status}`, duration_ms: now() - started });
    return json(424, {
      error: 'vendor_auth_failed',
      message: 'The vendor refused OrgX’s credential for this connection. Reconnect it in OrgX.',
    });
  }

  // 6b. Filter tools/list results, in JSON and in SSE. Annotations are
  // learned only from the reply to a tools/list this request forwarded.
  const listIds = messages.filter((m) => m.method === 'tools/list' && m.id !== undefined && m.id !== null).map((m) => m.id);
  const filterTools = (message: unknown) => {
    const m = message as JsonRpcMessage;
    const result = m?.result as { tools?: unknown } | undefined;
    if (!result || !Array.isArray(result.tools)) return message;
    if (!Object.hasOwn(m, 'method') && listIds.includes(m.id)) {
      toolCache.remember(catalogKey, result.tools, now(), true);
    }
    return { ...m, result: { ...result, tools: filterToolList(result.tools, grant, (upstream as BrokerUpstream).policy) } };
  };
  // A tools/list answer the broker cannot read is never passed through.
  const mustFilter = response.ok && listIds.length > 0;
  const unfilterable = () => {
    log({ ...who, method: methodsOf(messages), status: 502, reason: 'unfilterable_tools_list', duration_ms: now() - started });
    return json(502, {
      jsonrpc: '2.0',
      id: isBatch ? null : (messages[0]?.id ?? null),
      error: { code: -32603, message: 'The vendor answered tools/list in a form the OrgX broker cannot filter' },
    });
  };
  const headers = new Headers();
  for (const name of RETURN_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const contentType = mediaType(response.headers);
  let outBody: BodyInit | null = response.body;
  if (response.body && contentType === 'text/event-stream') {
    outBody = rewriteSseStream(response.body, filterTools);
  } else if (response.body && contentType === 'application/json') {
    const text = await response.text();
    try {
      outBody = JSON.stringify(rewriteJsonRpc(JSON.parse(text), filterTools));
    } catch {
      if (mustFilter) return unfilterable();
      outBody = text;
    }
  } else if (response.body && mustFilter) {
    return unfilterable();
  }

  // 7. Metadata only.
  for (const message of messages.length ? messages : [{} as JsonRpcMessage]) {
    log({
      ...who,
      catalog: upstream.catalogId,
      method: message.method ?? (request.method === 'GET' ? 'stream' : request.method === 'DELETE' ? 'session/delete' : 'response'),
      ...(message.method === 'tools/call' && typeof message.params?.name === 'string' ? { tool: message.params.name } : {}),
      status: response.status,
      duration_ms: now() - started,
    });
  }
  return withSecurityHeaders(new Response(outBody, { status: response.status, headers }));

  /** The connection's tools with annotations: cached, else asked once. */
  async function toolCatalog(up: BrokerUpstream): Promise<Map<string, McpTool> | null> {
    const cached = toolCache.get(catalogKey, now());
    if (cached) return cached;
    const headers = forwardHeaders(up);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    headers.delete('last-event-id');
    let cursor: string | undefined;
    const tools: unknown[] = [];
    for (let page = 0; page < 5; page += 1) {
      let res: Response;
      try {
        res = await upstreamFetch(up.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: `orgx-broker-tools-${page}`, method: 'tools/list', params: cursor ? { cursor } : {} }),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      const text = await res.text();
      const found = mediaType(res.headers) === 'text/event-stream'
        ? parseSseMessages(text)
        : (() => {
            try {
              const parsed = JSON.parse(text) as unknown;
              return Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              return [];
            }
          })();
      const result = (found as JsonRpcMessage[]).find((m) => m?.id === `orgx-broker-tools-${page}`)?.result as
        | { tools?: unknown[]; nextCursor?: string }
        | undefined;
      if (!result?.tools) return null;
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    toolCache.remember(catalogKey, tools, now());
    return toolCache.get(catalogKey, now());
  }
}

function methodsOf(messages: JsonRpcMessage[]): string {
  return messages.map((m) => m?.method ?? 'response').join(',') || 'none';
}

export type { BrokerTokenPayload };
