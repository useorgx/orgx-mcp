import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPTIONAL_READ_TIMEOUT_MS } from '../src/optionalRead';

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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('real worker initiative proof enrichment', () => {
  it('overlaps status evidence reads, retaining scoped legacy proof and durable task reconciliation', async () => {
    const instance = await worker([]);
    type Rows = Record<string, unknown>[];
    const releases = new Map<string, (rows: Rows) => void>();
    instance.fetchEntityCollection.mockImplementation((query: { type: string; initiativeId?: string }) =>
      new Promise<Rows>((resolve) => releases.set(query.type === 'task' ? 'tasks' : query.initiativeId ? 'initiative' : 'legacy', resolve))
    );
    const data = { agents: [{ agent_id: 'engineering-agent', initiative_id: INIT, current_tasks: [{ task_id: TASK }] }] };
    const pending = instance.maybeEnrichWithArtifactProof({ toolId: 'get_agent_status', args: {}, data, userId: 'authenticated-user' });
    const artifact = { id: 'proof', title: 'Legacy proof', version: 9, entity_type: 'task', entity_id: TASK, status: 'in_review' };
    try {
      expect([...releases.keys()].sort()).toEqual(['initiative', 'legacy', 'tasks']);
      expect(instance.fetchEntityCollection).toHaveBeenCalledWith({ type: 'task', userId: 'authenticated-user', workspaceId: WORKSTREAM, limit: 100, signal: expect.any(AbortSignal) });
    } finally {
      releases.get('legacy')?.([artifact, { ...artifact, id: 'foreign', entity_id: 'foreign-task' }]);
      releases.get('tasks')?.([{ id: TASK, title: 'Completed task', status: 'completed', assigned_agent_id: 'engineering-agent' }]);
      releases.get('initiative')?.([{ ...artifact, title: 'Older direct proof', version: 8 }]);
    }
    expect(await pending).toMatchObject({ agents: [{
      completed_tasks: [{ id: TASK }], artifact_count: 1,
      artifacts: [{ id: 'proof', title: 'Legacy proof', version: 9 }],
    }] });
  });

  it('retains the eight-request initiative batch bound while other evidence reads overlap', async () => {
    const instance = await worker([]);
    let active = 0; let peak = 0;
    instance.fetchEntityCollection.mockImplementation(async (query: { initiativeId?: string }) => {
      if (!query.initiativeId) return [];
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return [];
    });
    await instance.maybeEnrichWithArtifactProof({ toolId: 'get_agent_status', args: {},
      data: { agents: Array.from({ length: 18 }, (_, index) => ({ initiative_id: `initiative-${index}`, agent_id: 'engineering-agent' })) },
      userId: 'authenticated-user',
    });
    expect(peak).toBe(8);
    expect(instance.fetchEntityCollection).toHaveBeenCalledTimes(21);
  });
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

  it('returns authoritative status at the shared proof deadline and stops launching later batches', async () => {
    const instance = await worker([]);
    vi.useFakeTimers();
    const releases: Array<(rows: Record<string, unknown>[]) => void> = [];
    instance.fetchEntityCollection.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const data = { agents: Array.from({ length: 18 }, (_, index) => ({ initiative_id: `initiative-${index}`, agent_id: 'engineering-agent' })) };
    const pending = instance.maybeEnrichWithArtifactProof({ toolId: 'get_agent_status', args: {}, data, userId: 'authenticated-user' });
    expect(releases).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(OPTIONAL_READ_TIMEOUT_MS);
    await expect(pending).resolves.toBe(data);
    const signals = instance.fetchEntityCollection.mock.calls.map(([query]) => query.signal as AbortSignal);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(new Set(signals).size).toBe(1);
    releases.forEach((resolve) => resolve([]));
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.fetchEntityCollection).toHaveBeenCalledTimes(10);
  });

  it('delivers a committed mutation even when its welcome-back digest stalls', async () => {
    const instance = await worker([]) as unknown as Record<string, any>;
    vi.useFakeTimers();
    Object.assign(instance, {
      isDirectoryReviewProfile: () => false,
      isSubmittedInformationalToolExecution: () => false,
      resolveUserId: () => 'authenticated-user',
      mcpSessionReentryState: { version: 1, last_success_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), last_welcome_back_at: null },
      fetchOrgxJsonOrNull: vi.fn(() => new Promise(() => {})),
      saveMcpSessionReentryState: vi.fn(async () => {}),
      ctx: { waitUntil: vi.fn() },
    });
    const committed = { content: [{ type: 'text', text: 'Task updated' }], structuredContent: { id: TASK, status: 'in_progress' } };
    const pending = instance.withOrgx(async () => committed, 'orgx_update_work');
    await vi.advanceTimersByTimeAsync(OPTIONAL_READ_TIMEOUT_MS);
    const result = await pending;
    expect(result.structuredContent).toBe(committed.structuredContent);
    expect(result.content).toContainEqual(committed.content[0]);
    expect(instance.fetchOrgxJsonOrNull.mock.calls[0][2].aborted).toBe(true);
  });

  it('keeps bootstrap available when the optional uptime KV read stalls', async () => {
    const instance = await worker([]) as unknown as Record<string, any>;
    vi.useFakeTimers();
    const get = vi.fn(() => new Promise(() => {}));
    instance.env = { ORGX_API_URL: 'https://api.example.test', OAUTH_KV: { get } };
    const pending = instance.bootstrapServiceLevels();
    await vi.advanceTimersByTimeAsync(OPTIONAL_READ_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ availability_7d: null });
    expect(get).toHaveBeenCalledTimes(7);
  });
});
