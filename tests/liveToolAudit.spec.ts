import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { normalizeAgentStatusPayload } from '../src/agentStatusPayload';
import { buildMorningBriefValueDashboard } from '../src/morningBriefValue';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';

describe('2026-09-21 live tool regressions', () => {
  it('accepts backend morning brief fields through SDK output validation', async () => {
    const payload = {
      workspace_id: 'workspace-fixture',
      session_summary: { session_id: null, roi: null },
      artifacts_produced: [{ id: 'artifact-1', title: 'Proof', status: 'in_review' }],
      review_items: [{ id: 'artifact-1', title: 'Proof', status: 'in_review' }],
      top_priorities: [{ domain: 'engineering', title: 'Review proof', reason: 'Needs review' }],
      metrics: {
        decisionsResolved: 0, pendingDecisions: 0, artifactsProduced: 1,
        prReceipts: 0, activeInitiatives: 1, blockedWork: 0, goalsTracked: 1,
        completedRuns: 0, failedRuns: 0, receiptsProduced: 0,
        valueCreatedUsd: 0, avgQualityScore: null,
      },
      continuity: {
        headline: 'Continuity', summary: 'No client evidence',
        metrics: {
          linkedClients: 0, observedClients: 0, verifiedClients: 0,
          silentLinkedClients: 0, crossClientSessions: 0, records: 0,
        },
        clients: [], events: [],
      },
      prVelocity: { receipts: [], source: 'orgx_pr_receipts', coverage: 'missing' },
      topPriorities: [], rollups: [], decisionChronology: [], artifactLedger: [],
      initiatives: [], message: 'No completed autonomous session found',
      value_dashboard: buildMorningBriefValueDashboard({ brief: {} }),
    };
    const server = new McpServer({ name: 'audit', version: '1' });
    installToolResultGuidanceWrapper(server, null);
    server.registerTool('get_morning_brief', { inputSchema: {} }, async () => ({
      content: [{ type: 'text' as const, text: payload.message }],
      structuredContent: payload,
    }));
    const client = new Client({ name: 'audit', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'get_morning_brief', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(payload);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reconciles narrative, stalled list, workload, and bounded evidence', () => {
    const result = normalizeAgentStatusPayload({
      message: '4 agents blocked and waiting on input.',
      stalled_agents: [],
      agents: [{
        agent_id: 'design-agent', agent_name: 'Dana', status: 'running',
        last_heartbeat_at: '2020-01-01T00:00:00Z',
        current_tasks: [{ id: 'task-1', status: 'in_progress' }, { task_id: 'task-1', status: 'in_progress' }],
        workload: { tasks_in_progress: 19, blocked_count: 0, stream_count: 0 },
        artifacts: Array.from({ length: 12 }, (_, n) => ({
          id: `artifact-${n}`, title: 'Proof', artifact_url: `https://example.com/proof/${n}`,
          metadata: { content: 'x'.repeat(100_000) },
        })),
      }],
    });
    expect(result.message).toBe('Agent status: 1 stalled.');
    expect(result.summary).toMatchObject({ stalled: 1, blocked: 0 });
    expect(result.stalled_agents).toHaveLength(1);
    const agent = (result.agents as Array<Record<string, unknown>>)[0];
    expect(agent.workload).toMatchObject({ tasks_in_progress: 1 });
    expect(agent.artifact_count).toBe(12);
    expect(agent.artifact_preview_count).toBe(6);
    expect(agent.artifacts).toHaveLength(6);
    expect((agent.artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'artifact-0', artifact_url: 'https://example.com/proof/0',
      primary_url: 'https://example.com/proof/0',
    });
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
  });
});
