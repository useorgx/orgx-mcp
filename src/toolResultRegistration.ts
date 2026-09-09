import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { getOpenAiOutputSchema } from './openaiOutputSchemas';
import { sanitizeToolResultGuidance } from './toolGuidance';

type StructuredToolResult =
  | { structuredContent?: unknown; isError?: boolean }
  | null
  | undefined;

/**
 * Project successful public-tool results onto the exact contract advertised to
 * MCP clients. OrgX API resources are intentionally forward-compatible, so a
 * newer API can add metadata before the MCP schema is updated. Closed-schema
 * clients reject the whole tool result when that metadata leaks through.
 *
 * Only undeclared object keys are removed. Declared values still run through
 * their complete validators, so type mismatches remain visible instead of
 * being coerced or hidden.
 */
export function conformStructuredContentToOutputSchema(
  schema: z.AnyZodObject,
  result: StructuredToolResult
): StructuredToolResult {
  if (
    !result ||
    result.isError === true ||
    !result.structuredContent ||
    typeof result.structuredContent !== 'object' ||
    Array.isArray(result.structuredContent)
  ) {
    return result;
  }

  const projected = { ...(result.structuredContent as Record<string, unknown>) };
  const allowedKeys = new Set(Object.keys(schema.shape));
  let changed = false;

  for (const key of Object.keys(projected)) {
    if (!allowedKeys.has(key)) {
      delete projected[key];
      changed = true;
    }
  }

  const parsed = schema.safeParse(projected);
  if (!parsed.success) {
    // Do not conceal declared-field contract failures. The MCP SDK/client will
    // surface the original validation error, preserving a reproducible signal.
    return result;
  }

  const normalized = parsed.data;
  if (!changed && normalized === result.structuredContent) return result;
  return { ...result, structuredContent: normalized };
}

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
    const wrappedHandler = async (...args: unknown[]) => {
      const sanitized = sanitizeToolResultGuidance(
        (await handler(...args)) as StructuredToolResult,
        allowedTools
      );
      return name === 'orgx_plan' && registeredSchema
        ? conformStructuredContentToOutputSchema(registeredSchema, sanitized)
        : sanitized;
    };
    return original(name, nextConfig, wrappedHandler);
  }) as typeof server.registerTool;
}
