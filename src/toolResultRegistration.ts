import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CLAUDE_DIRECTORY_TOOL_DESCRIPTIONS } from './claudeDirectoryToolMetadata';
import { CLAUDE_DIRECTORY_ADAPTER_IDS } from './claudeDirectoryTools';
import { getToolOutputSchema } from './openaiOutputSchemas';
import { sanitizeToolResultGuidance } from './toolGuidance';
import { prepareSearchResult, type SearchDeliveryObservation } from './searchResultDelivery';
import { withConsistentToolVisibility } from './toolVisibility';
import { getWorkflowToolContract } from './workflowTools';
import { buildWidgetToolSurface } from './widgetToolSurface';

function directoryToolMeta(name: string, meta: Record<string, unknown> | undefined) {
  if (name !== 'review_artifact') return meta;
  // This profile returns the review envelope without an interactive widget:
  // its shared widget calls broad mutation routers that Claude does not list.
  const next = { ...meta };
  delete next['openai/outputTemplate'];
  delete next['ui/resourceUri'];
  if (next.ui && typeof next.ui === 'object') {
    next.ui = { ...(next.ui as Record<string, unknown>) };
    delete (next.ui as Record<string, unknown>).resourceUri;
  }
  return next;
}

function withoutWidgetPresentation(meta: Record<string, unknown> | undefined) {
  const next = { ...meta };
  delete next['openai/outputTemplate'];
  delete next['ui/resourceUri'];
  delete next['openai/widgetAccessible'];
  if (next.ui && typeof next.ui === 'object') {
    next.ui = { ...(next.ui as Record<string, unknown>) };
    delete (next.ui as Record<string, unknown>).resourceUri;
  }
  return next;
}

/**
 * Apply profile-aware guidance filtering to subsequently registered tools.
 *
 * Every registration also gets the one visibility rule from
 * ./toolVisibility (model-visible unless widget-only). Tool configuration and
 * result envelopes are otherwise preserved verbatim, except that directory
 * submissions can opt into narrow descriptions and mirroring the existing
 * title in annotations.title.
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
  includeDirectoryMetadata = false,
  profile?: string,
  legacyDirectoryContracts = false
) {
  const server = mcpServer as unknown as {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: (...args: unknown[]) => unknown
    ) => unknown;
  };
  const original = server.registerTool.bind(server);
  const registeredTools = new Set<string>();

  server.registerTool = ((
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown
  ) => {
    // Retained directory adapters return their original flat router outputs.
    // Some IDs also name new operations with different envelopes. The old
    // registrations never advertised output schemas, so do not infer the new
    // operation's schema for them. Explicit registration schemas still win.
    const registeredSchema = (legacyDirectoryContracts || profile === 'claude-directory-legacy') && CLAUDE_DIRECTORY_ADAPTER_IDS.includes(name)
      ? undefined : getToolOutputSchema(name);
    // One visibility rule for every registration path (src/toolVisibility.ts).
    const visibleConfig = {
      ...config,
      ...(includeDirectoryMetadata && typeof config.description === 'string'
        ? { description: (getWorkflowToolContract(name) ? config.description : CLAUDE_DIRECTORY_TOOL_DESCRIPTIONS[name] ?? config.description).split(/(?:Also known as:|USE WHEN:|NEXT:|DO NOT USE:)/i)[0].trim() }
        : {}),
      ...(includeDirectoryMetadata && typeof config.title === 'string' && config.title.trim()
        ? { annotations: { title: config.title, ...(config.annotations as Record<string, unknown> | undefined) } }
        : {}),
      _meta: withConsistentToolVisibility(
        name,
        profile === 'claude-code-legacy'
          ? withoutWidgetPresentation(config._meta as Record<string, unknown> | undefined)
          : includeDirectoryMetadata
          ? directoryToolMeta(name, config._meta as Record<string, unknown> | undefined)
          : config._meta as Record<string, unknown> | undefined
      ),
    };
    const nextConfig =
      registeredSchema && config.outputSchema === undefined
        ? { ...visibleConfig, outputSchema: registeredSchema }
        : visibleConfig;
    const wrappedHandler = async (...args: unknown[]) => {
      const prepared = prepareSearchResult(name, sanitizeToolResultGuidance(
        (await handler(...args)) as
          | { structuredContent?: unknown }
          | null
          | undefined,
        allowedTools,
        profile ?? includeDirectoryMetadata
      ), (observation) => onSearchResult?.(name, observation));
      const result = prepared && typeof prepared === 'object' ? {
        ...prepared,
        _meta: {
          ...(prepared as { _meta?: Record<string, unknown> })._meta,
          'orgx/toolSurface': buildWidgetToolSurface(profile ?? 'v2', registeredTools, allowedTools),
        },
      } : prepared;
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
    const tool = original(name, nextConfig, wrappedHandler);
    registeredTools.add(name);
    return tool;
  }) as typeof server.registerTool;
}
