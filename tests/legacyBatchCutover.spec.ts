import { describe, expect, it, vi } from 'vitest';
import { LegacyBatchCapabilityCache, runCompatibleLegacyBatch } from '../src/legacyBatchCutover';
import { LEGACY_SCAFFOLD_BATCH_CAPABILITY } from '../src/generated/legacyScaffoldBatchProfile';
import { batchCreateEntities, type BatchCreateApiCaller } from '../src/batchCreate';
import fixtures from './fixtures/legacy-entity-batch-v1.json';

const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const discovery = (capability: unknown = LEGACY_SCAFFOLD_BATCH_CAPABILITY) => ({ data: { workspace: { id: workspace }, workflow_contracts: { legacy_scaffold_batch: capability } } });
function cache() { const value = new LegacyBatchCapabilityCache(); value.observe(discovery(), 'actor'); return value; }
const input = () => ({ env: { ORGX_API_URL: 'https://example.invalid', ORGX_SERVICE_KEY: 'offline' }, actorUserId: 'actor', workspaceId: workspace, capabilityCache: cache(), entities: [{ type: 'initiative', title: 'Offline' }], ownerId: 'actor', continueOnError: true, concurrency: 1 });

describe('pre-write legacy batch compatibility selection', () => {
  it('binds discovery to its authenticated actor and workspace, rejects unknown/skewed versions', () => {
    const value = cache(); expect(value.supports('actor', workspace)).toBe(true);
    expect(value.supports('other', workspace)).toBe(false); expect(value.supports('actor', 'other')).toBe(false);
    for (const capability of [null, {}, { ...LEGACY_SCAFFOLD_BATCH_CAPABILITY, version: 'future' }, { ...LEGACY_SCAFFOLD_BATCH_CAPABILITY, profile: 'other' }]) {
      value.observe(discovery(capability), 'actor'); expect(value.supports('actor', workspace)).toBe(false);
    }
  });
  it('expires cached discovery without adding a capability probe', () => {
    vi.useFakeTimers();
    try { const value = cache(); vi.advanceTimersByTime(300001); expect(value.supports('actor', workspace)).toBe(false); }
    finally { vi.useRealTimers(); }
  });
  it('uses one authenticated batch request and validates the canonical response', async () => {
    const summary = await batchCreateEntities({ ...input(), callApi: async () => Response.json({ type: 'initiative', data: { id: workspace, title: 'Offline' } }) });
    const callApi = vi.fn<BatchCreateApiCaller>(async () => Response.json({ data: summary, meta: { batchVersion: 'legacy_entity_batch_v1', workspaceId: workspace } }));
    const result = await runCompatibleLegacyBatch({ ...input(), callApi });
    expect(result).toEqual(summary); expect(callApi).toHaveBeenCalledOnce();
    expect(callApi.mock.calls[0][0]).toMatchObject({ path: '/api/v1/workflows/legacy-scaffold-batch' });
    const body = JSON.parse(String(callApi.mock.calls[0][0].init.body)); expect(body).toMatchObject({ version: 'legacy_entity_batch_v1', workspace_id: workspace, owner_id: 'actor' });
  });
  it('sends the full four-node dependency graph in one request', async () => {
    const entities = [{ type: 'initiative', title: 'I', ref: 'i' }, { type: 'workstream', title: 'W', ref: 'w', initiative_ref: 'i' }, { type: 'milestone', title: 'M', ref: 'm', initiative_ref: 'i', workstream_ref: 'w' }, { type: 'task', title: 'T', initiative_ref: 'i', workstream_ref: 'w', milestone_ref: 'm' }];
    let id = 0;
    const summary = await batchCreateEntities({ ...input(), entities: structuredClone(entities), callApi: async ({ init }) => { const body = JSON.parse(String(init.body)); return Response.json({ type: body.type, data: { ...body, id: `${workspace.slice(0, -1)}${++id}` } }); } });
    const callApi = vi.fn<BatchCreateApiCaller>(async () => Response.json({ data: summary, meta: { batchVersion: 'legacy_entity_batch_v1', workspaceId: workspace } }));
    expect(await runCompatibleLegacyBatch({ ...input(), entities, callApi })).toEqual(summary);
    expect(callApi).toHaveBeenCalledOnce(); expect(JSON.parse(String(callApi.mock.calls[0][0].init.body)).entities).toEqual(entities);
  });
  it('preselects compatibility for a payload beyond the advertised byte limit', async () => {
    const callApi = vi.fn<BatchCreateApiCaller>(async () => Response.json({ type: 'initiative', data: { id: workspace } }));
    await runCompatibleLegacyBatch({ ...input(), entities: [{ type: 'initiative', title: 'Big', metadata: { sanitized: 'x'.repeat(4194304) } }], callApi });
    expect(callApi).toHaveBeenCalledOnce(); expect(callApi.mock.calls[0][0].path).toBe('/api/entities');
  });
  it.each([404, 422, 503])('never falls back or resends after HTTP %s from the batch attempt', async status => {
    const callApi = vi.fn<BatchCreateApiCaller>(async () => new Response('{}', { status }));
    await expect(runCompatibleLegacyBatch({ ...input(), callApi })).rejects.toThrow(/reconcil/i); expect(callApi).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { data: {} }, { data: {}, meta: { batchVersion: 'future', workspaceId: workspace } }])('never falls back after a malformed response %j', async body => {
    const callApi = vi.fn<BatchCreateApiCaller>(async () => Response.json(body));
    await expect(runCompatibleLegacyBatch({ ...input(), callApi })).rejects.toThrow(/reconcil/i); expect(callApi).toHaveBeenCalledOnce();
  });
  it('never resends after an uncertain transport failure', async () => {
    const callApi = vi.fn<BatchCreateApiCaller>(async () => { throw new Error('offline uncertain'); });
    await expect(runCompatibleLegacyBatch({ ...input(), callApi })).rejects.toThrow(/reconcil/i); expect(callApi).toHaveBeenCalledOnce();
  });
  it.each([
    { capabilityCache: new LegacyBatchCapabilityCache() }, { actorUserId: 'other' }, { ownerId: 'other' },
    { entities: [{ type: 'task', title: 'Implicit' }] }, { entities: [{ type: 'objective', title: 'Objective' }] },
    { entities: [{ type: 'initiative', title: 'Context', context: [{ entity_type: 'artifact', entity_id: workspace }] }] },
    { entities: [{ type: 'initiative', title: 'Alias', objective_ids: [workspace] }] },
    { entities: [{ type: 'initiative', title: 'Workspace ref', workspace_ref: 'w' }] },
  ])('preserves excluded legacy behavior before writing %j', async extra => {
    const callApi = vi.fn<BatchCreateApiCaller>(async () => Response.json({ type: 'initiative', data: { id: workspace, title: 'Offline' } }));
    const result = await runCompatibleLegacyBatch({ ...input(), ...extra, callApi });
    if (extra.entities?.[0]?.workspace_ref === 'w') { expect(result.failed_count).toBe(1); expect(callApi).not.toHaveBeenCalled(); }
    else { expect(result.created_count).toBe(1); expect(callApi.mock.calls[0][0].path).toBe('/api/entities'); }
  });
  it('preserves the existing per-entity finder for bulk retries without claiming whole-batch replay', async () => {
    const callApi = vi.fn(); const findExistingEntity = vi.fn<BatchCreateApiCaller>(async () => ({ id: workspace, title: 'Prior' }));
    const result = await runCompatibleLegacyBatch({ ...input(), callApi, findExistingEntity });
    expect(result.created_count).toBe(1); expect(findExistingEntity).toHaveBeenCalledOnce(); expect(callApi).not.toHaveBeenCalled();
  });
  it.each(fixtures)('retains frozen fallback transcript: $name', async fixture => {
    const scenario = fixture as typeof fixture & { failTitle?: string; existingRef?: string };
    const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const calls: Array<Record<string, unknown>> = [];
    const result = await runCompatibleLegacyBatch({ ...input(), capabilityCache: new LegacyBatchCapabilityCache(),
      ownerId: 'payload-owner-fixture', entities: structuredClone(fixture.entities), continueOnError: fixture.continueOnError,
      findExistingEntity: scenario.existingRef ? async ({ ref }) => ref === scenario.existingRef ? { id: 'replayed-root', title: 'Root' } : null : undefined,
      callApi: async ({ path, init, userId }) => { const body = JSON.parse(String(init.body)); calls.push({ path, method: 'POST', userId, body: plain(body) }); return body.title === scenario.failTitle ? Response.json({ error: 'sanitized fixture failure' }, { status: 422 }) : Response.json({ type: body.type, data: { id: `${body.type}-${calls.length}`, title: body.title, metadata: body.metadata } }); },
    });
    expect(plain(result)).toEqual(fixture.expected); expect(plain(calls)).toEqual(fixture.calls);
  });
});
