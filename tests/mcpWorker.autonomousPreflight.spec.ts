import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTypedRemedy } from '../src/typedToolErrors';

const api = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('../src/posthogTelemetry', () => ({ captureWorkerPosthogEvent: vi.fn(), resolveAnonymousDistinctId: () => 'test' }));
vi.mock('../src/orgxApi', async (original) => ({
  ...(await original<typeof import('../src/orgxApi')>()), callOrgxApiJson: api.call,
}));

const support = { tools: [{ id: 'chatgpt.spawn_agent_task', parameters: {
  properties: { autonomous: { type: 'boolean', enum: [true] } },
} }] };
const args = { workspace_id: 'workspace-1', model: 'gpt-6-luna', provider: 'openai',
  runtime: 'cloud_openai', max_cost_usd: 1, effects: { allowed: [] } };
let workerPrototype: object;
beforeAll(async () => {
  const { OrgXMcp } = await import('../src/index');
  workerPrototype = OrgXMcp.prototype;
}, 20000);

async function preflight(extra: Record<string, unknown> = {}) {
  const worker = Object.create(workerPrototype);
  Object.assign(worker, { env: {}, resolveUserEmail: () => null,
    resolveOrgxUserId: () => null, delegationClaims: () => ({}) });
  return worker.runSpawnBudgetPreflight({ ...args, ...extra }, 'user-1');
}

beforeEach(() => {
  api.call.mockReset();
  api.call.mockImplementation(async (_env, path: string) => {
    if (path === '/api/tools/execute?format=full') return Response.json(support);
    if (path === '/api/client/route-task') return Response.json({ ok: true, data: {
      recommended_model: 'gpt-6-luna', provider: 'openai', tier: 'standard', estimated_cost_usd: 0.02,
    } });
    if (path === '/api/client/spawn-gate') return Response.json({ data: { allowed: true } });
    throw new Error(`unexpected endpoint ${path}`);
  });
});

describe('worker autonomous backend preflight before any POST', () => {
  it.each([{}, { tools: [] }, { tools: [{ id: 'chatgpt.spawn_agent_task', parameters: {
    properties: { autonomous: { type: 'boolean' } },
  } }] }])('never posts when the backend does not enforce literal true: %j', async (oldCatalog) => {
    api.call.mockResolvedValueOnce(Response.json(oldCatalog));
    expect(await preflight({ autonomous: true })).toMatchObject({ ok: false,
      details: { code: 'autonomous_dispatch_unsupported' } });
    expect(api.call).toHaveBeenCalledTimes(1);
    expect(api.call.mock.calls[0][1]).toBe('/api/tools/execute?format=full');
    expect(api.call.mock.calls[0][2]).toEqual({ method: 'GET' });
    expect(api.call.mock.calls[0][3]).toMatchObject({ allowFallback: false });
  });

  it.each(['throw', 'invalid-json', 'http-error'])('never posts on a failed support read: %s', async (failure) => {
    if (failure === 'throw') api.call.mockRejectedValueOnce(new Error('unavailable'));
    else if (failure === 'invalid-json') api.call.mockResolvedValueOnce(new Response('no json'));
    else api.call.mockResolvedValueOnce(Response.json(support, { status: 503 }));
    expect(await preflight({ autonomous: true })).toMatchObject({ ok: false });
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it('requires backend support before estimating and applying unchanged spend caps', async () => {
    expect((await preflight({ autonomous: true })).ok).toBe(true);
    expect(api.call.mock.calls.map((call) => [call[1], call[2]?.method])).toEqual([
      ['/api/tools/execute?format=full', 'GET'], ['/api/client/route-task', 'POST'],
      ['/api/client/spawn-gate', 'POST'],
    ]);
    expect(JSON.parse(api.call.mock.calls[2][2].body)).toMatchObject({ computed_cost_cents: 2, max_cost_usd: 1 });
  });

  it('leaves ordinary human dispatch on its existing preflight path', async () => {
    expect((await preflight()).ok).toBe(true);
    expect(api.call.mock.calls.map((call) => call[1])).toEqual([
      '/api/client/route-task', '/api/client/spawn-gate',
    ]);
  });

  it('preserves the support refusal through the worker error envelope and outer remedy wrapper', async () => {
    api.call.mockResolvedValueOnce(Response.json({ tools: [] }));
    const refusal = await preflight({ autonomous: true });
    if (refusal.ok) throw new Error('old backend must refuse autonomous work');
    const worker = Object.create(workerPrototype);
    const wrapped = withTypedRemedy(worker.toolError(refusal.message, {
      code: String(refusal.details.code), status: 424, details: refusal.details,
    }), { toolId: 'orgx_start_agent_task', args: { ...args, autonomous: true } });
    expect(wrapped).toMatchObject({ isError: true, structuredContent: { error: {
      code: 'autonomous_dispatch_unsupported',
      message: refusal.message,
      details: { code: 'autonomous_dispatch_unsupported', required_field: 'autonomous', required_value: true },
    } } });
    expect(JSON.stringify(wrapped)).not.toContain('budget_preflight_failed');
    expect(JSON.stringify(wrapped)).not.toContain('route_task');
  });

  it('refuses a false or spoofed narrowing value before even a catalog read', async () => {
    for (const autonomous of [false, 'true', 'user']) {
      expect(await preflight({ autonomous })).toMatchObject({ ok: false,
        details: { code: 'invalid_autonomous_declaration' } });
    }
    expect(api.call).not.toHaveBeenCalled();
  });
});
