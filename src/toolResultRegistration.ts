import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getToolOutputSchema } from './openaiOutputSchemas';
import { sanitizeToolResultGuidance } from './toolGuidance';
import { prepareSearchResult, type SearchDeliveryObservation } from './searchResultDelivery';

/**
 * Apply profile-aware guidance filtering to subsequently registered tools.
 *
 * Tool configuration and result envelopes are otherwise preserved verbatim.
 * In particular, this wrapper never invents an outputSchema: it attaches one
 * only for a tool with a verified contract in the reviewed ChatGPT registry or
 * the v2 registry (see ./openaiOutputSchemas/v2.ts). An explicit schema on a
 * registration always wins so local and future tools retain their own contract.
 */
export function installToolResultGuidanceWrapper(
  mcpServer: McpServer,
  allowedTools: ReadonlySet<string> | null,
  onSearchResult?: (toolId: string, observation: SearchDeliveryObservation) => void,
  searchContext?: () => Promise<{ meta: Record<string, unknown> } | null>
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
    const registeredSchema = getToolOutputSchema(name);
    const nextConfig =
      registeredSchema && config.outputSchema === undefined
        ? { ...config, outputSchema: registeredSchema }
        : config;
    const wrappedHandler = async (...args: unknown[]) => {
      const result = prepareSearchResult(name, sanitizeToolResultGuidance(
        (await handler(...args)) as
          | { structuredContent?: unknown }
          | null
          | undefined,
        allowedTools
      ), (observation) => onSearchResult?.(name, observation));
      if (!result || !searchContext || !['orgx_search', 'query_org_memory'].includes(name)) return result;
      try {
        const context = await searchContext();
        if (!context) return result;
        return {
          ...result,
          _meta: { ...(result as { _meta?: Record<string, unknown> })._meta, 'orgx/widgetDiagnostics': context.meta },
        };
      } catch {
        // Monitoring cannot turn a healthy search into a failed request.
        return result;
      }
    };
    return original(name, nextConfig, wrappedHandler);
  }) as typeof server.registerTool;
}
