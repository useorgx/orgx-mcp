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
});
