import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { sanitizeToolResultGuidance } from './toolGuidance';
import {
  STANDARD_TOOL_OUTPUT_SCHEMA_OBJECT,
  ensureStructuredContent,
  normalizeToolResultEnvelope,
} from './toolDefinitions';

/**
 * Apply the standard, open output envelope to every subsequently registered
 * MCP tool. Keeping this wrapper independent from the Worker makes the exact
 * tools/list contract testable over an in-memory MCP transport.
 */
export function installStandardToolRegistrationWrapper(
  mcpServer: McpServer,
  allowedTools: ReadonlySet<string> | null
) {
  const server = mcpServer as unknown as {
    registerTool: (
      name: string,
      config: Record<string, unknown> & { outputSchema?: unknown },
      handler: (...args: unknown[]) => unknown
    ) => unknown;
  };
  const original = server.registerTool.bind(server);

  server.registerTool = ((
    name: string,
    config: Record<string, unknown> & { outputSchema?: unknown },
    handler: (...args: unknown[]) => unknown
  ) => {
    const enhancedConfig = {
      ...config,
      // A constructed .passthrough() object, NOT the raw shape: a raw shape
      // compiles to additionalProperties:false and rejects rich tool-specific
      // structuredContent payloads.
      outputSchema:
        config.outputSchema ??
        (STANDARD_TOOL_OUTPUT_SCHEMA_OBJECT as unknown as Record<
          string,
          unknown
        >),
    };
    const wrappedHandler = async (...args: unknown[]) => {
      const result = await handler(...args);
      const withStructuredContent = ensureStructuredContent(
        result as {
          structuredContent?: unknown;
          isError?: boolean;
          content?: ReadonlyArray<unknown>;
        }
      );
      const withEnvelope = normalizeToolResultEnvelope(withStructuredContent);
      return sanitizeToolResultGuidance(withEnvelope, allowedTools);
    };
    return original(name, enhancedConfig, wrappedHandler);
  }) as typeof server.registerTool;
}
