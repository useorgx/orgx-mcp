import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import { WORK_LEDGER_OUTPUT_VARIANTS } from './fixtures/workLedgerOutputVariants';
import { findBooleanAdditionalProperties } from './fixtures/outputSchemaPortability';

const api = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class { static serve() { return { fetch: vi.fn() }; } static serveSSE() { return { fetch: vi.fn() }; } } }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), wrapMcpServerWithSentry: <T>(server: T) => server, withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));
vi.mock('../src/orgxApi', async (original) => ({ ...await original<typeof import('../src/orgxApi')>(), callOrgxApiJson: api.callOrgxApiJson }));
const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

async function connect() {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.sessionContext = { workspaceId: WS };
  worker.env = { ORGX_API_URL: 'https://orgx.test', MCP_SERVER_URL: 'https://mcp.orgx.test' };
  worker.resolveUserId = () => 'fixture-user'; worker.resolveUserEmail = () => 'member@example.test'; worker.resolveOrgxUserId = () => ID;
  worker.delegationClaims = () => ({ grantedScopes: ['initiatives:read', 'initiatives:write'] });
  worker.resolveReportingSourceClient = () => ({ name: 'named-ledger-reader', version: '1' });
  worker.buildAuthRequiredResponse = () => null; worker.withOrgx = (callback: () => unknown) => callback();
  worker.withClientContext = (shape: unknown) => shape;
  const server = new McpServer({ name: 'named-ledger-contract', version: '1' }); worker.server = server;
  const visible = new Set(['orgx_list_work_receipts', 'orgx_get_work_receipt', 'orgx_attach_artifact']);
  installToolResultGuidanceWrapper(server, visible);
  // The same production registration method used by _doInit, with the real
  // compatibility handler captured behind the fixed artifact operation.
  worker.registerPublicOperations(visible, new Map([['orgx_attach', { config: {}, handler: (args: Record<string, unknown>) => worker.executeContractTool('orgx_attach', args) }]]));
  const client = new Client({ name: 'named-ledger-reader', version: '1' });
  const [reader, writer] = InMemoryTransport.createLinkedPair();
  await server.connect(writer); await client.connect(reader);
  return { server, client };
}

describe('registered named work ledger operation', () => {
  it.each(WORK_LEDGER_OUTPUT_VARIANTS.slice(0, 3))('delivers $view from the actual registered tool with closed output and bounded guidance', async (variant) => {
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ ok: true, data: structuredClone(variant.data) }));
    const { server, client } = await connect();
    const view = variant.view === 'search' ? 'receipts' : variant.view;
    try {
      const descriptor = (await client.listTools()).tools.find((tool) => tool.name === 'orgx_list_work_receipts')!;
      expect(descriptor.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(findBooleanAdditionalProperties(descriptor.outputSchema)).toEqual([]);
      const result = await client.callTool({ name: descriptor.name, arguments: { view, limit: 7, ...(view === 'receipts' ? { query: 'ledger outcome:succeeded' } : {}) } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, view, ...variant.data });
      expect(result.structuredContent?.next_calls).not.toEqual([]);
      expect(JSON.stringify(result.structuredContent?.next_calls)).not.toContain('orgx_search');
      const path = new URL(api.callOrgxApiJson.mock.calls[0][1], 'https://orgx.test');
      expect(path.pathname).toBe(variant.path); expect(path.searchParams.get('workspace_id')).toBe(WS);
      expect(path.searchParams.get('limit')).toBe('7'); expect(api.callOrgxApiJson.mock.calls[0][2].method).toBe('GET');
      if (view === 'receipts') expect(path.searchParams.get('q')).toBe('ledger outcome:succeeded');
      const schema = getToolOutputSchema('orgx_list_work_receipts')!;
      expect(schema.safeParse({ ...result.structuredContent, unknown_business_field: true }).success).toBe(false);
      expect(schema.safeParse({ ...result.structuredContent, workstreams: 'invalid' }).success).toBe(false);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
  it.each([{ view: 'delete' }, { scope: 'work_ledger' }, { action: 'approve' }, { limit: 101 }])('refuses selectors outside the bounded read contract: %j', async (args) => {
    api.callOrgxApiJson.mockReset(); const { server, client } = await connect();
    try {
      expect((await client.callTool({ name: 'orgx_list_work_receipts', arguments: args })).isError).toBe(true);
      expect(api.callOrgxApiJson).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
  it.each([false, true])('retains typed artifact metadata through the actual public alias with duplicate=%s', async (duplicate) => {
    const meta = { apiVersion: '1', artifactTypeFallback: false, effectiveArtifactType: 'eng.diff_pack', duplicate };
    api.callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ data: { id: ID }, meta }, { status: duplicate ? 200 : 201 }));
    const { server, client } = await connect();
    try {
      const result = await client.callTool({ name: 'orgx_attach_artifact', arguments: { type: 'task', id: ID, name: 'Proof', artifact_type: 'eng.diff_pack', location: { external_url: 'https://example.test/proof' }, idempotency_key: 'meta-fixture' } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { id: ID }, meta });
      expect(api.callOrgxApiJson).toHaveBeenCalledOnce();
      expect(api.callOrgxApiJson.mock.calls[0][1]).toBe('/api/client/artifacts');
      expect(JSON.parse(api.callOrgxApiJson.mock.calls[0][2].body).status).toBe('in_review');
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});
