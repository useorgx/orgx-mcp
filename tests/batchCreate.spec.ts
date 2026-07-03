import { describe, expect, it, vi } from 'vitest';

import { batchCreateEntities } from '../src/batchCreate';

const env = {
  ORGX_API_URL: 'https://example.invalid',
  ORGX_SERVICE_KEY: 'service-key',
};

function mockJsonResponse(
  payload: unknown,
  params?: { ok?: boolean; status?: number }
) {
  const ok = params?.ok ?? true;
  const status = params?.status ?? (ok ? 200 : 500);
  const bodyText = JSON.stringify(payload);
  return {
    ok,
    status,
    text: async () => bodyText,
  } as any;
}

describe('batchCreateEntities', () => {
  it('returns created IDs + ref_map in input order', async () => {
    const callApi = vi.fn(async ({ init }: any) => {
      const body = JSON.parse(init.body);
      const id = `${body.type}-${body.title ?? body.name ?? 'x'}`;
      return mockJsonResponse({
        type: body.type,
        data: { id, title: body.title, name: body.name },
      });
    });

    const result = await batchCreateEntities({
      env,
      callApi,
      ownerId: 'user-1',
      continueOnError: true,
      concurrency: 5,
      entities: [
        {
          type: 'workstream',
          ref: 'ws-a',
          title: 'A',
          initiative_id: 'init-1',
        },
        {
          type: 'workstream',
          ref: 'ws-b',
          title: 'B',
          initiative_id: 'init-1',
        },
      ],
    });

    expect(result.created_count).toBe(2);
    expect(result.failed_count).toBe(0);
    expect(result.ref_map['ws-a']).toBe('workstream-A');
    expect(result.ref_map['ws-b']).toBe('workstream-B');
    expect(result.created.map((c) => c.ref)).toEqual(['ws-a', 'ws-b']);
  });

  it('persists ref metadata for resolvable hierarchy entities', async () => {
    const calls: any[] = [];
    const callApi = vi.fn(async ({ init }: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return mockJsonResponse({
        type: body.type,
        data: { id: `${body.type}-${calls.length}`, title: body.title },
      });
    });

    await batchCreateEntities({
      env,
      callApi,
      ownerId: 'user-1',
      continueOnError: true,
      concurrency: 2,
      entities: [
        {
          type: 'workstream',
          ref: 'ws-ref',
          title: 'WS',
          metadata: { lane: 'engineering' },
          initiative_id: 'init-1',
        },
        {
          type: 'milestone',
          ref: 'ms-ref',
          title: 'MS',
          initiative_id: 'init-1',
          workstream_ref: 'ws-ref',
        },
      ],
    });

    const workstreamCall = calls.find((entry) => entry.type === 'workstream');
    expect(workstreamCall.metadata).toEqual(
      expect.objectContaining({
        ref: 'ws-ref',
        lane: 'engineering',
      })
    );

    const milestoneCall = calls.find((entry) => entry.type === 'milestone');
    expect(milestoneCall.metadata).toEqual(
      expect.objectContaining({
        ref: 'ms-ref',
      })
    );
  });

  it('resolves *_ref and context entity_ref before creation', async () => {
    const calls: any[] = [];
    const callApi = vi.fn(async ({ init }: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const id = `${body.type}-${calls.length}`;
      return mockJsonResponse({
        type: body.type,
        data: { id, title: body.title, name: body.name },
      });
    });

    const result = await batchCreateEntities({
      env,
      callApi,
      ownerId: 'user-1',
      continueOnError: true,
      concurrency: 2,
      entities: [
        {
          type: 'workstream',
          ref: 'ws',
          title: 'WS',
          initiative_id: 'init-1',
        },
        {
          type: 'milestone',
          ref: 'ms',
          title: 'MS',
          initiative_id: 'init-1',
          workstream_ref: 'ws',
        },
        {
          type: 'task',
          title: 'T1',
          initiative_id: 'init-1',
          workstream_ref: 'ws',
          milestone_ref: 'ms',
          context: [
            {
              type: 'entity',
              entity_type: 'milestone',
              entity_ref: 'ms',
              relevance: 'Use milestone output',
            },
          ],
        },
      ],
    });

    expect(result.failed_count).toBe(0);
    expect(result.ref_map.ws).toBe('workstream-1');
    expect(result.ref_map.ms).toBe('milestone-2');

    const milestoneCall = calls.find((c) => c.type === 'milestone');
    expect(milestoneCall.workstream_id).toBe('workstream-1');
    expect(milestoneCall.workstream_ref).toBeUndefined();

    const taskCall = calls.find((c) => c.type === 'task');
    expect(taskCall.workstream_id).toBe('workstream-1');
    expect(taskCall.milestone_id).toBe('milestone-2');
    expect(taskCall.workstream_ref).toBeUndefined();
    expect(taskCall.milestone_ref).toBeUndefined();
    expect(Array.isArray(taskCall.context)).toBe(true);
    expect(taskCall.context[0].entity_id).toBe('milestone-2');
    expect(taskCall.context[0].entity_ref).toBeUndefined();
  });

  it('collapses duplicate hierarchy siblings before parallel creation', async () => {
    const calls: any[] = [];
    const callApi = vi.fn(async ({ init }: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const id = `${body.type}-${calls.length}`;
      return mockJsonResponse({
        type: body.type,
        data: { id, title: body.title, name: body.name },
      });
    });

    const result = await batchCreateEntities({
      env,
      callApi,
      ownerId: 'user-1',
      continueOnError: true,
      concurrency: 5,
      entities: [
        {
          type: 'workstream',
          ref: 'ws',
          title: 'Product proof',
          initiative_id: 'init-1',
        },
        {
          type: 'milestone',
          ref: 'ms-a',
          title: 'Hierarchy Inspection',
          initiative_id: 'init-1',
          workstream_ref: 'ws',
        },
        {
          type: 'milestone',
          ref: 'ms-b',
          title: '  hierarchy   inspection ',
          initiative_id: 'init-1',
          workstream_ref: 'ws',
        },
        {
          type: 'task',
          ref: 'task-b',
          title: 'Inspect execution state',
          initiative_id: 'init-1',
          workstream_ref: 'ws',
          milestone_ref: 'ms-b',
        },
      ],
    });

    expect(result.failed_count).toBe(0);
    expect(result.created_count).toBe(3);
    expect(callApi).toHaveBeenCalledTimes(3);
    expect(calls.filter((call) => call.type === 'milestone')).toHaveLength(1);
    expect(result.ref_map['ms-b']).toBe(result.ref_map['ms-a']);
    expect(result.results[2]?.skipped).toBe(true);

    const taskCall = calls.find((call) => call.type === 'task');
    expect(taskCall.milestone_id).toBe(result.ref_map['ms-a']);
    expect(taskCall.milestone_ref).toBeUndefined();
  });

  it('resolves {$ref} objects passed in id fields and context entity_id', async () => {
    const calls: any[] = [];
    const callApi = vi.fn(async ({ init }: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const id = `${body.type}-${calls.length}`;
      return mockJsonResponse({
        type: body.type,
        data: { id, title: body.title, name: body.name },
      });
    });

    const result = await batchCreateEntities({
      env,
      callApi,
      ownerId: 'user-1',
      continueOnError: true,
      concurrency: 2,
      entities: [
        {
          type: 'workstream',
          ref: 'ws',
          title: 'WS',
          initiative_id: 'init-1',
        },
        {
          type: 'milestone',
          ref: 'ms',
          title: 'MS',
          initiative_id: 'init-1',
          workstream_id: { $ref: 'ws' },
        },
        {
          type: 'task',
          title: 'T1',
          initiative_id: 'init-1',
          workstream_id: { $ref: 'ws' },
          milestone_id: { $ref: 'ms' },
          context: [
            {
              type: 'entity',
              entity_type: 'milestone',
              entity_id: { $ref: 'ms' },
              relevance: 'Use milestone output',
            },
          ],
        },
      ],
    });

    expect(result.failed_count).toBe(0);
    expect(result.ref_map.ws).toBe('workstream-1');
    expect(result.ref_map.ms).toBe('milestone-2');

    const milestoneCall = calls.find((c) => c.type === 'milestone');
    expect(milestoneCall.workstream_id).toBe('workstream-1');

    const taskCall = calls.find((c) => c.type === 'task');
    expect(taskCall.workstream_id).toBe('workstream-1');
    expect(taskCall.milestone_id).toBe('milestone-2');
    expect(taskCall.context[0].entity_id).toBe('milestone-2');
  });

  it('fails fast when a referenced ref is missing', async () => {
    const callApi = vi.fn(async () => {
      throw new Error('should not be called');
    });

    const result = await batchCreateEntities({
      env,
      callApi,
      ownerId: 'user-1',
      continueOnError: true,
      concurrency: 2,
      entities: [
        {
          type: 'milestone',
          title: 'MS',
          initiative_id: 'init-1',
          workstream_ref: 'missing',
        },
      ],
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(result.created_count).toBe(0);
    expect(result.failed_count).toBe(1);
    expect(result.results[0]?.error).toMatch(/Unknown ref/);
  });

  it('fails duplicate refs deterministically', async () => {
    const callApi = vi.fn(async () =>
      mockJsonResponse({ type: 'workstream', data: { id: 'x' } })
    );

    const result = await batchCreateEntities({
      env,
      callApi,
      ownerId: 'user-1',
      continueOnError: true,
      concurrency: 2,
      entities: [
        { type: 'workstream', ref: 'dup', title: 'A', initiative_id: 'init-1' },
        { type: 'workstream', ref: 'dup', title: 'B', initiative_id: 'init-1' },
      ],
    });

    expect(callApi).not.toHaveBeenCalled();
    expect(result.created_count).toBe(0);
    expect(result.failed_count).toBe(2);
    expect(result.results[0]?.error).toMatch(/Duplicate ref/);
    expect(result.results[1]?.error).toMatch(/Duplicate ref/);
  });
});
