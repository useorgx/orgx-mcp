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
 *   6. filter `tools/list` and refuse `tools/call` outside the run's grant
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

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown };

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
  const grant = payload.conns[connectionId];
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

  // 6a. Inspect a POST body: refuse tools/call outside policy before it leaves.
  let body: string | undefined;
  let messages: JsonRpcMessage[] = [];
  if (request.method === 'POST') {
    body = await request.text();
    if (body.length > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' });
    try {
      const parsed = JSON.parse(body) as unknown;
      messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[];
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const calls = messages.filter((m) => m && m.method === 'tools/call');
    if (calls.length) {
      const catalog = await toolCatalog(upstream);
      const refused: Array<{ id: JsonRpcMessage['id']; result: Record<string, unknown> }> = [];
      for (const call of calls) {
        const name = typeof call.params?.name === 'string' ? call.params.name : '';
        const decision = decideTool(name, catalog?.get(name), grant, upstream.policy);
        if (!decision.allow) {
          refused.push({ id: call.id ?? null, result: refusedCallResult(name, decision) });
          log({ ...who, method: 'tools/call', tool: name, status: 200, decision: decision.code, duration_ms: now() - started });
        }
      }
      if (refused.length) {
        // A batch is refused as a whole: every request in it gets an answer.
        const answers = messages
          .filter((m) => m && m.id !== undefined && m.method)
          .map((m) => {
            const own = refused.find((r) => r.id === m.id);
            return {
              jsonrpc: '2.0',
              id: m.id,
              result: own?.result ?? refusedCallResult(String(m.method), { allow: false, code: 'not_allowed', risk: null }),
            };
          });
        return json(200, Array.isArray(JSON.parse(body)) ? answers : answers[0]);
      }
    }
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
        response = await send(upstream);
      }
    }
  } catch {
    log({ ...who, method: methodsOf(messages), status: 502, reason: 'upstream_unreachable', duration_ms: now() - started });
    return json(502, { error: 'upstream_unreachable' });
  }
  if (response.status === 401 || response.status === 403) {
    // Never hand the vendor's auth challenge to the harness: it would start
    // an OAuth flow against the vendor with OrgX's connection.
    log({ ...who, method: methodsOf(messages), status: 502, reason: `vendor_${response.status}`, duration_ms: now() - started });
    return json(502, {
      error: 'vendor_auth_failed',
      message: 'The vendor refused OrgX’s credential for this connection. Reconnect it in OrgX.',
    });
  }

  // 6b. Filter tools/list results, in JSON and in SSE.
  const filterTools = (message: unknown) => {
    const m = message as JsonRpcMessage;
    const result = m?.result as { tools?: unknown } | undefined;
    if (!result || !Array.isArray(result.tools)) return message;
    toolCache.remember(catalogKey, result.tools, now(), true);
    return { ...m, result: { ...result, tools: filterToolList(result.tools, grant, (upstream as BrokerUpstream).policy) } };
  };
  const headers = new Headers();
  for (const name of RETURN_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const contentType = response.headers.get('content-type') ?? '';
  let outBody: BodyInit | null = response.body;
  if (response.body && contentType.includes('text/event-stream')) {
    outBody = rewriteSseStream(response.body, filterTools);
  } else if (response.body && contentType.includes('application/json')) {
    const text = await response.text();
    try {
      outBody = JSON.stringify(rewriteJsonRpc(JSON.parse(text), filterTools));
    } catch {
      outBody = text;
    }
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
      const found = (res.headers.get('content-type') ?? '').includes('text/event-stream')
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
