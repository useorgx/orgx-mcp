import { describe, expect, it } from 'vitest';

import {
  batchCreateEntities,
  validateEntityCreatePayloadContract,
} from '../src/batchCreate';
import type { OrgxApiEnv } from '../src/orgxApi';

describe('batch create payload contract hints', () => {
  it('explains milestone status values before calling the API', async () => {
    let apiCalls = 0;

    const result = await batchCreateEntities({
      env: {} as OrgxApiEnv,
      callApi: async () => {
        apiCalls += 1;
        throw new Error('API should not be called for invalid local payloads');
      },
      entities: [
        {
          type: 'milestone',
          title: 'Wizard Audit Runnable MVP',
          status: 'active',
        },
      ],
      continueOnError: true,
      concurrency: 1,
    });

    expect(apiCalls).toBe(0);
    expect(result.created_count).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain(
      'entities[0].status="active" is invalid for milestone'
    );
    expect(result.failed[0]?.error).toContain(
      'Use "in_progress" instead of "active"'
    );
  });

  it('explains task priority values before calling the API', () => {
    const error = validateEntityCreatePayloadContract(
      {
        type: 'task',
        title: 'Implement wizard audit command shell',
        priority: 'urgent',
      },
      'entities[2]'
    );

    expect(error).toContain(
      'entities[2].priority="urgent" is invalid for task'
    );
    expect(error).toContain('Valid task priorities: "low", "medium", "high"');
    expect(error).toContain('Use "high" for urgent task work.');
  });
});
