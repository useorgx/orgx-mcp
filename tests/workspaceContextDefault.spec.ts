import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PrivateOperation } from '../src/operationRegistration';

const api = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn<typeof import('../src/orgxApi').callOrgxApiJson>(),
}));
vi.mock('agents/mcp', () => ({ McpAgent: class {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker,
}));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('../src/orgxApi', async (original) => ({
  ...await original<typeof import('../src/orgxApi')>(),
  callOrgxApiJson: api.callOrgxApiJson,
}));

const LUNA = 'd4b91b9e-7e17-470a-b4ba-b7ba5a71d2b8';
const BUSINESS = '7af01a51-49b1-47d8-98b9-91a198debca8';
const RUN = '11111111-1111-4111-8111-111111111111';
const REVIEW_ARTIFACT = '22222222-2222-4222-8222-222222222222';

interface WorkerFixture {
  sessionContext: { workspaceId: string };
  props: { authSource?: 'run_token'; runId?: string; workspace_id?: string; scopes?: string[] };
  env: { ORGX_API_URL: string; MCP_SERVER_URL: string };
  server: McpServer;
  resolveUserId(): string;
  resolveUserEmail(): string;
  resolveOrgxUserId(): string;
  buildAuthRequiredResponse(): CallToolResult | null;
  withOrgx<T>(callback: () => Promise<T>): Promise<T>;
  withClientContext<T>(shape: T): T;
  registerPublicOperations(allowed: Set<string>, operations: Map<string, PrivateOperation>): void;
}

async function connect(options: { blocked?: CallToolResult; runBound?: boolean } = {}) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as WorkerFixture;
  // A stale UI selection is not a credential or a new default-selection grant.
  worker.sessionContext = Object.freeze({ workspaceId: LUNA });
  worker.props = Object.freeze(options.runBound
    ? { authSource: 'run_token' as const, runId: RUN, workspace_id: BUSINESS, scopes: ['initiatives:read'] }
    : {});
  worker.env = { ORGX_API_URL: 'https://orgx.test', MCP_SERVER_URL: 'https://mcp.orgx.test' };
  worker.resolveUserId = () => 'workspace-default-fixture';
  worker.resolveUserEmail = () => 'fixture@example.test';
  worker.resolveOrgxUserId = () => RUN;
  worker.buildAuthRequiredResponse = vi.fn(() => options.blocked ?? null);
  worker.withOrgx = (callback) => callback();
  worker.withClientContext = (shape) => shape;
  const server = new McpServer({ name: 'workspace-default-fixture', version: '1' });
  worker.server = server;
  worker.registerPublicOperations(new Set([
    'orgx_get_workspace_context', 'orgx_open_artifact_review',
  ]), new Map());
  const client = new Client({ name: 'workspace-default-client', version: '1' });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer);
  await client.connect(reader);
  return {
    client, worker,
    close: () => Promise.allSettled([client.close(), server.close()]),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live fetch in offline fixture'); }));
  api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ data: { workspace_id: BUSINESS } }));
});
afterEach(() => vi.unstubAllGlobals());

describe('registered workspace context default discovery', () => {
  it('leaves an omitted workspace selector for the API to resolve, without changing the cached session', async () => {
    const fixture = await connect();
    const cached = fixture.worker.sessionContext;
    try {
      const result = await fixture.client.callTool({ name: 'orgx_get_workspace_context', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      const [, path, init, claims] = api.callOrgxApiJson.mock.calls[0]!;
      expect(path).toBe('/api/v1/workflows/workspace-context');
      expect(init).toEqual({ method: 'GET' });
      expect(claims).toMatchObject({ userId: 'workspace-default-fixture', orgxUserId: RUN });
      expect(claims).not.toHaveProperty('workspaceId');
      expect(result.structuredContent).toEqual({ data: { workspace_id: BUSINESS } });
      expect(fixture.worker.sessionContext).toBe(cached);
      expect(cached).toEqual({ workspaceId: LUNA });
    } finally { await fixture.close(); }
  });

  it.each([BUSINESS, LUNA])('preserves the explicit workspace selector %s', async (workspace) => {
    const fixture = await connect();
    try {
      await fixture.client.callTool({ name: 'orgx_get_workspace_context', arguments: { workspace_id: workspace } });
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(api.callOrgxApiJson.mock.calls[0]![1]).toBe(`/api/v1/workflows/workspace-context?workspace_id=${workspace}`);
      expect(fixture.worker.sessionContext).toEqual({ workspaceId: LUNA });
    } finally { await fixture.close(); }
  });

  it('retains cached workspace scoping for other public workflow operations', async () => {
    const fixture = await connect();
    try {
      await fixture.client.callTool({ name: 'orgx_open_artifact_review', arguments: { artifact_id: REVIEW_ARTIFACT } });
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      const path = new URL(api.callOrgxApiJson.mock.calls[0]![1], 'https://orgx.test');
      expect(path.pathname).toBe(`/api/v1/workflows/artifact-review/${REVIEW_ARTIFACT}`);
      expect(path.searchParams.get('workspace_id')).toBe(LUNA);
    } finally { await fixture.close(); }
  });

  it('keeps the authorization gate before backend dispatch', async () => {
    const blocked: CallToolResult = {
      isError: true, content: [{ type: 'text', text: 'Authentication required' }],
      structuredContent: { error: { code: 'auth_required', status: 401 } },
    };
    const fixture = await connect({ blocked });
    try {
      const result = await fixture.client.callTool({ name: 'orgx_get_workspace_context', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(blocked.structuredContent);
      expect(fixture.worker.buildAuthRequiredResponse).toHaveBeenCalledOnce();
      expect(api.callOrgxApiJson).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it('preserves an API credential-pin rejection without retrying or substituting the cached workspace', async () => {
    const rejection = { error: { code: 'workspace_not_found', message: 'Workspace unavailable', status: 404 } };
    api.callOrgxApiJson.mockResolvedValue(Response.json(rejection, { status: 404 }));
    const fixture = await connect({ runBound: true });
    try {
      const result = await fixture.client.callTool({ name: 'orgx_get_workspace_context', arguments: { workspace_id: LUNA } });
      expect(result.structuredContent).toEqual(rejection);
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      const [, path, , claims] = api.callOrgxApiJson.mock.calls[0]!;
      expect(path).toBe(`/api/v1/workflows/workspace-context?workspace_id=${LUNA}`);
      expect(claims).toMatchObject({ runId: RUN, workspaceId: BUSINESS, scopes: ['initiatives:read'] });
      expect(fixture.worker.props.workspace_id).toBe(BUSINESS);
      expect(fixture.worker.sessionContext.workspaceId).toBe(LUNA);
    } finally { await fixture.close(); }
  });

  it('retains real delegation claims when context discovery omits the query selector', async () => {
    const fixture = await connect({ runBound: true });
    try {
      await fixture.client.callTool({ name: 'orgx_get_workspace_context', arguments: {} });
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      const [, path, , claims] = api.callOrgxApiJson.mock.calls[0]!;
      expect(path).toBe('/api/v1/workflows/workspace-context');
      expect(claims).toMatchObject({ runId: RUN, workspaceId: BUSINESS, scopes: ['initiatives:read'] });
    } finally { await fixture.close(); }
  });
});
