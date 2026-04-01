import { readFileSync } from 'node:fs';
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
import { configSchema } from '../src/smitheryConfig';

const root = process.cwd();
const serverJson = JSON.parse(
  readFileSync(resolve(root, 'server.json'), 'utf8')
) as {
  remotes?: Array<{ type?: string; url?: string }>;
};

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
    const parsed = configSchema.parse({});
    expect(parsed.profile).toBe('full');

    const shape = configSchema.shape;
    expect(shape.profile.description).toContain('tool profile');
    expect(shape.workspace_id.description).toContain('workspace UUID');
    expect(shape.initiative_id.description).toContain('initiative UUID');
  });

  it('publishes direct MCP remotes instead of the landing-page root URL', () => {
    expect(serverJson.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mcp.useorgx.com/mcp' },
      { type: 'sse', url: 'https://mcp.useorgx.com/sse' },
    ]);
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
});

