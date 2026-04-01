import { z } from 'zod';

export const SMITHERY_TOOL_PROFILES = [
  'full',
  'commander',
  'planner',
  'executor',
  'observer',
] as const;

export function buildSmitheryConfigSchema() {
  return z.object({
    profile: z
      .enum(SMITHERY_TOOL_PROFILES)
      .default('full')
      .describe(
        'Optional tool profile to expose a narrower toolset at connection time. Defaults to full access.'
      ),
    workspace_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Optional default workspace UUID to seed MCP session context for routing and recommendations.'
      ),
    initiative_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Optional default initiative UUID to seed MCP session context for scoped workflows.'
      ),
  });
}

export const smitheryConfigSchema = buildSmitheryConfigSchema();
