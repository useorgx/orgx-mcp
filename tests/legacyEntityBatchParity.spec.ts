import { describe, expect, it } from 'vitest';
import { executeLegacyEntityBatch } from '../src/generated/legacyEntityBatchExecution';
import { normalizeEntityCreatePayloadForAgents as canonical } from '../src/generated/legacyEntityBatchPreparation';
import { normalizeEntityCreatePayloadForAgents as diagnostic } from '../src/agentErgonomics';
import fixtures from './fixtures/legacy-entity-batch-v1.json';
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
it.each(fixtures)('canonical batch transcript: $name', async fixture => {
  const scenario = fixture as typeof fixture & { failTitle?: string; existingRef?: string };
  const calls: Array<Record<string, unknown>> = [];
  const summary = await executeLegacyEntityBatch({
    ownerId: 'payload-owner-fixture', entities: structuredClone(fixture.entities), concurrency: 1, continueOnError: fixture.continueOnError,
    findExistingEntity: scenario.existingRef ? async ({ ref }) => ref === scenario.existingRef ? { id: 'replayed-root', title: 'Root' } : null : undefined,
    createEntity: async body => { calls.push({ path: '/api/entities', method: 'POST', userId: 'payload-owner-fixture', body: plain(body) }); return body.title === scenario.failTitle ? Response.json({ error: 'sanitized fixture failure' }, { status: 422 }) : Response.json({ type: body.type, data: { id: `${body.type}-${calls.length}`, title: body.title, metadata: body.metadata } }); },
  });
  expect(plain(summary)).toEqual(fixture.expected); expect(plain(calls)).toEqual(fixture.calls);
});
describe('reserved diagnostic facade agrees with canonical compatibility normalization', () => {
  for (const type of ['task', 'milestone', 'decision', 'blocker', 'artifact', 'initiative', ' task ', 'unknown']) {
    it.each([{}, { status: 'active' }, { priority: 'urgent' }, { status: 'active', priority: 'urgent' }, { status: 'invalid', priority: 'invalid' }])(`${type}: %j`, fields => {
      const input = { type, ...fields }; expect(canonical(input, 'entities[0]')).toEqual(diagnostic(input, 'entities[0]')); expect(input).toEqual({ type, ...fields });
    });
  }
});
