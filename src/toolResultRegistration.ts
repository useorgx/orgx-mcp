import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getToolOutputSchema } from './openaiOutputSchemas';
import { sanitizeToolResultGuidance } from './toolGuidance';
import { prepareSearchResult, type SearchDeliveryObservation } from './searchResultDelivery';
import { withConsistentToolVisibility } from './toolVisibility';

/**
 * Apply profile-aware guidance filtering to subsequently registered tools.
 *
 * Every registration also gets the one visibility rule from
 * ./toolVisibility (model-visible unless widget-only). Tool configuration and
 * result envelopes are otherwise preserved verbatim, except that directory
 * submissions can opt into mirroring the existing title in annotations.title.
 * In particular, this wrapper never invents an outputSchema: it attaches one
 * only for a tool with a verified contract in the reviewed ChatGPT registry or
 * the v2 registry (see ./openaiOutputSchemas/v2.ts). An explicit schema on a
 * registration always wins so local and future tools retain their own contract.
 */
export function installToolResultGuidanceWrapper(
  mcpServer: McpServer,
  allowedTools: ReadonlySet<string> | null,
  onSearchResult?: (toolId: string, observation: SearchDeliveryObservation) => void,
  searchContext?: () => Promise<{ meta: Record<string, unknown> } | null>,
  includeAnnotationTitles = false
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
    // One visibility rule for every registration path (src/toolVisibility.ts).
    const visibleConfig = {
      ...config,
      ...(includeAnnotationTitles && typeof config.title === 'string' && config.title.trim()
        ? { annotations: { title: config.title, ...(config.annotations as Record<string, unknown> | undefined) } }
        : {}),
      _meta: withConsistentToolVisibility(
        name,
        config._meta as Record<string, unknown> | undefined
      ),
    };
    const nextConfig =
      registeredSchema && config.outputSchema === undefined
        ? { ...visibleConfig, outputSchema: registeredSchema }
        : visibleConfig;
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
