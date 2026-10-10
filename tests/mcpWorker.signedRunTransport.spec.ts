import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TOOL_CONTRACT_KEY } from '../src/sessionToolContract';

const transport = vi.hoisted(() => ({ http: vi.fn(), sse: vi.fn(), oauth: vi.fn(), getAgentByName: vi.fn() }));

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    async getInitializeRequest() { return (this as any).ctx.storage.get('initializeRequest'); }
    static serve() { return { fetch: transport.http }; }
    static serveSSE() { return { fetch: transport.sse }; }
  },
}));
vi.mock('agents', () => ({ getAgentByName: transport.getAgentByName }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class { fetch = transport.oauth; } }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker,
}));
vi.mock('../src/posthogTelemetry', () => ({ captureWorkerPosthogEvent: vi.fn(), resolveAnonymousDistinctId: () => 'signed-run-transport-test' }));

const SECRET = 'local-test-only-run-token-secret-32-characters';
const GRANT = {
  userId: 'signed-run-user', scope: 'mcp:run', authSource: 'run_token',
  runId: '11111111-1111-4111-8111-111111111111', workspace_id: '22222222-2222-4222-8222-222222222222',
  scopes: ['orgx_search'], profile: 'chatgpt',
};

async function signedBearer(overrides: Record<string, unknown> = {}) {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'orgx-run-mcp', v: 2, aud: 'orgx-mcp', uid: GRANT.userId, wid: GRANT.workspace_id,
    rid: GRANT.runId, scp: GRANT.scopes, jti: 'signed-run-test', iat: now, exp: now + 60, ...overrides };
  const body = `oxrun2.${b64(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `${body}.${b64(new Uint8Array(signature))}`;
}

async function setup() {
  const { default: worker, OrgXMcp } = await import('../src/index');
  const cached = Object.create(OrgXMcp.prototype) as any;
  // Real native SSE stores actor props and the contract but not initializeRequest.
  const stored = new Map<string, unknown>([
    ['props', GRANT], [SESSION_TOOL_CONTRACT_KEY, { profile: 'chatgpt', contract_version: 'orgx-mcp-operations/1' }],
  ]);
  cached.ctx = { storage: { get: vi.fn(async (key: string) => stored.get(key)) } };
  transport.getAgentByName.mockResolvedValue(cached);
  transport.sse.mockImplementation(async (request: Request) => request.method === 'GET'
    ? new Response('event: endpoint\ndata: /sse/message?sessionId=signed-session&profile=chatgpt\n\n', { headers: { 'content-type': 'text/event-stream' } })
    : new Response('Accepted', { status: 202 }));
  transport.oauth.mockResolvedValue(Response.json({ error: 'invalid_token' }, { status: 401 }));
  const env = { ORGX_RUN_MCP_TOKEN_SECRET: SECRET, MCP_OBJECT: {}, MCP_SERVER_URL: 'http://localhost:8787' };
  const request = async (url = '/sse/message?sessionId=signed-session&profile=chatgpt', claims: Record<string, unknown> = {}, origin?: string) =>
    new Request(`http://localhost:8787${url}`, {
      method: 'POST', headers: { authorization: `Bearer ${await signedBearer(claims)}`, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
  return { worker, env, request, ctx: () => ({ waitUntil: vi.fn() } as any) };
}

afterEach(() => vi.clearAllMocks());

describe('signed-run authentication on actual native SSE paths', () => {
  it('authenticates both the initial GET and advertised message POST through the observed SSE handler', async () => {
    const { worker, env, request, ctx } = await setup();
    const initial = await worker.fetch(new Request('http://localhost:8787/sse?profile=chatgpt', {
      headers: { authorization: `Bearer ${await signedBearer()}` },
    }), env as any, ctx());
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain('/sse/message?sessionId=signed-session&profile=chatgpt');
    const message = await worker.fetch(await request(), env as any, ctx());
    expect(message.status).toBe(202);
    expect(transport.oauth).not.toHaveBeenCalled();
    expect(transport.http).not.toHaveBeenCalled();
    expect(transport.sse).toHaveBeenCalledTimes(2);
    expect(new URL(transport.sse.mock.calls[1]![0].url).pathname).toBe('/sse/message');
    expect(transport.sse.mock.calls[1]![2].props).toMatchObject({ ...GRANT, operationContractVersion: 'orgx-mcp-operations/1' });
    expect(transport.getAgentByName).toHaveBeenCalledWith(env.MCP_OBJECT, 'sse:signed-session');
  });

  it.each([
    { claims: { uid: 'different-user' }, status: 403 },
    { claims: { scp: ['orgx_capture_decision'] }, status: 409 },
  ])('rejects changed native SSE actor/grants before the transport executes ($status)', async ({ claims, status }) => {
    const { worker, env, request, ctx } = await setup();
    const response = await worker.fetch(await request(undefined, claims), env as any, ctx());
    expect(response.status).toBe(status);
    expect(transport.sse).not.toHaveBeenCalled();
    expect(transport.http).not.toHaveBeenCalled();
    expect(transport.oauth).not.toHaveBeenCalled();
  });

  it('refuses an expired run bearer on the native message route', async () => {
    const { worker, env, request, ctx } = await setup();
    const response = await worker.fetch(await request(undefined, { exp: 1 }), env as any, ctx());
    expect(response.status).toBe(401);
    expect(transport.sse).not.toHaveBeenCalled();
    expect(transport.getAgentByName).not.toHaveBeenCalled();
  });

  it.each(['/sse/message-extra', '/sse/unknown', '/not-mcp'])('does not authenticate arbitrary path %s as a run transport', async (path) => {
    const { worker, env, request, ctx } = await setup();
    const response = await worker.fetch(await request(path), env as any, ctx());
    expect(response.status).toBe(401);
    expect(transport.sse).not.toHaveBeenCalled();
    expect(transport.http).not.toHaveBeenCalled();
    expect(transport.getAgentByName).not.toHaveBeenCalled();
  });

  it('rejects an untrusted browser origin before native message auth or dispatch', async () => {
    const { worker, env, request, ctx } = await setup();
    const response = await worker.fetch(await request(undefined, {}, 'https://attacker.example'), env as any, ctx());
    expect(response.status).toBe(403);
    expect(transport.sse).not.toHaveBeenCalled();
    expect(transport.getAgentByName).not.toHaveBeenCalled();
    expect(transport.oauth).not.toHaveBeenCalled();
  });
});
