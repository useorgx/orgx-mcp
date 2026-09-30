import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { getOpenAiOutputSchema } from '../src/openaiOutputSchemas';
import { buildPlanSessionInspectionResult, buildPlanSessionStructuredResult } from '../src/planSessionContract';

const ID = '11111111-1111-4111-8111-111111111111';
async function callWithAdvertisedSchema(tool: string, payload: Record<string, unknown>) {
  const server = new McpServer({ name: 'plan-output-compatibility', version: '1.0.0' });
  server.registerTool(tool, {
    inputSchema: {}, outputSchema: getOpenAiOutputSchema(tool)!.shape,
  }, async () => ({
    content: [{ type: 'text' as const, text: 'Persisted plan receipt' }],
    structuredContent: payload,
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'strict-plan-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { return await client.callTool({ name: tool, arguments: {} }); }
  finally { await Promise.allSettled([client.close(), server.close()]); }
}

describe('persisted planning output compatibility', () => {
  it('delivers a completed attachment receipt despite the newer API requested count', async () => {
    const payload = buildPlanSessionStructuredResult('complete_plan', {
      session_id: ID, status: 'completed',
      context_attachments: { requested: 1, attached_count: 1, skipped_count: 0, errors: [] },
    }, { session_id: ID });
    const result = await callWithAdvertisedSchema('orgx_plan', payload);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'completed', context_attachments: { attached_count: 1, skipped_count: 0, errors: [] },
    });
    expect((result.structuredContent as any).context_attachments).not.toHaveProperty('requested');
  });

  it('delivers attachment failures with the affected entity and reason', async () => {
    const payload = buildPlanSessionStructuredResult('complete_plan', {
      session_id: ID, status: 'completed',
      context_attachments: {
        requested: 1, attached_count: 0, skipped_count: 0,
        errors: [{ entity_type: 'initiative', entity_id: ID, error: 'Entity not found' }],
      },
    }, { session_id: ID });
    const result = await callWithAdvertisedSchema('orgx_plan', payload);
    expect((result.structuredContent as any).context_attachments).toMatchObject({
      attached_count: 0, errors: ['initiative: ' + ID + ': Entity not found'],
    });
  });

  it('inspects a resumed plan within the declared envelope, retaining its saved state', async () => {
    const payload = buildPlanSessionInspectionResult({
      id: ID, owner_id: 'owner', workspace_id: ID,
      title: 'Plugin launch', feature_name: 'Plugin launch',
      status: 'completed', current_plan: '# Saved plan', plan_version: 2,
      patterns_applied: [], started_at: '2026-09-30T00:00:00Z',
      last_edit_at: null, completed_at: '2026-09-30T00:10:00Z', edits: [],
    });
    const result = await callWithAdvertisedSchema('orgx_inspect', payload);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      type: 'plan_session', id: ID, current_plan: '# Saved plan',
      plan_session: { owner_id: 'owner', status: 'completed', current_plan: '# Saved plan', plan_version: 2 },
    });
    expect(result.structuredContent).not.toHaveProperty('owner_id');
  });

  it('leaves error payloads unchanged instead of manufacturing a plan', () => {
    const failure = { error: { code: 'authentication_required', message: 'Sign in' } };
    expect(buildPlanSessionInspectionResult(failure)).toBe(failure);
  });
});

