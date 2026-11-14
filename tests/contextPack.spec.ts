import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContextPackRequestBody,
  buildContextCapsuleRequestBody,
  CONTEXT_CAPSULE_FETCH_TIMEOUT_MS,
  CONTEXT_PACK_API_PATH,
  fetchContextCapsule,
  fetchContextPack,
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
    expect(
      buildContextPackRequestBody({ type: 'initiative', id: 'i1' }, { briefSources: true })
    ).toEqual({ entity_type: 'initiative', entity_id: 'i1', brief_sources: true, relations: 1 });
    expect(
      buildContextPackRequestBody({ type: 'task', id: 't1' }, { briefSources: true, relations: 0 })
    ).toMatchObject({ brief_sources: true, relations: 0 });
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
        body: JSON.stringify({ workspace_id: 'workspace-1', response_profile: 'prepared' }),
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

  it.each(['pack', 'capsule'] as const)('bounds a stalled %s response body as well as its headers', async (kind) => {
    vi.useFakeTimers();
    apiMocks.callOrgxApiJson.mockResolvedValue({ json: () => new Promise(() => {}) });
    const pending = kind === 'pack'
      ? fetchContextPack({} as never, 'user-1', { type: 'task', id: 'task-1' })
      : fetchContextCapsule({} as never, 'user-1', 'workspace-1');
    await vi.advanceTimersByTimeAsync(CONTEXT_CAPSULE_FETCH_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(apiMocks.callOrgxApiJson.mock.calls[0][2].signal.aborted).toBe(true);
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(1);
  });

  it('keeps prepared fallback inside the original deadline', async () => {
    vi.useFakeTimers();
    apiMocks.callOrgxApiJson.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('prepared byte budget')), 3_000);
    }));
    apiMocks.callOrgxApiJson.mockImplementationOnce(() => new Promise(() => {}));
    const pending = fetchContextPreparation({} as never, 'user-1', 'workspace-1');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeNull();
    const [first, second] = apiMocks.callOrgxApiJson.mock.calls;
    expect(second[2].signal).toBe(first[2].signal);
    expect(second[2].signal.aborted).toBe(true);
  });

  it('forwards the authenticated identity and run restrictions on both context reads', async () => {
    apiMocks.callOrgxApiJson.mockImplementation(async () => Response.json({ data: {} }));
    const identity = { userEmail: 'caller@example.test', orgxUserId: 'internal-user', runId: 'run-1', workspaceId: 'workspace-1', scopes: ['orgx_inspect'] };
    await fetchContextPack({} as never, 'user-1', { type: 'task', id: 'task-1' }, {}, identity);
    await fetchContextPreparation({} as never, 'user-1', 'workspace-1', undefined, identity);
    for (const call of apiMocks.callOrgxApiJson.mock.calls) {
      expect(call[3]).toEqual({ ...identity, userId: 'user-1' });
    }
  });
});


describe('context delivery propagation', () => {
  it('falls back from an oversized prepared capsule using the same scope and deadline', async () => {
    apiMocks.callOrgxApiJson.mockRejectedValueOnce(new Error('prepared byte budget'));
    apiMocks.callOrgxApiJson.mockResolvedValueOnce(Response.json({data:{context_capsule:{schema_version:'orgx.context-capsule/v1',capsule_id:'full-fallback'}}}));
    const result=await fetchContextPreparation({} as never,'scoped-user','scoped-workspace');
    expect(result?.context_capsule?.capsule_id).toBe('full-fallback');
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(2);
    const first=apiMocks.callOrgxApiJson.mock.calls[0],second=apiMocks.callOrgxApiJson.mock.calls[1];
    expect(JSON.parse(first[2].body)).toEqual({workspace_id:'scoped-workspace',response_profile:'prepared'});
    expect(JSON.parse(second[2].body)).toEqual({workspace_id:'scoped-workspace',delivery_mode:'delta'});
    expect(first[2].signal).toBe(second[2].signal);expect(second[3]).toEqual({userId:'scoped-user'});
  });
  it('preserves initiative scope and server delivery metadata for bootstrap', async () => {
    const delivery = { schema_version: 'orgx.context-delivery/v1', base_verified: false };
    apiMocks.callOrgxApiJson.mockResolvedValue(Response.json({ data: {
      context_capsule: { schema_version: 'orgx.context-capsule/v1', capsule_id: 'capsule_x' },
      context_delivery: delivery, frame: { anchor: { id: 'initiative-1' } }, workflow_contracts: { legacy_scaffold_batch: { version: 'legacy_entity_batch_v1' } },
    } }));
    const result = await fetchContextPreparation({} as never, 'user-1', 'workspace-1', 'initiative-1');
    expect(result?.context_delivery).toEqual(delivery);
    expect(result?.workflow_contracts).toEqual({ legacy_scaffold_batch: { version: 'legacy_entity_batch_v1' } });
    expect(result?.context_pack?.frame).toEqual({ anchor: { id: 'initiative-1' } });
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(1);
    expect(JSON.parse(apiMocks.callOrgxApiJson.mock.calls[0][2].body)).toEqual({
      workspace_id: 'workspace-1', initiative_id: 'initiative-1', delivery_mode: 'delta',
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

it('reconstructs acknowledged transfers and repairs a stale base without losing scope', async () => {
  const serialized = JSON.stringify({ context_delivery: { consistency: 'database_snapshot' }, context_capsule: { schema_version: 'orgx.context-capsule/v1', capsule_id: 'portable' } }, null, 2);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  const version = 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const transfer = { schema_version: 'orgx.context-transfer/v1', mode: 'full', serialized, version };
  apiMocks.callOrgxApiJson.mockImplementation(async () => Response.json({ data: { context_transfer: transfer } }));
  const first = await fetchContextPreparation({} as never, 'portable-user', 'portable-workspace', 'portable-initiative');
  expect(first?.context_capsule?.capsule_id).toBe('portable');
  apiMocks.callOrgxApiJson.mockImplementationOnce(async () => Response.json({ data: { context_transfer: { schema_version: transfer.schema_version, mode: 'delta', base_version: version, version, operations: [{ copy: [0, serialized.split('\n').length] }] } } }));
  expect(await fetchContextPreparation({} as never, 'portable-user', 'portable-workspace', 'portable-initiative')).toEqual(first);
  expect(JSON.parse(apiMocks.callOrgxApiJson.mock.calls[1][2].body).acknowledged_context_version).toBe(version);
  apiMocks.callOrgxApiJson.mockImplementationOnce(async () => Response.json({ data: { context_transfer: { ...transfer, serialized: 'tampered' } } }));
  expect(await fetchContextPreparation({} as never, 'portable-user', 'portable-workspace', 'portable-initiative')).toEqual(first);
  expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(4);
  expect(JSON.parse(apiMocks.callOrgxApiJson.mock.calls[3][2].body)).toEqual({ workspace_id: 'portable-workspace', initiative_id: 'portable-initiative', delivery_mode: 'delta' });
});
