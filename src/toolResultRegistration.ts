import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getOpenAiOutputSchema } from './openaiOutputSchemas';
import { sanitizeToolResultGuidance } from './toolGuidance';

/**
 * Apply profile-aware guidance filtering to subsequently registered tools.
 *
 * Tool configuration and result envelopes are otherwise preserved verbatim.
 * In particular, this wrapper never invents an outputSchema for tools outside
 * the exact, reviewed ChatGPT public schema registry. An explicit schema on a
 * registration always wins so local and future tools retain their own contract.
 */
export function installToolResultGuidanceWrapper(
  mcpServer: McpServer,
  allowedTools: ReadonlySet<string> | null
) {
  const server = mcpServer as unknown as {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: (...args: unknown[]) => unknown
    ) => unknown;
  };
  const original = server.registerTool.bind(server);

  server.registerTool = ((
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown
  ) => {
    const registeredSchema = getOpenAiOutputSchema(name);
    const nextConfig =
      registeredSchema && config.outputSchema === undefined
        ? { ...config, outputSchema: registeredSchema }
        : config;
    const wrappedHandler = async (...args: unknown[]) =>
      sanitizeToolResultGuidance(
        (await handler(...args)) as
          | { structuredContent?: unknown }
          | null
          | undefined,
        allowedTools
      );
    return original(name, nextConfig, wrappedHandler);
  }) as typeof server.registerTool;
}
