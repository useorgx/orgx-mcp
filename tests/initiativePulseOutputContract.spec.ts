import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { getOpenAiOutputSchema } from '../src/openaiOutputSchemas';

function pulse(blockers: unknown[]) {
  return {
    initiative_id: '11111111-1111-4111-8111-111111111111',
    name: 'Accepted outcome recovery', status: 'blocked', health_score: 42,
    progress_pct: 20, created_at: '2026-09-06T00:00:00Z',
    milestones: [], workstreams: [], blockers, pending_decisions: 1,
    workstream_summary: { total: 0, active: 0, paused: 0, completed: 0, blocked: 0 },
    completion_state: { all_tasks_complete: false, all_milestones_complete: false,
      all_workstreams_complete: false, has_pending_decisions: true,
      initiative_complete: false, stale_state_count: 0, stale_state: [] },
    lifecycle_stage: 'execution', initiative_short_id: 'INI-TEST',
    recent_artifacts: [], artifact_summary: null, resolved_from_name: false,
    message: 'Recovery is blocked.', next_steps: ['Review the current objective.'],
  };
}

describe('initiative pulse blocker wire contract', () => {
  const schema = getOpenAiOutputSchema('get_initiative_pulse')!;
  it('delivers API blocker text and linked resources through the MCP client', async () => {
    const blockers = ['Mac client is offline.', { id: 'decision-1', title: 'Objective review pending', status: 'pending' }];
    const payload = pulse(blockers);
    expect(schema.parse(payload).blockers).toEqual(blockers);
    const server = new McpServer({ name: 'pulse-contract', version: '1.0.0' });
    server.registerTool('get_initiative_pulse', { outputSchema: schema.shape }, async () => ({
      content: [{ type: 'text' as const, text: payload.message }], structuredContent: payload,
    }));
    const client = new Client({ name: 'pulse-reader', version: '1.0.0' });
    const [reader, writer] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(writer); await client.connect(reader);
      const result = await client.callTool({ name: 'get_initiative_pulse', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'blocked', blockers, pending_decisions: 1 });
    } finally { await client.close(); await server.close(); }
  });
  it.each([null, false, 7, [], { id: 7 }, ''])('continues rejecting malformed blocker values: %j', (value) => {
    expect(schema.safeParse(pulse([value])).success).toBe(false);
  });
  it('keeps the top-level output envelope strict', () => {
    expect(schema.safeParse({ ...pulse([]), invented_acceptance: true }).success).toBe(false);
  });
});
