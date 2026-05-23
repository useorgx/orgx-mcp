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

  it('treats idempotent 409 responses with existing entity data as successful replays', async () => {
    const result = await batchCreateEntities({
      env: {} as OrgxApiEnv,
      callApi: async () =>
        new Response(
          JSON.stringify({
            error: 'initiative already exists',
            existing: {
              id: 'initiative-existing',
              title: 'Launch replay',
            },
          }),
          { status: 409 }
        ),
      entities: [
        {
          type: 'initiative',
          ref: 'initiative',
          title: 'Launch replay',
          idempotency_key: 'scaffold:launch-replay',
        },
      ],
      continueOnError: true,
      concurrency: 1,
    });

    expect(result.failed_count).toBe(0);
    expect(result.created_count).toBe(1);
    expect(result.ref_map).toEqual({ initiative: 'initiative-existing' });
    expect(result.results[0]).toMatchObject({
      success: true,
      skipped: true,
      id: 'initiative-existing',
    });
  });

  it('orders and resolves depends_on refs before sending create payloads', async () => {
    const bodies: Array<Record<string, unknown>> = [];

    const result = await batchCreateEntities({
      env: {} as OrgxApiEnv,
      callApi: async ({ init }) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(
          JSON.stringify({
            type: body.type,
            data: {
              id:
                body.title === 'Design'
                  ? 'ws-upstream-id'
                  : 'ws-downstream-id',
              title: body.title ?? body.name,
            },
          }),
          { status: 200 }
        );
      },
      entities: [
        {
          type: 'workstream',
          ref: 'ws-upstream',
          title: 'Design',
        },
        {
          type: 'workstream',
          ref: 'ws-downstream',
          title: 'Engineering',
          depends_on: ['ws-upstream'],
        },
      ],
      continueOnError: true,
      concurrency: 2,
    });

    expect(result.failed_count).toBe(0);
    expect(bodies[0]).toMatchObject({ title: 'Design' });
    expect(bodies[1]).toMatchObject({
      title: 'Engineering',
      depends_on: ['ws-upstream-id'],
    });
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
