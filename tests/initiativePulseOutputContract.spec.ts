import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { getOpenAiOutputSchema } from '../src/openaiOutputSchemas';
import { enrichInitiativePulseWithArtifacts } from '../src/widgetArtifactProof';

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
  const schema = getOpenAiOutputSchema('orgx_get_initiative_progress')!;
  it('delivers API blocker text and linked resources through the MCP client', async () => {
    const blockers = ['Mac client is offline.', { id: 'decision-1', title: 'Objective review pending', status: 'pending' }];
    const payload = pulse(blockers);
    expect(schema.parse(payload).blockers).toEqual(blockers);
    const server = new McpServer({ name: 'pulse-contract', version: '1.0.0' });
    server.registerTool('orgx_get_initiative_progress', { outputSchema: schema.shape }, async () => ({
      content: [{ type: 'text' as const, text: payload.message }], structuredContent: payload,
    }));
    const client = new Client({ name: 'pulse-reader', version: '1.0.0' });
    const [reader, writer] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(writer); await client.connect(reader);
      const result = await client.callTool({ name: 'orgx_get_initiative_progress', arguments: {} });
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
  it('carries typed descendant proof context and unmodified content through the MCP client', async () => {
    const initiativeId = pulse([]).initiative_id;
    const metadata = { preview_markdown: '\n# Receipt\n', content: { receipts: ['receipt-1'] },
      review_notes: ['Preserve the canonical proof'], eval_score: 0.94,
      evaluation_anatomy: { rubric: ['scope'] }, thresholds: { pass: 0.9 }, format: 'markdown' };
    const payload = enrichInitiativePulseWithArtifacts({ ...pulse([]),
      workstreams: [{ id: 'workstream-1', name: 'Engineering' }],
      milestones: [{ id: 'milestone-1', name: 'Phase 1', workstream_id: 'workstream-1' }],
      tasks: [{ id: 'task-1', title: 'Capture receipts', status: 'completed', workstream_id: 'workstream-1', milestone_id: 'milestone-1' },
        { id: 'task-2', title: null, status: 'planned', workstream_id: 'workstream-1', milestone_id: 'milestone-1' }],
      continuity: { progress: { completed: 4, total: 36, pct: 11, active: 2, blocked: 0 } },
      artifact_summary: { total: 39, in_review: 26, eval_passed: 13, unclassified: 7 },
    }, [{ id: 'proof-1', name: 'Verified receipt', entity_type: 'task', entity_id: 'task-1',
      status: 'in_review', artifact_type: 'eng.test_report', version: 3,
      description: '\nFull receipt proof\n', updated_at: '2026-10-10T16:20:00Z',
      verification: { eval: { score: 0.94, passed: true }, evidence: ['receipt-1'] }, metadata }]);
    const parsed = schema.parse(payload);
    expect(parsed.artifact_summary).toEqual({ total: 39, in_review: 26, eval_passed: 13, unclassified: 7 });
    expect(parsed.artifact_summary).not.toHaveProperty('delivered');
    expect(parsed.tasks?.[1].title).toBeNull();
    expect(parsed.continuity?.progress).toEqual({ completed: 4, total: 36, pct: 11, active: 2, blocked: 0 });
    expect(parsed.recent_artifacts[0]).toMatchObject({ entity_type: 'task', task_id: 'task-1',
      version: 3, metadata, description: '\nFull receipt proof\n', content: metadata.content,
      context: { initiative: { id: initiativeId, title: pulse([]).name },
        workstream: { id: 'workstream-1', title: 'Engineering' },
        milestone: { id: 'milestone-1', title: 'Phase 1' },
        task: { id: 'task-1', title: 'Capture receipts' } } });
    const server = new McpServer({ name: 'pulse-proof-contract', version: '1.0.0' });
    server.registerTool('orgx_get_initiative_progress', { outputSchema: schema.shape }, async () => ({
      content: [{ type: 'text' as const, text: String(payload.message) }], structuredContent: payload,
    }));
    const client = new Client({ name: 'pulse-proof-reader', version: '1.0.0' });
    const [reader, writer] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(writer); await client.connect(reader);
      const result = await client.callTool({ name: 'orgx_get_initiative_progress', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ tasks: payload.tasks,
        recent_artifacts: payload.recent_artifacts, artifact_summary: payload.artifact_summary,
        visible_artifact_summary: { total: 1, unit: 'visible_proof_card' } });
    } finally { await client.close(); await server.close(); }
    expect(schema.safeParse({ ...payload, tasks: [{ id: 'task-1', title: 'Receipt', status: 'completed',
      workstream_id: null, milestone_id: null, owner_id: 'unadvertised' }] }).success).toBe(false);
    expect(schema.safeParse({ ...payload, artifact_summary: { total: 39, unclassified: '7' } }).success).toBe(false);
  });
});
