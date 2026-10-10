import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({ McpAgent: class { static serve() { return { fetch: vi.fn() }; } static serveSSE() { return { fetch: vi.fn() }; } } }));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({ captureException: vi.fn(), wrapMcpServerWithSentry: <T>(server: T) => server, withSentry: <T>(_options: unknown, worker: T) => worker }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({ default: class {} }));

const INIT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORKSTREAM = '33333333-3333-4333-8333-333333333333';
const MILESTONE = '44444444-4444-4444-8444-444444444444';
const source = () => ({
  initiative_id: INIT, name: 'Living Work Memory',
  workstreams: [{ id: WORKSTREAM, name: 'Engineering' }],
  milestones: [{ id: MILESTONE, name: 'Phase 1', workstream_id: WORKSTREAM }],
  tasks: [{ id: TASK, title: 'Verify current source', workstream_id: WORKSTREAM, milestone_id: MILESTONE, status: 'done' }],
  continuity: { progress: { completed: 4, total: 36, pct: 11 } },
  artifact_summary: { total: 39, in_review: 26, eval_passed: 13 },
  recent_artifacts: [{ id: 'current', name: 'Current task proof', description: 'Full current proof body', version: 8, status: 'in_review', entity_type: 'task', entity_id: TASK, verification: { review: { notes: 'Keep this evidence' } }, updated_at: '2026-10-10T16:20:00Z', created_at: '2026-10-09T00:23:00Z' }],
});

async function worker(records: Record<string, unknown>[]) {
  const { OrgXMcp } = await import('../src/index');
  const instance = Object.create(OrgXMcp.prototype) as {
    sessionContext: { workspaceId: string; initiativeId: string };
    fetchEntityCollection: ReturnType<typeof vi.fn>;
    maybeEnrichWithArtifactProof(input: { toolId: string; args: Record<string, unknown>; data: Record<string, unknown>; userId: string }): Promise<Record<string, unknown>>;
  };
  instance.sessionContext = { workspaceId: WORKSTREAM, initiativeId: INIT };
  instance.fetchEntityCollection = vi.fn(async () => records);
  return instance;
}
afterEach(() => vi.restoreAllMocks());

describe('real worker initiative proof enrichment', () => {
  it('unions the authoritative current descendant proof with a smaller old direct subset', async () => {
    const current = source();
    const instance = await worker(Array.from({ length: 3 }, (_, i) => ({ id: `old-${i}`, name: `Old direct proof ${i}`, entity_type: 'initiative', entity_id: INIT, status: 'in_review', updated_at: '2026-10-09T00:23:00Z' })));
    const result = await instance.maybeEnrichWithArtifactProof({ toolId: 'get_initiative_pulse', args: { initiative_id: INIT }, data: current, userId: 'authenticated-user' });
    expect(instance.fetchEntityCollection).toHaveBeenCalledWith(expect.objectContaining({ type: 'artifact', initiativeId: INIT, limit: 8, orderBy: 'updated_at', orderDirection: 'desc' }));
    expect(result.artifact_summary).toEqual(current.artifact_summary);
    expect(result.artifact_summary).not.toHaveProperty('delivered');
    expect(result.continuity).toEqual(current.continuity);
    expect((result.recent_artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'current', description: 'Full current proof body', status: 'in_review', version: 8, verification: { review: { notes: 'Keep this evidence' } } });
    expect((result.proof_cards as Array<Record<string, unknown>>).map((row) => row.id)).toEqual(expect.arrayContaining(['current', 'old-0', 'old-1', 'old-2']));
  });
  it('does not replace a current body or review with an older duplicate ID', async () => {
    const instance = await worker([{ id: 'current', name: 'Old body', description: 'Old proof body', version: 7, status: 'draft', entity_type: 'task', entity_id: TASK, updated_at: '2026-10-09T00:23:00Z' }]);
    const result = await instance.maybeEnrichWithArtifactProof({ toolId: 'get_initiative_pulse', args: {}, data: source(), userId: 'authenticated-user' });
    expect(result.recent_artifacts).toHaveLength(1);
    expect((result.recent_artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'current', description: 'Full current proof body', status: 'in_review', version: 8 });
  });
  it('retains current proofs when the enrichment response is empty', async () => {
    const instance = await worker([]);
    const result = await instance.maybeEnrichWithArtifactProof({ toolId: 'get_initiative_pulse', args: {}, data: source(), userId: 'authenticated-user' });
    expect((result.recent_artifacts as Array<Record<string, unknown>>).map((row) => row.id)).toEqual(['current']);
    expect(result.artifact_summary).toEqual(source().artifact_summary);
  });
  it('returns the authoritative pulse intact when supplementary retrieval fails', async () => {
    const instance = await worker([]); const pulse = source();
    instance.fetchEntityCollection.mockRejectedValue(new Error('Supplement unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(instance.maybeEnrichWithArtifactProof({ toolId: 'get_initiative_pulse', args: {}, data: pulse, userId: 'authenticated-user' })).resolves.toBe(pulse);
  });
});
