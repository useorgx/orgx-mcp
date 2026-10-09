import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { normalizeMemorySearchPayload } from '../src/orgxSearch';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import { INTERPRETATION_SEARCH_RESULT } from './fixtures/interpretationSearch';

const callOrgxApiJson = vi.hoisted(() => vi.fn());
vi.mock('agents/mcp', () => ({ McpAgent: class McpAgent {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock('../src/oauth', () => ({ OAuthState: class OAuthState {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class OAuthProvider {} }));
vi.mock('../src/orgxApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orgxApi')>(), callOrgxApiJson,
}));

const schema = getToolOutputSchema('orgx_search')!;
function payload(row: Record<string, unknown>) {
  return { _v2_tool: 'orgx_search', type: 'all', search_mode: 'mixed_relevance', query: 'ledger contract',
    count: 1, results: [row], pagination: { exhaustive: false, has_more: false }, next_call: null };
}

describe('interpretation search contract', () => {
  it('keeps integrity metadata and provisional assurance separate in structured results', () => {
    const original = payload(INTERPRETATION_SEARCH_RESULT);
    expect(schema.parse(original)).toEqual(original);
    expect(normalizeMemorySearchPayload({ results_by_type: { interpretations: [INTERPRETATION_SEARCH_RESULT] } }).results)
      .toEqual([INTERPRETATION_SEARCH_RESULT]);
    expect(INTERPRETATION_SEARCH_RESULT.metadata.assurance_rung).toBe(1);
    expect(INTERPRETATION_SEARCH_RESULT.metadata.interpretation.assurance[0].independent).toBe(false);
  });

  it.each([
    { event_id: 'not-a-uuid' }, { event_hash: 'not-a-digest' }, { global_sequence: -1 },
    { assurance_rung: 6 }, { assurance_rung: 'accepted' }, { interpretation: 'verified' },
  ])('rejects malformed candidate provenance metadata: %j', (invalid) => {
    expect(schema.safeParse(payload({ ...INTERPRETATION_SEARCH_RESULT,
      metadata: { ...INTERPRETATION_SEARCH_RESULT.metadata, ...invalid } })).success).toBe(false);
  });

  it('accepts missing assurance without manufacturing an evidence rung', () => {
    expect(schema.safeParse(payload({ ...INTERPRETATION_SEARCH_RESULT,
      metadata: { ...INTERPRETATION_SEARCH_RESULT.metadata, assurance_rung: null } })).success).toBe(true);
  });

  it('delivers grouped API interpretation matches through the real search handler and strict SDK', async () => {
    const { OrgXMcp } = await import('../src/index');
    const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
    worker.sessionContext = {};
    worker.env = { ORGX_API_URL: 'https://orgx.test' };
    worker.resolveUserId = vi.fn(() => 'session-user');
    worker.resolveUserEmail = vi.fn(() => 'member@example.test');
    worker.resolveOrgxUserId = vi.fn(() => '44444444-4444-4444-8444-444444444444');
    worker.delegationClaims = vi.fn(() => ({ grantedScopes: ['memory:read'] }));
    worker.buildAuthRequiredResponse = vi.fn(() => null);
    worker.withOrgx = vi.fn(async (callback) => callback());
    callOrgxApiJson.mockReset().mockResolvedValue(Response.json({ ok: true,
      data: { results_by_type: { interpretations: [INTERPRETATION_SEARCH_RESULT] } } }));
    const server = new McpServer({ name: 'interpretation-search', version: '1' });
    const contract = CONTRACT_TOOL_DEFINITIONS.find((tool) => tool.id === 'orgx_search')!;
    installToolResultGuidanceWrapper(server, new Set(['orgx_search', 'orgx_inspect']));
    server.registerTool('orgx_search', { inputSchema: contract.inputSchema }, (args) =>
      worker.executeContractTool('orgx_search', args, contract.securitySchemes));
    const client = new Client({ name: 'interpretation-reader', version: '1' });
    const [reader, writer] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(writer);
      await client.connect(reader);
      const result = await client.callTool({ name: 'orgx_search', arguments: { query: 'ledger contract' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ type: 'all', search_mode: 'mixed_relevance', results: [INTERPRETATION_SEARCH_RESULT] });
      expect(result._meta).toMatchObject({ 'orgx/searchPayload': { results: [INTERPRETATION_SEARCH_RESULT] } });
      expect(callOrgxApiJson.mock.calls[0][1]).toBe('/api/tools/execute');
      expect(JSON.parse(callOrgxApiJson.mock.calls[0][2].body)).toMatchObject({ tool_id: 'query_org_memory', args: { scope: 'all', query: 'ledger contract' } });
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});
