import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMcpRequest, handleMcpWebSocket } from '../src/mcpTransport';
import { MCP_LEGACY_CONTRACT_VERSION } from '../src/mcpCompatibility';
import * as sessionContractLookup from '../src/requestSessionToolContract';

const NativeResponse = Response;
const telemetryEnv = { ORGX_API_URL: 'https://orgx.test', ORGX_SERVICE_KEY: 'oxk-coverage-test' };

function harness(props: Record<string, unknown> = {}) {
  const rows: any[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = { props, waitUntil: vi.fn((promise: Promise<unknown>) => { pending.push(Promise.resolve(promise)); }) } as any;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).includes('/api/internal/mcp/tool-invocations')) rows.push(JSON.parse(String(init.body)));
    return NativeResponse.json({ ok: true });
  }));
  return { ctx, rows, async drain() {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  } };
}

function batchRequest(messages: unknown[], query = '') {
  return new Request(`http://localhost/mcp${query}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'coverage-session' },
    body: JSON.stringify(messages),
  });
}

describe('MCP batch transport coverage', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('bounds normalization logs without changing unknown tool dispatch', async () => {
    const state = harness();
    const logger = vi.spyOn(console, 'info').mockImplementation(() => {});
    const privateToolName = 'OrgX:unknown_customer_secret@example.test';
    let dispatched: any;
    const response = await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: privateToolName, arguments: {} } },
    ]), telemetryEnv, state.ctx, { fetch: vi.fn(async (request: Request) => {
      dispatched = await request.json();
      return NativeResponse.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unknown tool' } });
    }) }, async () => ({ userId: 'user-coverage' }));
    await response.json();
    await state.drain();
    expect(dispatched[0].params.name).toBe('unknown_customer_secret@example.test');
    const normalizationLogs = logger.mock.calls.filter(([label]) => label === '[mcp] Normalized tool name');
    expect(normalizationLogs).toEqual([['[mcp] Normalized tool name', { original: 'other', normalized: 'other' }]]);
    expect(JSON.stringify(normalizationLogs)).not.toContain('secret@example');
  });

  it('normalizes each old name once and correlates out-of-order results using typed JSON-RPC IDs', async () => {
    const state = harness();
    let dispatched: any;
    const handler = { fetch: vi.fn(async (request: Request) => {
      dispatched = await request.json();
      return NativeResponse.json([
        { jsonrpc: '2.0', id: '1', error: { code: -32601, message: 'Unknown old call' } },
        { jsonrpc: '2.0', id: 1, result: { structuredContent: { ok: true }, content: [] } },
      ]);
    }) };
    const auth = vi.fn(async () => ({ userId: 'user-coverage', scope: 'agents:read' }));
    const response = await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'OrgX:get_agent_status', arguments: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'old_unknown_tool', arguments: {} } },
    ]), telemetryEnv, state.ctx, handler, auth);
    await response.json();
    await state.drain();
    expect(handler.fetch).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(dispatched[0].params.name).toBe('orgx_get_agent_status');
    expect(dispatched[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(dispatched[2].params.name).toBe('old_unknown_tool');
    expect(state.rows).toHaveLength(2);
    expect(state.rows.find((row) => row.tool_id === 'orgx_get_agent_status')).toMatchObject({ status: 'success',
      metadata: { requested_tool_id: 'orgx:get_agent_status', normalized_tool_id: 'get_agent_status',
        compatibility_outcome: 'success', mcp_response_observed: true } });
    expect(state.rows.find((row) => row.tool_id === 'old_unknown_tool')).toMatchObject({ status: 'error',
      error_code: '-32601', metadata: { compatibility_outcome: 'error', requested_tool_id: 'other', legacy_tool_call: true } });
  });

  it('reads independent SSE results without copying a failed sibling onto a successful call', async () => {
    const state = harness();
    const response = await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'orgx_search', arguments: { query: 'task' } } },
      { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'orgx_get_agent_status', arguments: {} } },
    ]), telemetryEnv, state.ctx, { fetch: vi.fn(async () => new NativeResponse([
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'b', result: { isError: true, structuredContent: { error: { code: 'not_found' } } } })}\n\n`,
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'a', result: { content: [], structuredContent: { ok: true } } })}\n\n`,
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })) }, async () => ({ userId: 'user-coverage' }));
    await response.text();
    await state.drain();
    expect(state.rows.find((row) => row.request_id === 'a')).toMatchObject({ status: 'success' });
    expect(state.rows.find((row) => row.request_id === 'b')).toMatchObject({ status: 'error', error_code: 'not_found' });
  });

  it('records accepted native SSE messages as attempted when their eventual results are on another stream', async () => {
    const state = harness();
    await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'get_agent_status', arguments: {} } },
      { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'orgx_search', arguments: { query: 'task' } } },
    ]), telemetryEnv, state.ctx, { fetch: vi.fn(async () => new NativeResponse(null, { status: 202 })) }, async () => ({ userId: 'user-coverage' }));
    await state.drain();
    expect(state.rows).toHaveLength(2);
    for (const row of state.rows) expect(row).toMatchObject({ status: 'success', metadata: {
      compatibility_outcome: 'attempt', mcp_response_observed: false,
    } });
    expect(state.rows[0].metadata.legacy_tool_call).toBe(true);
  });

  it('preserves invalid write arguments and protected old approvals without inventing a valid replacement', async () => {
    const state = harness();
    let dispatched: any;
    const handler = { fetch: vi.fn(async (request: Request) => {
      dispatched = await request.json();
      return NativeResponse.json(dispatched.map((call: any) => ({ jsonrpc: '2.0', id: call.id,
        error: { code: -32602, message: 'Rejected before execution' } })));
    }) };
    await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'OrgX:orgx_decide', arguments: ['list_pending'] } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve_decision', arguments: { decision_id: 'decision' } } },
    ]), telemetryEnv, state.ctx, handler, async () => ({ userId: 'user-coverage', scope: 'decisions:read' }));
    await state.drain();
    expect(handler.fetch).toHaveBeenCalledTimes(1);
    expect(dispatched[0].params).toEqual({ name: 'orgx_decide', arguments: ['list_pending'] });
    expect(dispatched[1].params.name).toBe('approve_decision');
    expect(state.ctx.props.scope).toBe('decisions:read');
    expect(state.rows.every((row) => row.status === 'error')).toBe(true);
  });

  it('keeps retained legacy contracts on current-named reads in transport telemetry', async () => {
    const state = harness({ operationContractVersion: MCP_LEGACY_CONTRACT_VERSION });
    await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orgx_search', arguments: { query: 'work' } } },
    ]), telemetryEnv, state.ctx, { fetch: vi.fn(async () => NativeResponse.json([
      { jsonrpc: '2.0', id: 1, result: { content: [] } },
    ])) }, async () => ({ userId: 'user-coverage' }));
    await state.drain();
    expect(state.rows[0].metadata).toMatchObject({ operation_contract_version: MCP_LEGACY_CONTRACT_VERSION, legacy_tool_call: true });
  });

  it('records missing and global error responses without retrying a write after a transport failure', async () => {
    const state = harness();
    const handler = { fetch: vi.fn(async () => { throw new Error('lost response after possible commit'); }) };
    await expect(handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orgx_create_task', arguments: { title: 'work' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'orgx_search', arguments: { query: 'work' } } },
    ]), telemetryEnv, state.ctx, handler, async () => ({ userId: 'user-coverage' }))).rejects.toThrow('lost response');
    await state.drain();
    expect(handler.fetch).toHaveBeenCalledTimes(1);
    expect(state.rows).toHaveLength(2);
    expect(state.rows.every((row) => row.status === 'error')).toBe(true);
  });

  it('observes each rejected session attempt without mapping a call or executing a handler', async () => {
    const state = harness();
    vi.spyOn(sessionContractLookup, 'resolveRequestSessionToolContract').mockRejectedValueOnce(
      Object.assign(new Error('foreign session'), { name: 'McpSessionIdentityConflictError' }));
    const handler = { fetch: vi.fn(async () => NativeResponse.json({ committed: true })) };
    const response = await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'OrgX:get_agent_status', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve_decision', arguments: { decision_id: 'decision' } } },
    ]), telemetryEnv, state.ctx, handler, async () => ({ userId: 'current-authenticated-user', scope: 'agents:read' }));
    await state.drain();
    expect(response.status).toBe(403);
    expect(handler.fetch).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({ tool_id: 'OrgX:get_agent_status', status: 'error', user_id: 'current-authenticated-user',
      metadata: { requested_tool_id: 'orgx:get_agent_status', normalized_tool_id: 'get_agent_status',
        operation_contract_version: 'unknown', compatibility_outcome: 'error', legacy_tool_call: true } });
    expect(state.rows[1].tool_id).toBe('approve_decision');
  });

  it('records authenticated token rejection without borrowing a previous session actor or retrying', async () => {
    const state = harness({ userId: 'previous-actor' });
    const handler = { fetch: vi.fn(async () => NativeResponse.json({ committed: true })) };
    await handleMcpRequest(batchRequest([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_agent_status', arguments: {} } },
    ]), telemetryEnv, state.ctx, handler, async () => ({ userId: 'verified-current-actor',
      response: NativeResponse.json({ error: 'expired' }, { status: 401 }) }));
    await state.drain();
    expect(handler.fetch).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ user_id: 'verified-current-actor', status: 'error',
      error_code: 'authentication_required', tool_id: 'get_agent_status',
      metadata: { operation_contract_version: 'unknown', legacy_tool_call: true } });
  });


});

describe('authenticated WebSocket bridge coverage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the same normalized authenticated path, profile, session and telemetry for each frame', async () => {
    const state = harness();
    const messages: string[] = [];
    const listeners = new Map<string, (event: any) => void>();
    const server = { accept: vi.fn(), send: vi.fn((value: string) => messages.push(value)),
      addEventListener: vi.fn((name: string, callback: (event: any) => void) => listeners.set(name, callback)) };
    vi.stubGlobal('WebSocketPair', class { 0 = {}; 1 = server; });
    vi.stubGlobal('Response', class extends NativeResponse {
      constructor(body?: BodyInit | null, init: ResponseInit & { webSocket?: unknown } = {}) {
        super(body, init.status === 101 ? { ...init, status: 200 } : init);
        if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
        if (init.webSocket) Object.defineProperty(this, 'webSocket', { value: init.webSocket });
      }
    });
    const received: any[] = [];
    const auth = vi.fn(async () => ({ userId: 'user-coverage', scope: 'agents:read' }));
    const handler = { fetch: vi.fn(async (request: Request, _env: unknown, ctx: any) => {
      const body = await request.json();
      received.push({ body, url: request.url, profile: ctx.props.profile, scope: ctx.props.scope,
        session: request.headers.get('mcp-session-id'), header: request.headers.get('x-orgx-tool-profile') });
      return NativeResponse.json({ jsonrpc: '2.0', id: body.id, result: { content: [] } },
        { headers: { 'mcp-session-id': 'socket-session' } });
    }) };
    await handleMcpWebSocket(new Request('http://localhost/v1/org/servers/orgx?profile=chatgpt', {
      headers: { upgrade: 'websocket', 'x-orgx-tool-profile': 'chatgpt', authorization: 'Bearer actual-token' },
    }), telemetryEnv, state.ctx, handler, auth);
    listeners.get('message')!({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'chatgpt-extension', version: '1.1.0' } } }) });
    await state.drain();
    listeners.get('message')!({ data: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'OrgX:get_agent_status', arguments: {} } }) });
    await state.drain();
    expect(auth).toHaveBeenCalledTimes(1);
    expect(handler.fetch).toHaveBeenCalledTimes(2);
    expect(received[1]).toMatchObject({ body: { params: { name: 'orgx_get_agent_status' } },
      url: 'http://localhost/mcp?profile=chatgpt', profile: 'chatgpt', scope: 'agents:read',
      session: 'socket-session', header: 'chatgpt' });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ user_id: 'user-coverage', mcp_session_id: 'socket-session',
      metadata: { requested_tool_id: 'orgx:get_agent_status', normalized_tool_id: 'get_agent_status', compatibility_outcome: 'success' } });
    expect(JSON.parse(messages[1])).toMatchObject({ event: 'message', data: { id: 2 } });
  });
});
