import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';

describe('committed mutation acknowledgements', () => {
  it.each(['orgx_write', 'orgx_create_initiative', 'orgx_create_workstream', 'orgx_update_work'])(
    'delivers API activation and reassignment follow-ups through the actual MCP validator for %s', async name => {
      const server = new McpServer({ name: 'mutation-output-regression', version: '1' });
      installToolResultGuidanceWrapper(server, null, undefined, undefined, false, 'legacy');
      const committed = {
        _v2_tool: 'orgx_write', operation: 'create', type: 'workstream',
        data: { id: 'experiment-owned-workstream', status: 'blocked' },
        initiative_activation: { initiative_id: 'synthetic-initiative', activated: false,
          created_stream_count: 0, redispatched_stream_count: 0, error: 'mission_cancelled' },
        stream_reassignment: { stream_id: 'synthetic-stream', changed: false, redispatched: false },
      };
      server.registerTool(name, { inputSchema: {} }, async () => ({ content: [], structuredContent: committed }));
      const client = new Client({ name: 'mutation-contract-client', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject(committed);
        // Idempotent replays do not carry the API-only activation follow-up;
        // their success cannot substitute for the first committed response.
        const advertised = (await client.listTools()).tools.find(tool => tool.name === name);
        expect(advertised?.outputSchema?.additionalProperties).toBe(false);
      } finally { await Promise.allSettled([client.close(), server.close()]); }
    }
  );
});
