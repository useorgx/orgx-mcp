import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { STANDARD_TOOL_OUTPUT_OBJECT_SCHEMA } from '../src/toolDefinitions';

describe('standard MCP tool output schema', () => {
  it('passes representative bootstrap and chronology fields through strict client validation', async () => {
    const server = new McpServer({
      name: 'orgx-output-schema-regression',
      version: '1.0.0',
    });
    server.registerTool(
      'orgx_bootstrap',
      {
        inputSchema: {},
        outputSchema: STANDARD_TOOL_OUTPUT_OBJECT_SCHEMA,
      },
      async () => ({
        content: [{ type: 'text' as const, text: 'OrgX contract ready.' }],
        structuredContent: {
          profile: 'full',
          visible_tools_count: 42,
          decisionChronology: {
            count: 1,
            items: [{ id: 'decision-1', title: 'Ship continuity' }],
          },
          artifactLedger: {
            count: 1,
            items: [{ id: 'artifact-1', name: 'Continuity proof' }],
          },
        },
      })
    );

    const client = new Client({
      name: 'strict-opencode-compatible-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const listed = await client.listTools();
      expect(listed.tools[0]?.outputSchema?.additionalProperties).toBe(true);

      const result = await client.callTool({
        name: 'orgx_bootstrap',
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        profile: 'full',
        decisionChronology: { count: 1 },
        artifactLedger: { count: 1 },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
