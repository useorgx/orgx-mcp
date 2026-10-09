import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { toolCallSchema } from '../src/openaiOutputSchemas/shared';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import { WORK_LEDGER_OUTPUT_VARIANTS, workLedgerPayload } from './fixtures/workLedgerOutputVariants';
import { findBooleanAdditionalProperties } from './fixtures/outputSchemaPortability';

vi.mock('agents/mcp', () => ({ McpAgent: class McpAgent {
  static serve() { return { fetch: vi.fn() }; }
  static serveSSE() { return { fetch: vi.fn() }; }
} }));
vi.mock('../src/oauth', () => ({ OAuthState: class OAuthState {} }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker,
}));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class OAuthProvider {} }));

const schema = getToolOutputSchema('orgx_search')!;

describe('work-ledger search output contract', () => {
  it.each(WORK_LEDGER_OUTPUT_VARIANTS)('validates and preserves the $view projection', (variant) => {
    const payload = workLedgerPayload(variant);
    expect(schema.parse(payload)).toEqual(payload);
  });

  it.each([
    { scope: 'work_ledger', view: 'search', query: { text: '', filters: {} }, total: 0, receipts: 0, workstreams: 0, results: [], window_days: 120, next_calls: [] },
    { scope: 'work_ledger', view: 'workstreams', total: 0, workstreams: [], next_calls: [] },
    { scope: 'work_ledger', view: 'review', total: 0, items: [], criteria_proposals: [], queue_limit: 200, queue_truncated: false, window_days: 120, next_calls: [] },
    { scope: 'work_ledger', view: 'receipt', row: null, human_judgment: null, workstream: null, mappings: [], links: [], criteria: [], uncertain: [] },
  ])('accepts empty and nullable ledger projections: $view', (payload) => {
    expect(schema.safeParse({ _v2_tool: 'orgx_search', ...payload }).success).toBe(true);
  });

  it.each([
    { scope: 'other' }, { view: 'typo' }, { query: { text: '', filters: { outcome: 42 } } },
    { receipts: ['receipt-1', 2] }, { workstreams: 'zero' }, { workstreams: [null] },
    { members: ['receipt-1'] }, { queue_truncated: 'false' }, { uncertain: [false] },
    { next_calls: [{ tool: 'orgx_search', args: { scope: 'work_ledger', receipt_id: 42 } }] },
    { leaked_transport_field: true },
  ])('rejects malformed projections while retaining a closed envelope: %j', (invalid) => {
    expect(schema.safeParse({ _v2_tool: 'orgx_search', scope: 'work_ledger', ...invalid }).success).toBe(false);
  });

  it('keeps ordinary entity results and structured errors compatible', () => {
    expect(schema.safeParse({ _v2_tool: 'orgx_search', type: 'task', search_mode: 'typed_collection',
      query: null, count: 1, results: [{ id: 'task-1', title: 'Ledger search' }],
      pagination: { limit: 25, has_more: false }, next_call: null }).success).toBe(true);
    expect(schema.safeParse({ ok: false, error: { code: 'work_ledger_unavailable',
      message: 'The work ledger could not be read', status: 404 } }).success).toBe(true);
  });

  it('keeps exact ledger navigation arguments in both guidance formats', () => {
    const args = { scope: 'work_ledger', view: 'review', receipt_id: 'receipt-1', workstream_id: 'workstream-1' };
    expect(toolCallSchema.parse({ tool: 'orgx_search', args, arguments: args })).toEqual({ tool: 'orgx_search', args, arguments: args });
  });

  it.each(WORK_LEDGER_OUTPUT_VARIANTS)('delivers the actual $view handler through the strict MCP SDK', async (variant) => {
    const { OrgXMcp } = await import('../src/index');
    const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
    worker.sessionContext = { workspaceId: 'workspace-1' };
    worker.fetchOrgxJsonOrNull = vi.fn(async () => ({ ok: true, data: structuredClone(variant.data) }));
    const server = new McpServer({ name: 'work-ledger-contract', version: '1' });
    installToolResultGuidanceWrapper(server, new Set(['orgx_search']));
    server.registerTool('orgx_search', { inputSchema: {} }, async () =>
      worker.searchWorkLedger({ scope: 'work_ledger', ...variant.args }, 'user-1'));
    const client = new Client({ name: 'strict-ledger-reader', version: '1' });
    const [reader, writer] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(writer);
      await client.connect(reader);
      const descriptor = (await client.listTools()).tools[0];
      expect(descriptor.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(findBooleanAdditionalProperties(descriptor.outputSchema)).toEqual([]);
      expect(descriptor.outputSchema?.properties).toHaveProperty('scope');
      expect(descriptor.outputSchema?.properties).toHaveProperty('next_calls');

      const result = await client.callTool({ name: 'orgx_search', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(workLedgerPayload(variant));
      const [path, userId] = worker.fetchOrgxJsonOrNull.mock.calls[0];
      const url = new URL(path, 'https://orgx.test');
      expect(url.pathname).toBe(variant.path);
      expect(url.searchParams.get('workspace_id')).toBe('workspace-1');
      expect(userId).toBe('user-1');
      if (variant.view === 'search') expect(url.searchParams.get('q')).toBe(variant.args.query);
      if (variant.view === 'workstream') expect(url.searchParams.get('id')).toBe(variant.args.workstream_id);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
