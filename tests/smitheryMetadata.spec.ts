import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  STREAM_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';
import { smitheryConfigSchema } from '../src/smitheryConfig';

const root = process.cwd();
const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
) as {
  remotes?: Array<{ type?: string; url?: string }>;
};
const indexSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');

function inputShapeEntries(
  inputSchema: unknown
): Array<[string, z.ZodTypeAny]> {
  if (inputSchema instanceof z.ZodObject) {
    return Object.entries(inputSchema.shape) as Array<[string, z.ZodTypeAny]>;
  }
  if (inputSchema && typeof inputSchema === 'object') {
    return Object.entries(inputSchema) as Array<[string, z.ZodTypeAny]>;
  }
  return [];
}

describe('Smithery metadata coverage', () => {
  const allDefinitions = [
    ...PLAN_SESSION_TOOLS,
    ...CHATGPT_TOOL_DEFINITIONS,
    ...CLIENT_INTEGRATION_TOOL_DEFINITIONS,
    ...STREAM_TOOL_DEFINITIONS,
    ...CONTRACT_TOOL_DEFINITIONS,
    ...FLYWHEEL_TOOL_DEFINITIONS,
  ];

  it('exports a Smithery config schema with optional connection defaults', () => {
    const parsed = smitheryConfigSchema.parse({});
    expect(parsed.profile).toBe('full');

    const shape = smitheryConfigSchema.shape;
    expect(shape.profile.description).toContain('tool profile');
    expect(shape.workspace_id.description).toContain('workspace UUID');
    expect(shape.initiative_id.description).toContain('initiative UUID');
    expect(indexSource).toContain(
      'export const configSchema = buildSmitheryConfigSchema();'
    );
  });

  it('publishes direct MCP remotes instead of the landing-page root URL', () => {
    expect(serverJson.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.useorgx.com/mcp' },
      { type: 'sse', url: 'https://mcp.useorgx.com/sse' },
    ]);
  });

  it('does not expose the test widget in production metadata', () => {
    const serializedServerJson = JSON.stringify(serverJson);
    expect(serializedServerJson).not.toContain('test-minimal');
    expect(indexSource).not.toContain('testMinimal:');
    expect(existsSync(resolve(root, 'public/widgets/test-minimal.html'))).toBe(
      false
    );
  });

  it('gives every shared tool explicit annotations', () => {
    for (const tool of allDefinitions) {
      expect(tool.annotations, `${tool.id} is missing annotations`).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
  });

  it('gives every top-level shared tool parameter a description', () => {
    for (const tool of allDefinitions) {
      for (const [fieldName, fieldSchema] of inputShapeEntries(tool.inputSchema)) {
        expect(
          fieldSchema?.description,
          `${tool.id}.${fieldName} is missing a description`
        ).toBeTruthy();
      }
    }
  });

  it('keeps audited inline tools annotated with described top-level parameters', () => {
    const expectations: Record<string, string[]> = {
      account_status: ['description:', "user_id: z.string().optional().describe("],
      account_upgrade: [
        'description:',
        "target_plan: z",
        "billing_cycle: z",
        "user_id: z.string().optional().describe(",
      ],
      account_usage_report: [
        'description:',
        "user_id: z.string().optional().describe(",
      ],
      comment_on_entity: [
        'annotations: {',
        "entity_type: z.enum([",
        '.describe(\'Entity type to comment on.',
        '.describe(\'Comment body in plain text or markdown.',
        '.describe(\'Optional structured metadata attached to the comment.',
      ],
      list_entity_comments: [
        'annotations: {',
        '.describe(\'Entity type to read comments for.',
        '.describe(\'Pagination cursor from a previous response.',
      ],
      batch_action: [
        'annotations: {',
        'List of lifecycle actions to execute in bulk.',
      ],
      stats: [
        'Whether to return personal stats or current-session diagnostics.',
        'Time window for the requested statistics.',
      ],
      get_outcome_attribution: [
        'annotations: {',
        'Time period for ROI calculation.',
        'Optional capability key filter.',
      ],
      record_outcome: [
        'annotations: {',
        'Outcome type key, such as deal_closed or meeting_booked.',
        'Optional structured context attached to the outcome record.',
      ],
      get_my_trust_context: [
        'annotations: {',
        'Agent type to fetch trust data for.',
      ],
      start_autonomous_session: [
        'annotations: {',
        'Autonomy session mode to start.',
        'Maximum number of receipts the session may produce.',
      ],
      get_relevant_learnings: [
        'annotations: {',
        'Optional keywords for semantic matching.',
      ],
      submit_learning: [
        'annotations: {',
        'Type of learning being submitted.',
        'Optional receipt IDs that support the learning.',
      ],
    };

    for (const [toolId, snippets] of Object.entries(expectations)) {
      const registrationMatch = new RegExp(
        `registerTool\\(\\s*'${toolId}'([\\s\\S]*?)(?=registerTool\\(|registerAppTool\\(|private registerResources\\()`,
        'm'
      ).exec(indexSource);
      expect(
        registrationMatch,
        `Missing registration block for ${toolId}`
      ).not.toBeNull();
      const block = registrationMatch![1];

      for (const snippet of snippets) {
        expect(block, `${toolId} is missing snippet: ${snippet}`).toContain(
          snippet
        );
      }
    }
  });
});
