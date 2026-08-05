import { z } from 'zod';

export const SMITHERY_TOOL_PROFILES = [
  'v2',
  'chatgpt',
  'claude-directory',
  'full',
  'memory',
  'commander',
  'planner',
  'executor',
  'observer',
] as const;

export function buildSmitheryConfigSchema() {
  return z.object({
    profile: z
      .enum(SMITHERY_TOOL_PROFILES)
      .default('v2')
      .describe(
        'Optional tool profile to expose at connection time. Use chatgpt for the streamlined ChatGPT App review surface or claude-directory for the focused read-only Anthropic Connector Directory surface. Defaults to the published v2 surface; full is explicit admin/debug compatibility.'
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
