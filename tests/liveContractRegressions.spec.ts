import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import {
  CHATGPT_TOOL_DEFINITIONS,
  SECURITY_SCHEMES,
} from '../src/toolDefinitions';

const workerSource = readFileSync(
  resolve(process.cwd(), 'src/index.ts'),
  'utf8'
);

function contractSchema(toolId: string): Record<string, z.ZodTypeAny> {
  const tool = CONTRACT_TOOL_DEFINITIONS.find((entry) => entry.id === toolId);
  expect(tool, `${toolId} should be registered`).toBeDefined();
  return tool!.inputSchema as Record<string, z.ZodTypeAny>;
}

describe('live MCP contract regressions', () => {
  it('rejects dangerous search pagination values at schema and execution layers', () => {
    const schema = contractSchema('orgx_search');

    expect(() => schema.limit.parse(-1)).toThrow();
    expect(() => schema.limit.parse(0)).toThrow();
    expect(() => schema.limit.parse(1000)).toThrow();
    expect(() => schema.limit.parse(100)).not.toThrow();
    expect(() => schema.offset.parse(-1)).toThrow();

    const handlerStart = workerSource.indexOf("case 'orgx_search':");
    const handlerEnd = workerSource.indexOf(
      "case 'orgx_recommend':",
      handlerStart
    );
    const handler = workerSource.slice(handlerStart, handlerEnd);
    expect(handler).toContain(
      'orgx_search limit must be an integer between 1 and 100'
    );
    expect(handler).toContain(
      'orgx_search offset must be a non-negative integer'
    );
    expect(handler.indexOf('Number.isInteger(limit)')).toBeLessThan(
      handler.indexOf('this.fetchBroadOrgxSearch')
    );
    expect(handler.indexOf('Number.isInteger(offset)')).toBeLessThan(
      handler.indexOf('this.fetchEntityCollectionPage')
    );
  });

  it('requires authenticated identity for both recommendation surfaces', () => {
    const compact = CONTRACT_TOOL_DEFINITIONS.find(
      (entry) => entry.id === 'orgx_recommend'
    );
    const direct = CHATGPT_TOOL_DEFINITIONS.find(
      (entry) => entry.id === 'recommend_next_action'
    );

    expect(compact?.securitySchemes).toEqual(
      SECURITY_SCHEMES.entityReadRequiresAuth
    );
    expect(direct?.securitySchemes).toEqual(
      SECURITY_SCHEMES.entityReadRequiresAuth
    );
    expect(workerSource).toContain(
      "this.resolveOrgxUserId(resolvedUserId) ?? resolvedUserId"
    );
  });

  it('validates agent-status UUID filters before they reach Postgres', () => {
    const status = CHATGPT_TOOL_DEFINITIONS.find(
      (entry) => entry.id === 'get_agent_status'
    );
    expect(status).toBeDefined();
    const schema = status!.inputSchema as Record<string, z.ZodTypeAny>;

    for (const field of [
      'workspace_id',
      'command_center_id',
      'initiative_id',
    ]) {
      expect(() => schema[field].parse('not-a-uuid')).toThrow();
      expect(() =>
        schema[field].parse('6ba7b812-9dad-11d1-80b4-00c04fd430c8')
      ).not.toThrow();
    }
  });

  it('documents plan resume fallback exactly as implemented', () => {
    const plan = CONTRACT_TOOL_DEFINITIONS.find(
      (entry) => entry.id === 'orgx_plan'
    );
    expect(plan?.description).toContain(
      'Optional session_id; when omitted, resumes the most recent active session'
    );
    expect(
      (plan!.inputSchema as Record<string, z.ZodTypeAny>).session_id.description
    ).toContain('Optional for action=resume');
  });

  it('validates morning-brief workspace IDs and maps upstream 404s', () => {
    const start = workerSource.indexOf(
      "registerAppTool(\n        this.server,\n        'get_morning_brief'"
    );
    const end = workerSource.indexOf(
      '// --- get_relevant_learnings ---',
      start
    );
    const handler = workerSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler).toMatch(/workspace_id:\s*z\s*\.string\(\)\s*\.uuid\(\)/);
    expect(handler).toContain('if (!response.ok)');
    expect(handler).toContain("'workspace_not_found'");
    expect(handler).toContain('Workspace not found or not accessible');
  });
});
