import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { sanitizeToolResultGuidance } from './toolGuidance';

/**
 * Apply profile-aware guidance filtering to subsequently registered tools.
 *
 * Tool configuration and result envelopes are otherwise preserved verbatim.
 * In particular, this wrapper never invents an outputSchema: tools that
 * return structuredContent must declare an exact tool-specific schema and
 * validate representative handler results before that schema is advertised.
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
    const wrappedHandler = async (...args: unknown[]) =>
      sanitizeToolResultGuidance(
        (await handler(...args)) as
          | { structuredContent?: unknown }
          | null
          | undefined,
        allowedTools
      );
    return original(name, config, wrappedHandler);
  }) as typeof server.registerTool;
}
