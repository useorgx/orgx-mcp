import { describe, expect, it } from 'vitest';
import { buildScaffoldInitiativeBatch } from '../src/scaffoldInitiative';
import { normalizeExternalSyncRequest, normalizeScaffoldObjectiveAliases } from '../src/scaffoldControl';
import { batchCreateEntities } from '../src/batchCreate';
import fixtures from './fixtures/legacy-rich-workflow-v1.json';
import { McpScaffoldWorkflowSchema } from '../src/generated/scaffoldWorkflow';

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('legacy rich workflow before server cutover', () => {
  const atomicPlan = { initiative: { title: 'Offline initiative' }, workstreams: [{ name: 'Engineering', milestones: [{ title: 'Delivery', tasks: [{ title: 'Implement fixture' }] }] }] };
  it.each([
    ['node metadata', { plan: { ...atomicPlan, initiative: { ...atomicPlan.initiative, metadata: { offline: true } } } }],
    ['objective IDs', { plan: { ...atomicPlan, initiative: { ...atomicPlan.initiative, goal_ids: ['offline-goal'] } } }],
    ['assignment array', { plan: { ...atomicPlan, workstreams: [{ ...atomicPlan.workstreams[0], assigned_agent_ids: ['engineering-agent'] }] } }],
    ['external sync', { plan: atomicPlan, external_sync: { targets: ['linear'] } }],
    ['continue on error', { plan: atomicPlan, continue_on_error: true }],
  ])('atomic v1 explicitly rejects richer %s material', (_, body) => {
    expect(McpScaffoldWorkflowSchema.safeParse({ plan: atomicPlan }).success).toBe(true);
    const parsed = McpScaffoldWorkflowSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some(issue => issue.code === 'unrecognized_keys')).toBe(true);
  });
  it.each(fixtures.plans)('preparation: $name', fixture => {
    expect(plain(buildScaffoldInitiativeBatch(fixture.input))).toEqual(fixture.expected);
    expect(plain(normalizeScaffoldObjectiveAliases(fixture.input))).toEqual(fixture.aliases);
    expect(normalizeExternalSyncRequest((fixture.input as Record<string, unknown>).external_sync)).toEqual(fixture.sync);
  });

  it.each(fixtures.batches)('injected batch transcript: $name', async fixture => {
    const calls: Array<Record<string, unknown>> = [];
    const scenario = fixture as typeof fixture & { failTitle?: string; existingRef?: string };
    const result = await batchCreateEntities({
      env: { ORGX_API_URL: 'https://example.invalid', ORGX_SERVICE_KEY: 'offline-fixture' },
      ownerId: 'payload-owner-fixture', entities: fixture.entities,
      concurrency: 1, continueOnError: fixture.continueOnError,
      findExistingEntity: scenario.existingRef ? async ({ ref }) => ref === scenario.existingRef ? { id: 'replayed-root', title: 'Root' } : null : undefined,
      // This is a transport transcript, not proof of authorization. Production
      // handlers replace userId with authenticated session identity.
      callApi: async ({ path, init, userId }) => {
        const body = JSON.parse(init.body as string);
        calls.push({ path, method: init.method, userId, body });
        return body.title === scenario.failTitle
          ? Response.json({ error: 'sanitized fixture failure' }, { status: 422 })
          : Response.json({ type: body.type, data: { id: `${body.type}-${calls.length}`, title: body.title, metadata: body.metadata } });
      },
    });
    expect(plain(result)).toEqual(fixture.expected);
    expect(plain(calls)).toEqual(fixture.calls);
  });

  it('distinguishes stop and continue on error without retrying failed writes', () => {
    const continued = fixtures.batches.find(x => x.name === 'continue after partial failure')!;
    const stopped = fixtures.batches.find(x => x.name === 'stop after partial failure')!;
    expect(continued.calls.length).toBeGreaterThan(stopped.calls.length);
    expect(continued.calls.filter(x => x.body.title === 'Fail')).toHaveLength(1);
    expect(stopped.calls.filter(x => x.body.title === 'Fail')).toHaveLength(1);
    expect(continued.expected.created_count).toBeGreaterThan(stopped.expected.created_count);
  });
});
