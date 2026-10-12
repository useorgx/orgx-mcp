import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { McpScaffoldWorkflowSchema } from '../src/generated/scaffoldWorkflow';
import { getWorkflowToolContract } from '../src/workflowTools';
import fixtures from './fixtures/scaffold-workflow-v1.json';

describe('generated Zod3 atomic scaffold contract', () => {
  it.each(fixtures)('$name', ({ body, valid, normalized }) => {
    const parsed = McpScaffoldWorkflowSchema.safeParse(body);
    expect(parsed.success).toBe(valid);
    if (parsed.success) expect(parsed.data).toEqual(normalized);
    const tool = getWorkflowToolContract('orgx_validate_initiative_plan')!;
    const edge = z.object(tool.inputSchema).strict().safeParse(body);
    expect(edge.success).toBe(valid);
    if (edge.success) {
      expect(tool.backendRequest!(edge.data).body).toEqual(body && parsed.success
        ? { plan: parsed.data.plan, ...(parsed.data.source_evidence ? { source_evidence: parsed.data.source_evidence } : {}) }
        : undefined);
    }
  });

  it('generates closed MCP discovery schemas from the portable Zod3 source', () => {
    const shape = getWorkflowToolContract('orgx_validate_initiative_plan')!.inputSchema;
    const schema = zodToJsonSchema(z.object(shape).strict(), { $refStrategy: 'none' });
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['plan'] });
    const text = JSON.stringify(schema);
    expect(text).toContain('"maxItems":20');
    expect(text).toContain('"verified_by"');
    expect(text).not.toContain('"owner_id"');
  });
});

describe('legacy scaffold compatibility during the atomic migration', () => {
  it('keeps the legacy evidence contract separate from bounded atomic provenance', () => {
    const tool = getWorkflowToolContract('orgx_create_and_launch_initiative_hierarchy')!;
    expect(tool).toBeDefined();
    const schema = z.object(tool.inputSchema).strict();
    const evidence = { target_url: 'https://example.org/source', verification_state: 'partial', evidence_urls: Array(21).fill('https://example.org/proof'), notes: 'x'.repeat(4001) };
    expect(schema.safeParse({ title: 'Delivery', source_evidence: evidence }).success).toBe(true);
    expect(schema.safeParse({ title: 'Delivery', source_evidence: { ...evidence, verified_by: 'fixture' } }).success).toBe(false);
  });
});

describe('edge Zod3 compatibility boundary', () => {
  it.each(['11111111-1111-0111-8111-111111111111', '11111111-1111-a111-8111-111111111111', '11111111-1111-4111-8111-111111111111'])('retains edge UUID preflight for %s; OrgX remains authoritative', (workspace_id) => {
    expect(McpScaffoldWorkflowSchema.safeParse({ workspace_id, plan: fixtures[0].body.plan }).success).toBe(true);
  });
  it('retains Zod3 URL material for canonical server normalization', () => {
    const parsed = McpScaffoldWorkflowSchema.parse({ plan: fixtures[0].body.plan,
      source_evidence: { verification_state: 'partial', target_url: ' https://example.org/proof ' } });
    expect(parsed.source_evidence?.target_url).toBe(' https://example.org/proof ');
  });
});
