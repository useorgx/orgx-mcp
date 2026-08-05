import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'orgx-output-schema-truth-client',
    version: '1.0.0',
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('truthful tool output schemas', () => {
  it('does not invent an outputSchema for a tool without an exact contract', async () => {
    const server = new McpServer({
      name: 'orgx-no-catch-all-output-schema',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool(
      'rich_result_without_exact_schema',
      { description: 'Representative rich result', inputSchema: {} },
      async () => ({
        content: [{ type: 'text' as const, text: 'one result' }],
        structuredContent: {
          results: [{ id: 'decision-1', title: 'Rate limiting' }],
          total: 1,
        },
      })
    );

    const client = await connect(server);
    try {
      const descriptor = await client.listTools();
      expect(descriptor.tools).toHaveLength(1);
      expect(descriptor.tools[0]?.outputSchema).toBeUndefined();

      const result = await client.callTool({
        name: 'rich_result_without_exact_schema',
        arguments: {},
      });
      expect(result.structuredContent).toEqual({
        results: [{ id: 'decision-1', title: 'Rate limiting' }],
        total: 1,
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it('preserves an exact per-tool outputSchema and validates its representative handler result', async () => {
    const server = new McpServer({
      name: 'orgx-exact-output-schema',
      version: '1.0.0',
    });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool(
      'exact_result',
      {
        description: 'Representative exact result',
        inputSchema: {},
        outputSchema: {
          ok: z.literal(true),
          decision: z.object({ id: z.string(), title: z.string() }),
        },
      },
      async () => ({
        content: [{ type: 'text' as const, text: 'decision found' }],
        structuredContent: {
          ok: true as const,
          decision: { id: 'decision-1', title: 'Rate limiting' },
        },
      })
    );

    const client = await connect(server);
    try {
      const descriptor = await client.listTools();
      expect(descriptor.tools[0]?.outputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'decision'],
        properties: {
          ok: { const: true },
          decision: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title'],
          },
        },
      });

      const result = await client.callTool({
        name: 'exact_result',
        arguments: {},
      });
      expect(result.structuredContent).toEqual({
        ok: true,
        decision: { id: 'decision-1', title: 'Rate limiting' },
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
