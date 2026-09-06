import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

import {
  enrichAgentStatusWithDurableEvidence,
  normalizeAgentStatusPayload,
} from '../src/agentStatusPayload';
import { getOpenAiOutputSchema } from '../src/openaiOutputSchemas';
import { projectAgentStatusTasks } from '../src/agentStatusTaskProjection';

const now = Date.parse('2026-09-06T10:00:00Z');

function statusPayload(tasks: Record<string, unknown>[]) {
  return normalizeAgentStatusPayload(enrichAgentStatusWithDurableEvidence({
    agents: [{
      agent_id: 'engineering-agent', agent_name: 'Eli',
      current_task: null, status: 'idle', progress: null, blockers: [],
      started_at: null, run_id: null, initiative_id: null,
      execution_target: 'unknown',
    }],
    summary: {}, stalled_agents: [], message: 'Current agent status.',
  }, tasks, [], now));
}

function task(id: string, status: string) {
  return {
    id, title: `Task ${id}`, status, priority: null,
    initiative_id: null, workstream_id: null, milestone_id: null,
    assigned_agent_id: 'engineering-agent',
    updated_at: '2026-09-06T09:59:30Z',
  };
}

describe('agent status output after durable enrichment', () => {
  it('returns one current row when app and entity evidence share an identity', () => {
    const current = { ...task('same', 'in_progress'), updated_at: '2026-09-06T10:00:00Z', blocker: 'Owner review' };
    const older = { ...task('same', 'in_progress'), task_id: 'same', updated_at: '2026-09-06T09:00:00Z' };
    for (const rows of [[older, current], [current, older]]) {
      const agent = projectAgentStatusTasks({ active_tasks: rows, completed_tasks: rows });
      expect(agent.active_tasks).toEqual([expect.objectContaining({ task_id: 'same', blocker: 'Owner review' })]);
      expect(agent.completed_tasks).toHaveLength(1);
    }
  });
  it('delivers active and completed entity rows through the MCP wire contract', async () => {
    const payload = statusPayload([
      task('active-task', 'in_progress'), task('finished-task', 'completed'),
    ]);
    const schema = getOpenAiOutputSchema('get_agent_status')!;
    expect(schema.safeParse(payload).success).toBe(true);
    const server = new McpServer({ name: 'agent-status-contract', version: '1.0.0' });
    server.registerTool('get_agent_status', { outputSchema: schema.shape }, async () => ({
      content: [{ type: 'text' as const, text: 'Current agent status.' }],
      structuredContent: payload,
    }));
    const client = new Client({ name: 'status-reader', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'get_agent_status', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        agents: [{
          current_tasks: [{ task_id: 'active-task', blocker: null }],
          active_tasks: [{ task_id: 'active-task', blocker: null }],
          completed_tasks: [{ task_id: 'finished-task', blocker: null }],
        }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('retains a real blocker and canonical task identity', () => {
    const payload = statusPayload([{
      ...task('legacy-id', 'in_progress'), task_id: 'canonical-id',
      blocker: 'Awaiting the owner’s review',
    }]);
    expect(payload).toMatchObject({ agents: [{ current_tasks: [{
      task_id: 'canonical-id', blocker: 'Awaiting the owner’s review',
    }] }] });
  });

  it('does not turn missing task identity or malformed field types into valid data', () => {
    const schema = getOpenAiOutputSchema('get_agent_status')!;
    const missingId = { ...task('unused', 'in_progress'), id: undefined };
    expect(schema.safeParse(statusPayload([missingId])).success).toBe(false);
    expect(schema.safeParse(statusPayload([{
      ...task('bad-blocker', 'in_progress'), blocker: 12,
    }])).success).toBe(false);
    expect(schema.safeParse(statusPayload([{
      ...task('bad-priority', 'in_progress'), priority: 12,
    }])).success).toBe(false);
  });
});
