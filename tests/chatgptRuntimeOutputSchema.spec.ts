import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

import { installStandardToolRegistrationWrapper } from '../src/standardToolRegistration';
import { CHATGPT_PUBLIC_SURFACE } from '../src/toolProfiles';

describe('ChatGPT runtime tools/list contract', () => {
  it('advertises a non-null open outputSchema for every profile tool', async () => {
    const server = new McpServer({
      name: 'orgx-chatgpt-output-schema-test',
      version: '1.0.0',
    });
    const allowedTools = new Set<string>(CHATGPT_PUBLIC_SURFACE);
    installStandardToolRegistrationWrapper(server, allowedTools);

    for (const name of CHATGPT_PUBLIC_SURFACE) {
      server.registerTool(
        name,
        {
          description: `${name} profile contract probe`,
          inputSchema: {},
        },
        async () => ({ content: [{ type: 'text', text: 'ok' }] })
      );
    }

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: 'orgx-chatgpt-output-schema-client',
      version: '1.0.0',
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const descriptor = await client.listTools();

      expect(descriptor.tools.map((tool) => tool.name).sort()).toEqual(
        [...CHATGPT_PUBLIC_SURFACE].sort()
      );
      for (const tool of descriptor.tools) {
        expect(tool.outputSchema, `${tool.name} outputSchema`).toMatchObject({
          type: 'object',
          additionalProperties: true,
        });
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
