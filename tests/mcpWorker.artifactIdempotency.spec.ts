import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';

const api = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class {
  static serve() { return { fetch: vi.fn(async () => new Response(null, { status: 501 })) }; }
  static serveSSE() { return { fetch: vi.fn(async () => new Response(null, { status: 501 })) }; }
} }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server, withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class { async fetch() { return new Response(null, { status: 501 }); } } }));
vi.mock('../src/orgxApi', async (original) => ({ ...await original<typeof import('../src/orgxApi')>(), callOrgxApiJson: api.callOrgxApiJson }));

const KEY = 'synthetic-artifact-retry-20261007';
const ID = '22222222-2222-4222-8222-222222222222';
const WS = '11111111-1111-4111-8111-111111111111';
let client: Client;
let worker: Record<string, any>;
beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Fixture blocks real network', { status: 503 })));
  const { OrgXMcp } = await import('../src/index');
  worker = Object.create(OrgXMcp.prototype);
  worker.props = { profile: 'v2', userId: 'user_artifact_fixture', orgxUserId: ID,
    email: 'artifact@example.test', scope: AUTHORIZATION_PRESETS.operate.scopes.join(' '), workspace_id: WS };
  worker.ctx = { id: { toString: () => 'artifact-header-fixture' }, storage: {
    get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), sql: { exec: vi.fn(() => []) } },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise) };
  worker.env = { ORGX_API_URL: 'https://api.useorgx.test', ORGX_WEB_URL: 'https://useorgx.test',
    ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test', ORGX_SERVICE_KEY: 'oxk-fixture-service-key',
    ORGX_INTERNAL_SECRET: 'fixture-signing-key', MCP_SERVER_URL: 'https://mcp.useorgx.test', MCP_JWT_SECRET: 'fixture-only',
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) } };
  Object.assign(worker, { sessionContext: {}, sessionAuth: {}, sessionSqlInitialized: false,
    mcpActivationState: createEmptyMcpActivationState(), mcpSessionReentryState: createEmptyMcpSessionReentryState(),
    _isNewSession: false, widgetDebugEvents: [], toolResultGuidanceInstalled: false });
  await worker._doInit();
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'artifact-header-fixture', version: '1.0.0' });
  await worker.server.connect(b); await client.connect(a);
}, 30000);
beforeEach(() => {
  api.callOrgxApiJson.mockReset();
  api.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string, init?: RequestInit) => {
    if (path.startsWith('/api/entities?')) return Response.json({ data: [] });
    if (path === '/api/internal/mcp/tool-invocations') return Response.json({ ok: true });
    if (init?.method === 'POST' && ['/api/entities', '/api/client/artifacts'].includes(path)) {
      // The v1 artifact route requires a header; metadata alone does not satisfy it.
      if (new Headers(init.headers).get('Idempotency-Key') !== KEY) throw new Error('Idempotency-Key header is required for artifact creation');
      return Response.json(path === '/api/client/artifacts'
        ? { ok: true, artifact: { id: ID } }
        : { ok: true, data: { id: ID } });
    }
    throw new Error(`Unexpected fixture path: ${path}`);
  });
});
afterAll(async () => {
  await Promise.allSettled([client?.close(), worker?.server.close()]);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const posts = () => api.callOrgxApiJson.mock.calls.filter((call) => call[2]?.method === 'POST' && call[1] !== '/api/internal/mcp/tool-invocations');

describe('artifact keys cross the MCP-to-HTTP boundary', () => {
  it.each([
    { tool: 'orgx_attach', path: '/api/client/artifacts', args: { type: 'task', id: ID, name: 'Fixture receipt', artifact_type: 'eng.diff_pack', artifact_url: 'https://example.test/fixture', idempotency_key: KEY } },
    { tool: 'orgx_write', path: '/api/entities', args: { operation: 'create', type: 'artifact', name: 'Fixture receipt', entity_type: 'task', entity_id: ID, artifact_type: 'eng.diff_pack', artifact_url: 'https://example.test/fixture', idempotency_key: KEY } },
  ])('$tool sends the caller key as a header and retains metadata/actor identity', async ({ tool, path, args }) => {
    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(posts()).toHaveLength(1);
    const post = posts()[0]!;
    expect(post[1]).toBe(path);
    expect(new Headers(post[2].headers).get('Idempotency-Key')).toBe(KEY);
    expect(JSON.parse(String(post[2].body)).metadata.idempotency_key).toBe(KEY);
    // Adding the header must not opt these previously single-attempt writes into fallback replay.
    expect(post[3]).toMatchObject({ userId: 'user_artifact_fixture', orgxUserId: ID, allowFallback: false });
  });
  it.each([false, true])('returns canonical artifact API metadata through the actual SDK handler with duplicate=%s', async (duplicate) => {
    // Source-shaped API fixture: app POST /api/v1/artifacts emits data+meta.
    // The production connector discarded the body after its validation error;
    // durable artifact readback established that the write had already occurred.
    const meta = { apiVersion: '1', artifactTypeFallback: false, effectiveArtifactType: 'eng.diff_pack', duplicate };
    api.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string, init?: RequestInit) => {
      if (path === '/api/client/artifacts' && init?.method === 'POST') return Response.json({ data: { id: ID, artifact_type: 'eng.diff_pack', status: 'in_review' }, meta }, { status: duplicate ? 200 : 201 });
      if (path.startsWith('/api/entities?')) return Response.json({ data: [] });
      if (path === '/api/internal/mcp/tool-invocations') return Response.json({ ok: true });
      throw new Error(`Unexpected fixture path: ${path}`);
    });
    const result = await client.callTool({ name: 'orgx_attach', arguments: { type: 'task', id: ID, name: 'Fixture proof', artifact_type: 'eng.diff_pack', artifact_url: 'https://example.test/fixture', idempotency_key: KEY } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ _v2_tool: 'orgx_attach', _action: 'attach', data: { id: ID }, meta });
    expect(posts()).toHaveLength(1); // Output compatibility never retries the completed write.
    const schema = getToolOutputSchema('orgx_attach')!;
    expect(schema.safeParse({ ...result.structuredContent, unexpected_business_field: true }).success).toBe(false);
    expect(schema.safeParse({ ...result.structuredContent, meta: { ...meta, duplicate: 'yes' } }).success).toBe(false);
  });
});
