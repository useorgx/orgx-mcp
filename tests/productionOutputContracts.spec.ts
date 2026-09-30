import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { TOOL_FEED_BINDINGS } from '../src/live/streamGrant';

const live = { feedType: 'initiative-pulse', feedId: 'initiative-1',
  streamUrl: 'https://mcp.example.test/live-feed/initiative-pulse/initiative-1/stream?t=fixture',
  expiresAt: 1800000000000, refreshTool: 'get_initiative_pulse',
  refreshArgs: { initiative_id: 'initiative-1' }, label: 'Initiative' };

describe('production output drift regressions', () => {
  it.each(Object.keys(TOOL_FEED_BINDINGS).filter(name => getToolOutputSchema(name)))('declares the worker-added live grant for %s', (name) => {
    const schema = getToolOutputSchema(name)!;
    expect(schema.safeParse({ live }).success).toBe(true);
    expect(schema.safeParse({ live: { ...live, expiresAt: 'tomorrow' } }).success).toBe(false);
  });

  it.each([
    ['get_initiative_pulse', { live }],
    ['get_morning_brief', { generated_at: '2026-09-30T15:00:00Z', data_gaps: ['Session not found'], session_summary: null, brief_markdown: null }],
  ] as const)('returns %s through the strict SDK without -32602', async (name, payload) => {
    const schema = getToolOutputSchema(name)!;
    const server = new McpServer({ name: 'production-contract', version: '1' });
    server.registerTool(name, { outputSchema: schema.shape }, async () => ({
      content: [{ type: 'text' as const, text: 'Result ready' }], structuredContent: payload,
    }));
    const client = new Client({ name: 'claude-contract', version: '1' });
    const [reader, writer] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(writer); await client.connect(reader);
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(payload);
    } finally { await client.close(); await server.close(); }
  });
});
