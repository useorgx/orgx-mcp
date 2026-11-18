import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';

const api = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class { static serve() { return { fetch: vi.fn() }; } static serveSSE() { return { fetch: vi.fn() }; } } }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), wrapMcpServerWithSentry: <T>(server: T) => server, withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('../src/orgxApi', async (original) => ({ ...await original<typeof import('../src/orgxApi')>(), callOrgxApiJson: api.callOrgxApiJson }));
const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

async function connect(infer: () => Promise<{ id: string; name: string | null } | null>) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.sessionContext = {};
  worker.inferSessionWorkspace = infer;
  worker.saveSessionContext = vi.fn(async () => undefined);
  worker.env = { ORGX_API_URL: 'https://orgx.test', MCP_SERVER_URL: 'https://mcp.orgx.test' };
  worker.resolveUserId = () => 'fixture-user'; worker.resolveUserEmail = () => 'member@example.test'; worker.resolveOrgxUserId = () => ID;
  worker.delegationClaims = () => ({ grantedScopes: ['initiatives:read', 'initiatives:write'] });
  worker.resolveReportingSourceClient = () => ({ name: 'workspace-default', version: '1' });
  worker.buildAuthRequiredResponse = () => null; worker.withOrgx = (callback: () => unknown) => callback();
  worker.withClientContext = (shape: unknown) => shape;
  const server = new McpServer({ name: 'workspace-default', version: '1' }); worker.server = server;
  const visible = new Set(['orgx_create_initiative']);
  installToolResultGuidanceWrapper(server, visible);
  worker.registerPublicOperations(visible, new Map([['orgx_write', { config: {}, handler: (args: Record<string, unknown>) => worker.executeContractTool('orgx_write', args) }]]));
  const client = new Client({ name: 'workspace-default', version: '1' });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer); await client.connect(reader);
  return { server, client, worker };
}

function entityPosts() {
  return api.callOrgxApiJson.mock.calls.filter((c) => String(c[1]).startsWith('/api/entities') && c[2]?.method === 'POST');
}

describe('orgx_create_initiative workspace default', () => {
  it('fills workspace_id from the inferred workspace when the session has none (the contract says it defaults)', async () => {
    api.callOrgxApiJson.mockReset().mockImplementation(async (_env: unknown, _path: string, init?: { method?: string }) =>
      init?.method === 'POST' ? Response.json({ data: { id: ID, title: 'Personal ops', workspace_id: WS } }, { status: 201 }) : Response.json({ data: [] }));
    const infer = vi.fn(async () => ({ id: WS, name: 'Ops' }));
    const { server, client, worker } = await connect(infer);
    try {
      await client.callTool({ name: 'orgx_create_initiative', arguments: { title: 'Personal ops', summary: 'Reconcile mail with the task register', idempotency_key: 'ws-default-1' } });
      expect(infer).toHaveBeenCalled();
      const post = entityPosts()[0];
      expect(post, JSON.stringify(api.callOrgxApiJson.mock.calls.map((c) => c[1]))).toBeTruthy();
      expect(JSON.parse(post[2].body).workspace_id).toBe(WS);
      expect(worker.sessionContext.workspaceId).toBe(WS);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('does not guess when no workspace is unambiguous', async () => {
    api.callOrgxApiJson.mockReset().mockImplementation(async (_env: unknown, _path: string, init?: { method?: string }) =>
      init?.method === 'POST' ? Response.json({ data: { id: ID } }, { status: 201 }) : Response.json({ data: [] }));
    const { server, client } = await connect(async () => null);
    try {
      await client.callTool({ name: 'orgx_create_initiative', arguments: { title: 'Personal ops', summary: 'x', idempotency_key: 'ws-default-2' } });
      const post = entityPosts()[0];
      if (post) expect(JSON.parse(post[2].body).workspace_id).toBeUndefined();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});
