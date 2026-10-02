import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';
import { CHATGPT_TOOL_DEFINITIONS, expandConsolidatedTool } from '../src/toolDefinitions';

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
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: Record<string, unknown>;
}

function findTool(id: string): DefinedTool {
  const tool = (CHATGPT_TOOL_DEFINITIONS as unknown as DefinedTool[]).find(
    (t) => t.id === id
  );
  if (!tool) throw new Error(`tool ${id} not found in CHATGPT_TOOL_DEFINITIONS`);
  return tool;
}

function findContractTool(id: string): DefinedTool {
  const tool = (CONTRACT_TOOL_DEFINITIONS as unknown as DefinedTool[]).find(
    (entry) => entry.id === id
  );
  if (!tool) throw new Error(`contract tool ${id} not found`);
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

  it('keeps consolidated review routers closed-world and non-destructive', () => {
    for (const id of ['orgx_decide', 'approve_agent_work']) {
      const tool = findContractTool(id);
      expect(tool.annotations, id).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.description, id).toContain('human-session-only');
      expect(tool.description, id).toContain('return a review URL');
      expect(tool.description, id).toContain('never resolve');
      expect(tool.description, id).not.toContain('approval can resume');

      const note = tool.inputSchema.note as { description?: string } | undefined;
      const reason = tool.inputSchema.reason as { description?: string } | undefined;
      expect(note?.description, id).toContain('does not persist');
      expect(reason?.description, id).toContain('does not persist');
    }
  });

  it('describes legacy decision actions truthfully: the person decides, not the model', () => {
    const approve = findTool('approve_decision');
    const reject = findTool('reject_decision');

    expect(approve.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(reject.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(approve.description).toContain('A model cannot settle a decision');
    expect(reject.description).toContain('A model cannot settle a decision');
    expect(approve.description).toContain('review_url');
    expect(approve.description).toContain('DO NOT USE');
    expect(reject.description).toContain('DO NOT USE');
  });

  it('keeps the widget decision tool off the model surface and token-gated', () => {
    const widgetDecide = findTool('orgx_widget_decide');
    const meta = widgetDecide._meta as Record<string, unknown>;
    expect(meta['openai/outputTemplate']).toBeUndefined();
    expect(meta['openai/readOnlyHint']).toBeUndefined();
    expect(meta['openai/widgetAccessible']).toBe(true);
    expect(Object.keys(widgetDecide.inputSchema)).toContain('approval_token');
  });

  it('lets the widget send the chosen option or options with an approval', () => {
    const widgetDecide = findTool('orgx_widget_decide');
    const schema = z.object(widgetDecide.inputSchema as z.ZodRawShape);
    const base = { decision_id: 'd-1', action: 'approve', approval_token: 'tok' };
    expect(schema.parse({ ...base, option_id: 'opt-b' })).toEqual({ ...base, option_id: 'opt-b' });
    expect(schema.parse({ ...base, option_ids: ['eu', 'us'] })).toEqual({ ...base, option_ids: ['eu', 'us'] });
    expect(schema.safeParse({ ...base, option_ids: [] }).success).toBe(false);
    expect(schema.parse(base)).toEqual(base);
    const args = { ...base, option_id: 'opt-b', option_ids: ['eu'] };
    expect(expandConsolidatedTool('orgx_widget_decide', args)).toEqual({ resolvedToolId: 'widget_decide', resolvedArgs: args });
  });

  it('carries the item kind and a typed answer, within the app limits', () => {
    const widgetDecide = findTool('orgx_widget_decide');
    const schema = z.object(widgetDecide.inputSchema as z.ZodRawShape);
    const base = { decision_id: 'd-1', action: 'approve', approval_token: 'tok' };
    for (const kind of ['decision', 'approval', 'action']) {
      expect(schema.parse({ ...base, kind })).toEqual({ ...base, kind });
    }
    expect(schema.safeParse({ ...base, kind: 'run' }).success).toBe(false);
    expect(schema.parse({ ...base, answer: 'Use the staging keys.' })).toEqual({ ...base, answer: 'Use the staging keys.' });
    expect(schema.safeParse({ ...base, answer: 'x'.repeat(2001) }).success).toBe(false);
    expect(schema.safeParse({ ...base, reason: 'x'.repeat(2001) }).success).toBe(false);
    expect(schema.safeParse({ ...base, option_id: 'x'.repeat(121) }).success).toBe(false);
    expect(schema.safeParse({ ...base, option_ids: Array.from({ length: 13 }, (_, i) => `o${i}`) }).success).toBe(false);
    const args = { ...base, kind: 'action', action: 'reject', reason: 'Wrong account', answer: 'n/a' };
    expect(expandConsolidatedTool('orgx_widget_decide', args)).toEqual({ resolvedToolId: 'widget_decide', resolvedArgs: args });
  });

  it('describes the settled item, including its kind and route', () => {
    const output = WIDGET_OUTPUT_SCHEMAS.orgx_widget_decide;
    const settled = {
      decision_id: 'a-1',
      kind: 'action',
      action: 'approved',
      status: 'approved',
      route: 'action_gateway',
      surface: 'host_widget',
    };
    expect(output.parse(settled)).toEqual(settled);
    expect(output.safeParse({ ...settled, kind: 'run' }).success).toBe(false);
  });
});
