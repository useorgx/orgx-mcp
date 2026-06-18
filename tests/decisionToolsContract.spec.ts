import { describe, expect, it } from 'vitest';

import { CHATGPT_TOOL_DEFINITIONS } from '../src/toolDefinitions';

/**
 * Decision-tools contract.
 *
 * The decision family is the human-in-the-loop layer of the agent system —
 * if approve_decision silently stops accepting decision_id, every paused
 * agent in production stays paused. This spec pins the canonical input
 * schema, security scheme, and metadata expected by the live widget so
 * agent-side argument synthesis can't drift unnoticed.
 *
 * Pinned tools:
 *   - get_pending_decisions   (read; what's blocked)
 *   - approve_decision        (write; unblock with optional note)
 *   - reject_decision         (write; require reason)
 *
 * For each tool the test asserts:
 *   1. The tool is registered in CHATGPT_TOOL_DEFINITIONS.
 *   2. The expected input fields exist with the expected required-flag.
 *   3. Annotations match the read/write/destructive contract.
 *   4. The decisions widget output template is referenced (so the live
 *      surface and the MCP surface render the same artifact).
 */

interface DefinedTool {
  id: string;
  description: string;
  inputSchema: Record<string, { _def?: { typeName?: string } } & { isOptional?: () => boolean }>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  _meta?: Record<string, unknown>;
}

function findTool(id: string): DefinedTool {
  const tool = (CHATGPT_TOOL_DEFINITIONS as unknown as DefinedTool[]).find(
    (t) => t.id === id
  );
  if (!tool) throw new Error(`tool ${id} not found in CHATGPT_TOOL_DEFINITIONS`);
  return tool;
}

function isOptional(schema: unknown): boolean {
  // Zod schemas expose isOptional() at runtime.
  if (
    schema &&
    typeof schema === 'object' &&
    'isOptional' in schema &&
    typeof (schema as { isOptional?: () => boolean }).isOptional === 'function'
  ) {
    return (schema as { isOptional: () => boolean }).isOptional();
  }
  return false;
}

describe('decision tools contract', () => {
  describe('get_pending_decisions', () => {
    const tool = findTool('get_pending_decisions');

    it('is read-only', () => {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    });

    it('exposes optional limit / urgency_filter / initiative_id / workspace_id args', () => {
      expect(tool.inputSchema).toHaveProperty('limit');
      expect(tool.inputSchema).toHaveProperty('urgency_filter');
      expect(tool.inputSchema).toHaveProperty('initiative_id');
      expect(tool.inputSchema).toHaveProperty('workspace_id');
      expect(isOptional(tool.inputSchema.limit)).toBe(true);
      expect(isOptional(tool.inputSchema.urgency_filter)).toBe(true);
      expect(isOptional(tool.inputSchema.initiative_id)).toBe(true);
      expect(isOptional(tool.inputSchema.workspace_id)).toBe(true);
    });

    it('renders to the decisions widget output template', () => {
      expect(tool._meta).toMatchObject({
        'openai/outputTemplate': expect.stringContaining('decisions'),
        ui: { resourceUri: expect.stringContaining('decisions') },
      });
    });
  });

  describe('approve_decision', () => {
    const tool = findTool('approve_decision');

    it('is destructive (advances state)', () => {
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(true);
    });

    it('requires decision_id and accepts optional note + option_id', () => {
      expect(tool.inputSchema).toHaveProperty('decision_id');
      expect(tool.inputSchema).toHaveProperty('note');
      expect(tool.inputSchema).toHaveProperty('option_id');
      expect(isOptional(tool.inputSchema.decision_id)).toBe(false);
      expect(isOptional(tool.inputSchema.note)).toBe(true);
      expect(isOptional(tool.inputSchema.option_id)).toBe(true);
    });

    it('description mentions explicit user confirmation as a precondition', () => {
      // Approve is a destructive action; description must direct the agent
      // to surface the decision to the user before calling.
      expect(tool.description).toMatch(/user|confirm|approve/i);
      expect(tool.description).toContain('DO NOT USE');
    });

    it('renders to the decisions widget so the live + MCP surfaces match', () => {
      expect(tool._meta).toMatchObject({
        'openai/outputTemplate': expect.stringContaining('decisions'),
        ui: { resourceUri: expect.stringContaining('decisions') },
      });
    });
  });

  describe('reject_decision', () => {
    const tool = findTool('reject_decision');

    it('is destructive', () => {
      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(true);
    });

    it('requires decision_id AND reason — never accept a rejection without one', () => {
      expect(tool.inputSchema).toHaveProperty('decision_id');
      expect(tool.inputSchema).toHaveProperty('reason');
      expect(isOptional(tool.inputSchema.decision_id)).toBe(false);
      expect(isOptional(tool.inputSchema.reason)).toBe(false);
    });

    it('description tells the agent to always include a reason', () => {
      expect(tool.description.toLowerCase()).toContain('reason');
      expect(tool.description).toContain('DO NOT USE');
    });
  });

  it('the decision tool family shares one widget output template', () => {
    // Approve / reject / list all push the same widget so the human-in-the-loop
    // surface is consistent across read and write sides.
    const ids = ['get_pending_decisions', 'approve_decision', 'reject_decision'];
    const templates = ids.map(
      (id) =>
        (findTool(id)._meta as Record<string, unknown> | undefined)?.[
          'openai/outputTemplate'
        ]
    );
    expect(new Set(templates).size).toBe(1);
  });
});
