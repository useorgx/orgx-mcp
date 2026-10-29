import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';
import { writeFileSync } from 'node:fs';

// Audit-only reproduction: envelope emitted by src/index.ts searchWorkLedger.
// No upstream calls, credentials, production changes, or simulated success.
const observations: Array<Record<string, unknown>> = [];
describe('audit: Work Ledger envelope through real MCP SDK validation', () => {
  for (const view of ['receipt', 'workstream', 'review', 'search']) {
    it(`reproduces rejection of the ${view} envelope`, async () => {
      const payload = {
        _v2_tool: 'orgx_search', scope: 'work_ledger', view,
        rows: [],
        next_calls: [{ tool: 'orgx_search', args: { scope: 'work_ledger', view: 'review' } }],
      };
      const server = new McpServer({ name: 'audit', version: '1' });
      installToolResultGuidanceWrapper(server, null);
      server.registerTool('orgx_search', { inputSchema: {} }, async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload,
      }));
      const client = new Client({ name: 'audit', version: '1' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st); await client.connect(ct);
      try {
        let failure: unknown;
        let result: unknown;
        try { result = await client.callTool({ name: 'orgx_search', arguments: {} }); }
        catch (error) { failure = error; }
        const errorText = failure ? String(failure) : JSON.stringify(result);
        expect(errorText).toMatch(/Output validation error|Output validation failed|Invalid structured content/);
        observations.push({ view, result: 'reproduced failure', error: errorText });
      } finally { await client.close(); await server.close(); }
    });
  }
  it('writes sanitized reproduction evidence', () => {
    expect(observations).toHaveLength(4);
    writeFileSync('../ledger-sdk-reproduction.json', JSON.stringify(observations, null, 2));
  });
});
