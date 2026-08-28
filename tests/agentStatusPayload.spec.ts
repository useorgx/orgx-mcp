import { describe, expect, it } from 'vitest';

import { normalizeAgentStatusPayload } from '../src/agentStatusPayload';

describe('normalizeAgentStatusPayload', () => {
  it('filters non-agent app entries and recomputes the fleet summary', () => {
    const result = normalizeAgentStatusPayload({
      agents: [
        {
          agent_id: 'product-agent',
          agent_name: 'Pace',
          status: 'idle',
        },
        {
          agent_id: 'chatgpt-app',
          agent_name: 'OrgX ChatGPT App',
          status: 'idle',
        },
        {
          agent_id: 'engineering-agent',
          agent_name: 'Eli',
          status: 'running',
        },
      ],
      summary: {
        total: 3,
        running: 1,
        queued: 0,
        blocked: 0,
        idle: 2,
      },
    });

    expect(result).toMatchObject({
      agents: [
        { agent_id: 'product-agent', agent_name: 'Pace', status: 'idle' },
        {
          agent_id: 'engineering-agent',
          agent_name: 'Eli',
          status: 'running',
        },
      ],
      summary: {
        total: 2,
        running: 1,
        queued: 0,
        blocked: 0,
        idle: 1,
      },
    });
  });

  it('merges alias agent records into a single display agent', () => {
    const result = normalizeAgentStatusPayload({
      agents: [
        {
          agent_id: 'product-agent',
          agent_name: 'Pace',
          role: 'Product',
          status: 'idle',
          current_tasks: [{ id: 'task-1', title: 'Primary roadmap pass' }],
        },
        {
          agent_id: 'product-onboarding',
          agent_name: 'Pace',
          role: 'Product',
          status: 'running',
          blockers: ['Waiting on approval'],
        },
      ],
    });

    expect(result).toMatchObject({
      agents: [
        {
          agent_name: 'Pace',
          role: 'Product',
          status: 'running',
          current_tasks: [{ id: 'task-1', title: 'Primary roadmap pass' }],
          blockers: ['Waiting on approval'],
        },
      ],
      summary: {
        total: 1,
        running: 1,
        queued: 0,
        blocked: 0,
        idle: 0,
      },
    });
  });

  it('preserves a completed task lane and marks an old heartbeat as stalled', () => {
    const result = normalizeAgentStatusPayload({
      agents: [
        {
          agent_id: 'engineering-agent',
          agent_name: 'Eli',
          status: 'in_progress',
          last_heartbeat_at: '2020-01-01T00:00:00.000Z',
          tasks: [
            { id: 'task-active', title: 'Current repair', status: 'in_progress' },
            { id: 'task-done', title: 'Shipped repair', status: 'completed' },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      agents: [
        {
          status: 'stalled',
          completed_count: 1,
          completed_tasks: [{ id: 'task-done', title: 'Shipped repair', status: 'completed' }],
        },
      ],
      summary: { stalled: 1, completed: 1 },
    });
  });
});
