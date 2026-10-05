import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrokerAppCache } from '../src/broker/brokerAppClient';
import { classifyTool, decideTool, ToolCatalogCache } from '../src/broker/brokerPolicy';
import { handleBrokerRequest, type BrokerEnv } from '../src/broker/brokerProxy';
import { verifyBrokerToken } from '../src/broker/brokerToken';
import { rewriteSseStream } from '../src/broker/sseRewrite';

const SECRET = 'r'.repeat(48);
const NOW = 1_800_000_000_000;
const CONN = 'bnd_44444444-4444-4444-8444-444444444444';
const VENDOR_URL = 'https://mcp.vendor.example/mcp';
const VENDOR_TOKEN = 'vendor-access-token-1';
const REFRESHED_TOKEN = 'vendor-access-token-2';

const env: BrokerEnv = {
  ORGX_RUN_MCP_TOKEN_SECRET: SECRET,
  ORGX_BROKER_SERVICE_KEY: 'oxk-broker-key-for-tests-only-000000000000',
  ORGX_API_URL: 'https://app.test',
  MCP_SERVER_URL: 'https://mcp.useorgx.com',
  ORGX_WEB_URL: 'https://useorgx.com',
};

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mint(overrides: Record<string, unknown> = {}, secret = SECRET) {
  const payload = {
    v: 2,
    iss: 'orgx-run-mcp',
    aud: 'orgx-broker',
    uid: 'user-1',
    wid: 'ws-1',
    rid: 'run-1',
    jti: `jti-${Math.random()}`,
    iat: NOW / 1000,
    exp: NOW / 1000 + 600,
    conns: { [CONN]: {} },
    ...overrides,
  };
  const body = `oxrun2.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;
}

const TOOLS = [
  { name: 'list_issues', annotations: { readOnlyHint: true } },
  { name: 'create_issue', annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'delete_repo', annotations: { destructiveHint: true } },
  { name: 'mystery' },
];

type AppState = { active: boolean; reason?: string; refreshes: number; calls: string[]; policy?: unknown };

function appFetch(state: AppState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${env.ORGX_BROKER_SERVICE_KEY}`);
    expect(typeof body.run_token).toBe('string');
    if (url.endsWith('/run-status')) {
      state.calls.push('run-status');
      return Response.json({ active: state.active, reason: state.reason, cache_ttl_seconds: 5 });
    }
    state.calls.push(body.force_refresh ? 'vendor-token:force' : 'vendor-token');
    if (body.force_refresh) state.refreshes += 1;
    return Response.json({
      connection_id: body.connection_id,
      catalog_id: 'github',
      upstream: {
        url: VENDOR_URL,
        headers: { Authorization: `Bearer ${state.refreshes ? REFRESHED_TOKEN : VENDOR_TOKEN}`, 'X-MCP-Toolsets': 'repos' },
      },
      policy: state.policy ?? { groups: { low: 'allow', key: 'ask', high: 'ask' }, tools: {} },
      cache_ttl_seconds: 60,
    });
  });
}

/** A mock vendor MCP: JSON or SSE responses, a session id, auth checking. */
function vendor(opts: { sse?: boolean; acceptToken?: string } = {}) {
  const seen: Array<{ method: string; headers: Headers; body: string | undefined }> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = init?.body as string | undefined;
    seen.push({ method: init?.method ?? 'GET', headers, body });
    expect(String(input)).toBe(VENDOR_URL);
    if (headers.get('authorization') !== `Bearer ${opts.acceptToken ?? VENDOR_TOKEN}`) {
      return new Response('{"error":"invalid_token"}', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://vendor/.well-known"' },
      });
    }
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response('id: 7\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n', {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' },
      });
    }
    const message = JSON.parse(body ?? '{}');
    const reply =
      message.method === 'tools/list'
        ? { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } }
        : message.method === 'tools/call'
          ? { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'customer row: secret-payload' }] } }
          : { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {} } };
    if (opts.sse) {
      return new Response(`id: evt-1\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`, {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' },
      });
    }
    return Response.json(reply, { headers: { 'mcp-session-id': 'sess-1', 'set-cookie': 'vendor=1' } });
  });
  return { fetchFn, seen };
}

function call(token: string | null, body?: unknown, init: { method?: string; path?: string; headers?: Record<string, string> } = {}) {
  return new Request(`https://mcp.useorgx.com${init.path ?? `/c/${CONN}`}`, {
    method: init.method ?? 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(init.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let state: AppState;
let logs: Array<Record<string, unknown>>;
let deps: Parameters<typeof handleBrokerRequest>[2];

function setup(vendorOpts: Parameters<typeof vendor>[0] = {}) {
  const v = vendor(vendorOpts);
  deps = {
    fetch: v.fetchFn as unknown as typeof fetch,
    appFetch: appFetch(state) as unknown as typeof fetch,
    now: () => NOW,
    appCache: createBrokerAppCache(),
    toolCache: new ToolCatalogCache(),
    log: (entry) => logs.push(entry),
  };
  return v;
}

beforeEach(() => {
  state = { active: true, refreshes: 0, calls: [] };
  logs = [];
});

describe('routing', () => {
  it('ignores every path outside /c/', async () => {
    setup();
    expect(await handleBrokerRequest(new Request('https://mcp.useorgx.com/mcp'), env, deps)).toBeNull();
  });

  it('is off without the dedicated secret or the broker key, and with the kill switch', async () => {
    setup();
    const res1 = await handleBrokerRequest(call(mint(), {}), { ...env, ORGX_RUN_MCP_TOKEN_SECRET: undefined }, deps);
    expect(res1?.status).toBe(503);
    const res2 = await handleBrokerRequest(call(mint(), {}), { ...env, ORGX_BROKER_SERVICE_KEY: undefined }, deps);
    expect(res2?.status).toBe(503);
    const res3 = await handleBrokerRequest(call(mint(), {}), { ...env, ORGX_MCP_BROKER: 'off' }, deps);
    expect(res3?.status).toBe(503);
  });
});

describe('token checks', () => {
  it('refuses an expired token', async () => {
    const v = setup();
    const res = (await handleBrokerRequest(call(mint({ exp: NOW / 1000 - 1 }), {}), env, deps))!;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token', reason: 'expired' });
    expect(v.fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a token for the wrong audience (an OrgX MCP token)', async () => {
    setup();
    const res = (await handleBrokerRequest(call(mint({ aud: 'orgx-mcp', scp: [] }), {}), env, deps))!;
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('wrong_audience');
  });

  it('refuses a token signed with another secret, or none at all', async () => {
    setup();
    expect((await handleBrokerRequest(call(mint({}, 'x'.repeat(48)), {}), env, deps))!.status).toBe(401);
    const none = (await handleBrokerRequest(call(null, {}), env, deps))!;
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('orgx-broker');
  });

  it('refuses a connection the token does not name', async () => {
    const v = setup();
    const res = (await handleBrokerRequest(call(mint({ conns: { bnd_other: {} } }), {}), env, deps))!;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'connection_not_granted' });
    expect(state.calls).toEqual([]);
    expect(v.fetchFn).not.toHaveBeenCalled();
  });

  it('verifies tokens with an unbound or malformed body as invalid', async () => {
    expect(await verifyBrokerToken(mint({ rid: '' }), SECRET, NOW)).toEqual({ ok: false, reason: 'invalid_claims' });
    expect(await verifyBrokerToken('oxrun2.only-two', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('run state', () => {
  it('refuses once the run has ended', async () => {
    state.active = false;
    state.reason = 'run_ended';
    const v = setup();
    const res = (await handleBrokerRequest(call(mint(), { jsonrpc: '2.0', id: 1, method: 'tools/list' }), env, deps))!;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'run_inactive', reason: 'run_ended' });
    expect(v.fetchFn).not.toHaveBeenCalled();
  });

  it('caches the run status for a few seconds per token', async () => {
    setup();
    const token = mint();
    await handleBrokerRequest(call(token, { jsonrpc: '2.0', id: 1, method: 'initialize' }), env, deps);
    await handleBrokerRequest(call(token, { jsonrpc: '2.0', id: 2, method: 'ping' }), env, deps);
    expect(state.calls.filter((c) => c === 'run-status')).toHaveLength(1);
    expect(state.calls.filter((c) => c === 'vendor-token')).toHaveLength(1);
  });

  it('fails closed when the app cannot be reached', async () => {
    const v = setup();
    deps!.appFetch = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const res = (await handleBrokerRequest(call(mint(), {}), env, deps))!;
    expect(res.status).toBe(503);
    expect(v.fetchFn).not.toHaveBeenCalled();
  });
});

describe('happy path proxy against a mock vendor MCP', () => {
  it('forwards with the vendor credential, passes the session through, never forwards the run token', async () => {
    const v = setup();
    const token = mint();
    const res = (await handleBrokerRequest(
      call(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
        headers: { 'mcp-session-id': 'sess-1', 'mcp-protocol-version': '2025-06-18' },
      }),
      env,
      deps
    ))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe('sess-1');
    expect(res.headers.get('set-cookie')).toBeNull();
    const sent = v.seen[0].headers;
    expect(sent.get('authorization')).toBe(`Bearer ${VENDOR_TOKEN}`);
    expect(sent.get('x-mcp-toolsets')).toBe('repos');
    expect(sent.get('mcp-session-id')).toBe('sess-1');
    expect(sent.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(JSON.stringify([...sent.entries()])).not.toContain(token);
  });

  it('passes SSE through with event ids, and Last-Event-ID upstream on resume', async () => {
    const v = setup({ sse: true });
    const res = (await handleBrokerRequest(
      call(mint(), undefined, { method: 'GET', headers: { 'last-event-id': '6', accept: 'text/event-stream' } }),
      env,
      deps
    ))!;
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('id: 7\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n');
    expect(v.seen[0].headers.get('last-event-id')).toBe('6');
  });

  it('filters tools/list in JSON and SSE responses', async () => {
    for (const sse of [false, true]) {
      setup({ sse });
      const res = (await handleBrokerRequest(call(mint(), { jsonrpc: '2.0', id: 1, method: 'tools/list' }), env, deps))!;
      const text = await res.text();
      const message = sse ? JSON.parse(text.split('data: ')[1]) : JSON.parse(text);
      if (sse) expect(text.startsWith('id: evt-1\nevent: message\n')).toBe(true);
      const names = message.result.tools.map((t: { name: string }) => t.name);
      // key/high default to ask: listed, marked as needing approval.
      expect(names).toEqual(['list_issues', 'create_issue', 'delete_repo', 'mystery']);
      expect(message.result.tools[2]._meta['orgx/broker']).toEqual({ approval: 'required', risk: 'high' });
    }
  });

  it('hides tools outside a read-only grant or an allowlist', async () => {
    setup();
    const ro = (await handleBrokerRequest(call(mint({ conns: { [CONN]: { ro: true } } }), { jsonrpc: '2.0', id: 1, method: 'tools/list' }), env, deps))!;
    expect((await ro.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(['list_issues']);
    setup();
    const allow = (await handleBrokerRequest(call(mint({ conns: { [CONN]: { tools: ['create_issue'] } } }), { jsonrpc: '2.0', id: 1, method: 'tools/list' }), env, deps))!;
    expect((await allow.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(['create_issue']);
  });

  it('runs an allowed read tool', async () => {
    const v = setup();
    const res = (await handleBrokerRequest(
      call(mint(), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_issues', arguments: {} } }),
      env,
      deps
    ))!;
    expect((await res.json()).result.content[0].text).toContain('customer row');
    // One tools/list to learn annotations, then the call.
    expect(v.seen.map((s) => JSON.parse(s.body ?? '{}').method)).toEqual(['tools/list', 'tools/call']);
  });
});

describe('tool policy on calls', () => {
  it('refuses a tool not allowed, without reaching the vendor', async () => {
    const v = setup();
    const res = (await handleBrokerRequest(
      call(mint({ conns: { [CONN]: { tools: ['list_issues'] } } }), {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'delete_repo', arguments: {} },
      }),
      env,
      deps
    ))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(9);
    expect(body.result.isError).toBe(true);
    expect(body.result._meta['orgx/broker'].code).toBe('not_allowed');
    expect(v.seen.map((s) => JSON.parse(s.body ?? '{}').method)).not.toContain('tools/call');
  });

  it('refuses a high-risk call with a clear "needs approval" result unless the grant allows it', async () => {
    const v = setup();
    const res = (await handleBrokerRequest(
      call(mint(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_repo' } }),
      env,
      deps
    ))!;
    const body = await res.json();
    expect(body.result._meta['orgx/broker']).toEqual({ code: 'needs_approval', tool: 'delete_repo', risk: 'high' });
    expect(body.result.content[0].text).toContain('needs a person');
    expect(v.seen.map((s) => JSON.parse(s.body ?? '{}').method)).not.toContain('tools/call');

    state.policy = { groups: { low: 'allow', key: 'ask', high: 'ask' }, tools: { delete_repo: 'allow' } };
    const v2 = setup();
    const allowed = (await handleBrokerRequest(
      call(mint(), { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delete_repo' } }),
      env,
      deps
    ))!;
    expect((await allowed.json()).result.isError).toBeUndefined();
    expect(v2.seen.map((s) => JSON.parse(s.body ?? '{}').method)).toContain('tools/call');
  });

  it('classifies by the vendor annotations', () => {
    expect(classifyTool({ annotations: { readOnlyHint: true } })).toBe('low');
    expect(classifyTool({ annotations: { destructiveHint: false } })).toBe('key');
    expect(classifyTool({ annotations: {} })).toBe('high');
    const policy = { groups: { low: 'allow', key: 'allow', high: 'deny' } as const, tools: {} };
    expect(decideTool('x', { name: 'x', annotations: { destructiveHint: true } }, {}, policy)).toMatchObject({ allow: false, code: 'not_allowed' });
    expect(decideTool('y', undefined, {}, policy)).toMatchObject({ allow: false, code: 'not_allowed' });
  });
});

describe('vendor token refresh', () => {
  it('on a vendor 401, forces one refresh and retries with the new token', async () => {
    const v = setup({ acceptToken: REFRESHED_TOKEN });
    const res = (await handleBrokerRequest(call(mint(), { jsonrpc: '2.0', id: 1, method: 'initialize' }), env, deps))!;
    expect(res.status).toBe(200);
    expect(state.calls).toEqual(['run-status', 'vendor-token', 'vendor-token:force']);
    expect(v.seen.map((s) => s.headers.get('authorization'))).toEqual([
      `Bearer ${VENDOR_TOKEN}`,
      `Bearer ${REFRESHED_TOKEN}`,
    ]);
  });

  it('never hands the vendor auth challenge to the harness', async () => {
    setup({ acceptToken: 'nothing-works' });
    const res = (await handleBrokerRequest(call(mint(), { jsonrpc: '2.0', id: 1, method: 'initialize' }), env, deps))!;
    expect(res.status).toBe(502);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect((await res.json()).error).toBe('vendor_auth_failed');
  });
});

describe('metadata-only logging', () => {
  it('logs connection, method, tool, status and duration, never tokens or payloads', async () => {
    setup();
    const token = mint();
    await handleBrokerRequest(
      call(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_issues', arguments: { q: 'secret-arg' } } }),
      env,
      deps
    );
    const logged = JSON.stringify(logs);
    expect(logs.at(-1)).toMatchObject({ connection: CONN, method: 'tools/call', tool: 'list_issues', status: 200, duration_ms: 0 });
    for (const secret of [token, VENDOR_TOKEN, 'secret-arg', 'secret-payload', VENDOR_URL]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('sse rewrite', () => {
  it('keeps non-JSON events and split chunks intact', async () => {
    const encoder = new TextEncoder();
    const chunks = ['id: 1\nda', 'ta: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"},{"name":"b"}]}}\n\n', ': keepalive\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const out = await new Response(
      rewriteSseStream(stream, (m) => {
        const msg = m as { result?: { tools?: Array<{ name: string }> } };
        return msg.result?.tools ? { ...msg, result: { tools: msg.result.tools.filter((t) => t.name === 'a') } } : m;
      })
    ).text();
    expect(out).toBe('id: 1\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}\n\n: keepalive\n\n');
  });
});
