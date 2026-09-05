import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContextPackRequestBody,
  buildContextCapsuleRequestBody,
  CONTEXT_CAPSULE_FETCH_TIMEOUT_MS,
  CONTEXT_PACK_API_PATH,
  fetchContextCapsule,
  fetchContextPreparation,
  isPackableAnchor,
} from '../src/contextPack';

const apiMocks = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn(),
}));

vi.mock('../src/orgxApi', () => ({
  callOrgxApiJson: apiMocks.callOrgxApiJson,
}));

beforeEach(() => {
  vi.useRealTimers();
  apiMocks.callOrgxApiJson.mockReset();
});

describe('context pack helpers', () => {
  it('builds the app endpoint request body', () => {
    expect(CONTEXT_PACK_API_PATH).toBe('/api/v1/context-pack');
    expect(buildContextPackRequestBody({ type: 'initiative', id: 'i1' })).toEqual({
      entity_type: 'initiative',
      entity_id: 'i1',
    });
  });

  it('builds the workspace context capsule request body', () => {
    expect(buildContextCapsuleRequestBody('workspace-1')).toEqual({
      workspace_id: 'workspace-1',
    });
  });

  it('treats only initiative/workstream/task (with an id) as packable', () => {
    expect(isPackableAnchor({ type: 'initiative', id: 'i1' })).toBe(true);
    expect(isPackableAnchor({ type: 'workstream', id: 'w1' })).toBe(true);
    expect(isPackableAnchor({ type: 'task', id: 't1' })).toBe(true);
    expect(isPackableAnchor({ type: 'plan_session', id: 'x' })).toBe(false);
    expect(isPackableAnchor({ type: 'initiative', id: '' })).toBe(false);
  });

  it('accepts only the exact context capsule schema from the workspace endpoint', async () => {
    apiMocks.callOrgxApiJson.mockResolvedValue(
      Response.json({
        data: {
          context_capsule: {
            schema_version: 'orgx.context-capsule/v1',
            capsule_id: 'capsule_1',
          },
        },
      })
    );

    await expect(
      fetchContextCapsule({} as never, 'user-1', 'workspace-1')
    ).resolves.toMatchObject({ capsule_id: 'capsule_1' });
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledWith(
      expect.anything(),
      CONTEXT_PACK_API_PATH,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspace_id: 'workspace-1' }),
        signal: expect.any(AbortSignal),
      }),
      { userId: 'user-1' }
    );

    apiMocks.callOrgxApiJson.mockResolvedValueOnce(
      Response.json({
        data: { context_capsule: { schema_version: 'unknown' } },
      })
    );
    await expect(
      fetchContextCapsule({} as never, 'user-1', 'workspace-1')
    ).resolves.toBeNull();
  });

  it('degrades to null at the capsule-specific deadline', async () => {
    vi.useFakeTimers();
    apiMocks.callOrgxApiJson.mockImplementation(
      async (_env: unknown, _path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          );
        })
    );

    const pending = fetchContextCapsule({} as never, 'user-1', 'workspace-1');
    await vi.advanceTimersByTimeAsync(CONTEXT_CAPSULE_FETCH_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });
});


describe('context delivery propagation', () => {
  it('preserves initiative scope and server delivery metadata for bootstrap', async () => {
    const delivery = { schema_version: 'orgx.context-delivery/v1', base_verified: false };
    apiMocks.callOrgxApiJson.mockResolvedValue(Response.json({ data: {
      context_capsule: { schema_version: 'orgx.context-capsule/v1', capsule_id: 'capsule_x' },
      context_delivery: delivery, frame: { anchor: { id: 'initiative-1' } },
    } }));
    const result = await fetchContextPreparation({} as never, 'user-1', 'workspace-1', 'initiative-1');
    expect(result?.context_delivery).toEqual(delivery);
    expect(result?.context_pack?.frame).toEqual({ anchor: { id: 'initiative-1' } });
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(apiMocks.callOrgxApiJson.mock.calls[0][2].body)).toEqual({
      workspace_id: 'workspace-1', initiative_id: 'initiative-1',
    });
  });
  it('leaves missing delivery guarantees unknown on older app deployments', async () => {
    apiMocks.callOrgxApiJson.mockResolvedValue(Response.json({ data: {
      context_capsule: { schema_version: 'orgx.context-capsule/v1', capsule_id: 'capsule_x' },
    } }));
    expect((await fetchContextPreparation({} as never, 'user-1', 'workspace-1'))?.context_delivery).toBeNull();
  });
});


it('preserves a legacy initiative pack when its app does not supply a capsule', async () => {
  apiMocks.callOrgxApiJson.mockResolvedValue(Response.json({ data: { frame: { anchor: { id: 'i' } } } }));
  const result = await fetchContextPreparation({} as never, 'user', 'workspace', 'i');
  expect(result?.context_capsule).toBeNull();
  expect(result?.context_pack?.frame).toEqual({ anchor: { id: 'i' } });
});
