import { describe, expect, it } from 'vitest';

import {
  batchCreateEntities,
  validateEntityCreatePayloadContract,
} from '../src/batchCreate';
import type { OrgxApiEnv } from '../src/orgxApi';

describe('batch create payload contract normalization', () => {
  it('normalizes active milestone status before calling the API', async () => {
    const bodies: Array<Record<string, unknown>> = [];

    const result = await batchCreateEntities({
      env: {} as OrgxApiEnv,
      callApi: async ({ init }) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            type: 'milestone',
            data: { id: 'milestone-1', title: 'Wizard Audit Runnable MVP' },
          }),
          { status: 200 }
        );
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

    expect(result.created_count).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(bodies[0]?.status).toBe('in_progress');
    expect(result.warnings).toEqual([
      expect.objectContaining({
        path: 'entities[0].status',
        from: 'active',
        to: 'in_progress',
      }),
    ]);
  });

  it('normalizes urgent task priority before validation', () => {
    const normalized = validateEntityCreatePayloadContract(
      {
        type: 'task',
        title: 'Implement wizard audit command shell',
        priority: 'high',
      },
      'entities[2]'
    );

    expect(normalized).toBeNull();
  });

  it('still explains unsupported task priority values before calling the API', () => {
    const error = validateEntityCreatePayloadContract(
      {
        type: 'task',
        title: 'Implement wizard audit command shell',
        priority: 'critical',
      },
      'entities[2]'
    );

    expect(error).toContain(
      'entities[2].priority="critical" is invalid for task'
    );
    expect(error).toContain('Valid task priorities: "low", "medium", "high"');
    expect(error).toContain('Use "high" for urgent task work.');
  });
});
