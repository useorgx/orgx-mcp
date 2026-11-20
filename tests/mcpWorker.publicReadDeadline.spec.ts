import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker,
}));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('../src/orgxApi', async (original) => ({
  ...await original<typeof import('../src/orgxApi')>(),
  callOrgxApiJson: api.json,
}));

import { OrgXMcp } from '../src/index';

function workerFixture() {
  const worker = Object.create(OrgXMcp.prototype) as any;
  worker.env = { ORGX_API_URL: 'https://primary.example.test' };
  worker.resolveUserId = () => 'authenticated-user';
  worker.resolveUserEmail = () => 'reader@example.test';
  worker.resolveOrgxUserId = () => 'internal-user';
  worker.delegationClaims = () => ({ workspaceId: 'signed-workspace', runId: 'signed-run', scopes: ['orgx_get_workspace_context'] });
  return worker;
}

describe('public operation read transport', () => {
  beforeEach(() => {
    api.json.mockReset().mockImplementation(async () => Response.json({ data: { workspace: { id: 'signed-workspace' } } }));
  });

  it('caps reads while retaining signed actor/run scope and the original request signal', async () => {
    const worker = workerFixture();
    const controller = new AbortController();

    await worker.requestPublicOperation('/api/v1/workflows/workspace-context', { signal: controller.signal });

    expect(api.json).toHaveBeenCalledWith(worker.env, '/api/v1/workflows/workspace-context', { signal: controller.signal }, {
      userId: 'authenticated-user', userEmail: 'reader@example.test', orgxUserId: 'internal-user',
      workspaceId: 'signed-workspace', runId: 'signed-run', scopes: ['orgx_get_workspace_context'], timeoutMs: 10_000,
    });
  });

  it('keeps the existing write budget and explicit no-fallback policy', async () => {
    const worker = workerFixture();

    await worker.requestPublicOperation('/api/v1/workflows/save-plan', { method: 'POST', body: '{}' }, { allowFallback: false });

    expect(api.json.mock.calls[0][3]).toMatchObject({ allowFallback: false });
    expect(api.json.mock.calls[0][3]).not.toHaveProperty('timeoutMs');
  });

  it('forwards the SDK cancellation signal through the registered context operation', async () => {
    const worker = workerFixture();
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    worker.server = { registerTool: (name: string, _config: unknown, handler: (...args: any[]) => Promise<unknown>) => handlers.set(name, handler) };
    worker.usesLegacyDirectoryContracts = () => false;
    worker.withClientContext = (schema: unknown) => schema;
    worker.buildAuthRequiredResponse = () => null;
    worker.withOrgx = (runner: () => unknown) => runner();
    worker.registerPublicOperations(new Set(['orgx_get_workspace_context']), new Map());
    const controller = new AbortController();

    await handlers.get('orgx_get_workspace_context')!({}, { signal: controller.signal });

    expect(api.json.mock.calls[0][2].signal).toBe(controller.signal);
    expect(api.json.mock.calls[0][3].timeoutMs).toBe(10_000);
  });
});
