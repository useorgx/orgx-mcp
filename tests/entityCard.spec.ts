import { describe, expect, it } from 'vitest';

import {
  buildEntityCard,
  entityWebUrl,
  proofVerdictForStatus,
} from '../src/entityCard';

describe('entity card for orgx_inspect', () => {
  it.each(['in_review', 'approved'])('surfaces a failed evaluation even when artifact status is %s', (status) => {
    const card = buildEntityCard({ type: 'artifact', id: 'a-1', entity: {
      title: 'Release proof', status, verification: { eval: { status: 'failed', score: 0.2, threshold: 0.8 } },
    }});
    expect(card.proof).toMatchObject({ verdict: 'needs-you', rows: expect.arrayContaining([
      { label: 'Evaluation', value: 'Failed', kind: 'check' },
    ]) });
  });

  it('links each entity to its web page, and nothing where no page exists', () => {
    expect(entityWebUrl('initiative', 'i-1')).toBe(
      'https://useorgx.com/initiatives/i-1'
    );
    expect(entityWebUrl('decision', 'd-1', 'https://staging.useorgx.com')).toBe(
      'https://staging.useorgx.com/decisions/d-1'
    );
    expect(entityWebUrl('objective', 'o 1')).toBe(
      'https://useorgx.com/goals?objective=o%201'
    );
    expect(entityWebUrl('playbook', 'p-1')).toBeNull();
    expect(entityWebUrl('task', 't-1', 'not a url')).toBe(
      'https://useorgx.com/tasks/t-1'
    );
  });

  it('maps status to the same four verdicts as the app ProofRecord', () => {
    expect(proofVerdictForStatus('completed')).toBe('accepted');
    expect(proofVerdictForStatus('in_review')).toBe('verifying');
    expect(proofVerdictForStatus('blocked')).toBe('needs-you');
    expect(proofVerdictForStatus('active')).toBe('open');
    expect(proofVerdictForStatus(null)).toBe('open');
  });

  it('builds facts, a proof record, and linked items from the context pack', () => {
    const card = buildEntityCard({
      type: 'initiative',
      id: 'i-1',
      entity: {
        title: 'Launch self-serve',
        status: 'completed',
        description: 'Ship pricing and checkout.',
        owner_name: 'Hope',
        progress: 50,
      },
      contextPack: {
        decisions: [{ title: 'Annual pricing' }, { title: 'Discount' }],
        artifacts: [{ title: 'Pricing page' }],
        blockers: [{ title: 'Stripe keys' }],
        frame: { definitionOfDone: { checks: ['a', 'b', 'c'] } },
      },
    });
    expect(card.title).toBe('Launch self-serve');
    expect(card.url).toBe('https://useorgx.com/initiatives/i-1');
    expect(card.facts).toEqual([
      { label: 'Owner', value: 'Hope' },
      { label: 'Task completion', value: 'Not provided' },
      { label: 'Recorded progress', value: '50%' },
    ]);
    expect(card.proof).toEqual({
      // An open blocker keeps completed work out of "accepted".
      verdict: 'needs-you',
      rows: [
        { label: 'Decisions', value: '2', kind: 'decision' },
        { label: 'Artifacts', value: '1', kind: 'artifact' },
        { label: 'Checks', value: '3', kind: 'check' },
        { label: 'Open blockers', value: '1', kind: 'neutral' },
      ],
    });
    expect(card.related.map((item) => item.title)).toEqual([
      'Annual pricing',
      'Discount',
    ]);
  });

  it('leaves the proof record off entities that do not carry proof', () => {
    const card = buildEntityCard({
      type: 'decision',
      id: 'd-1',
      entity: { title: 'Annual pricing', status: 'pending' },
      contextPack: { decisions: [{ title: 'x' }] },
    });
    expect(card.proof).toBeNull();
    expect(card.status).toBe('pending');
  });
});

describe('orgx_inspect output schema', () => {
  it('accepts the card alongside the entity and context pack', async () => {
    const { CANONICAL_OUTPUT_SCHEMAS } = await import(
      '../src/openaiOutputSchemas/canonical'
    );
    const card = buildEntityCard({
      type: 'task',
      id: 't-1',
      entity: { title: 'Write pricing copy', status: 'in_review' },
      contextPack: { artifacts: [{ title: 'Draft' }] },
    });
    const result = CANONICAL_OUTPUT_SCHEMAS.orgx_inspect.safeParse({
      _v2_tool: 'orgx_inspect',
      type: 'task',
      id: 't-1',
      entity: { id: 't-1', title: 'Write pricing copy' },
      card,
    });
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});

describe('parent cards distinguish recorded progress from task completion', () => {
  it('keeps the actual native 50% workstream reading separate from unknown task completion', () => {
    const entity = { id: 'stream-1', initiative_id: 'initiative-1', name: 'Receipt integrity', status: 'active', progress: 50 };
    const card = buildEntityCard({ type: 'workstream', id: entity.id, entity });
    expect(card.facts).toEqual([
      { label: 'Task completion', value: 'Not provided' },
      { label: 'Recorded progress', value: '50%' },
    ]);
    expect(card.status).toBe('active');
    expect(entity).toEqual({ id: 'stream-1', initiative_id: 'initiative-1', name: 'Receipt integrity', status: 'active', progress: 50 });
  });

  it.each([
    ['workstream', 1, 8, 13],
    ['initiative', 4, 36, 11],
    ['workstream', 0, 8, 0],
    ['initiative', 36, 36, 100],
  ] as const)('reports %s task completion from its exact count pair', (type, completed, total, pct) => {
    const card = buildEntityCard({ type, id: 'parent-1', entity: {
      progress: 50, continuity: {
        version: 'initiative-continuity.v1', source: 'workstream_tasks',
        progress: { completed, total, pct: 87 },
      },
    }});
    expect(card.facts).toEqual([
      { label: 'Task completion', value: `${completed} of ${total} tasks done (${pct}%)` },
      { label: 'Recorded progress', value: '50%' },
    ]);
  });

  it.each([
    { completed: null, total: null },
    { completed: 0, total: 0 },
    { completed: 2, total: 1 },
    { completed: -1, total: 8 },
    { completed: 0.5, total: 8 },
    { completed: 1, total: 8.5 },
    { completed: '1', total: 8 },
    { completed: 1, total: Number.POSITIVE_INFINITY },
  ])('does not turn invalid or unavailable counts into completed work: %j', (progress) => {
    const card = buildEntityCard({ type: 'workstream', id: 'stream-1', entity: {
      progress: 50, continuity: { version: 'initiative-continuity.v1', source: 'workstream_tasks', progress },
    }});
    expect(card.facts[0]).toEqual({ label: 'Task completion', value: 'Not provided' });
    expect(card.facts.some((fact) => fact.value.includes('tasks done'))).toBe(false);
  });

  it('does not borrow an enclosing initiative tally or a partial task list for the inspected workstream', () => {
    const card = buildEntityCard({ type: 'workstream', id: 'stream-1', entity: {
      progress: 50, workstream_tasks: [{ id: 'one-task', status: 'done' }],
    }, contextPack: {
      continuity: { version: 'initiative-continuity.v1', source: 'workstream_tasks', progress: { completed: 4, total: 36, pct: 11 } },
    }});
    expect(card.facts[0]).toEqual({ label: 'Task completion', value: 'Not provided' });
  });

  it.each([
    ['future-version', 'workstream_tasks'],
    ['initiative-continuity.v1', 'initiative_rollup'],
  ])('does not call %s / %s a canonical task tally', (version, source) => {
    const card = buildEntityCard({ type: 'initiative', id: 'initiative-1', entity: {
      progress: 50, continuity: { version, source, progress: { completed: 4, total: 36 } },
    }});
    expect(card.facts[0]).toEqual({ label: 'Task completion', value: 'Not provided' });
  });

  it.each([0, 1, 50, 100])('preserves the native workstream percentage unit for %s', (progress) => {
    const card = buildEntityCard({ type: 'workstream', id: 'stream-1', entity: { progress } });
    expect(card.facts[1]).toEqual({ label: 'Recorded progress', value: `${progress}%` });
  });

  it('rounds a fractional native parent percentage without treating it as a legacy fraction', () => {
    const entity = { progress: 0.5 };
    const card = buildEntityCard({ type: 'workstream', id: 'stream-1', entity });
    expect(card.facts).toEqual([
      { label: 'Task completion', value: 'Not provided' },
      { label: 'Recorded progress', value: '1%' },
    ]);
    expect(entity.progress).toBe(0.5);
  });

  it('uses the native initiative progress_pct when present without changing its value', () => {
    const entity = { progress_pct: 1, progress: 50 };
    const card = buildEntityCard({ type: 'initiative', id: 'initiative-1', entity });
    expect(card.facts[1]).toEqual({ label: 'Recorded progress', value: '1%' });
    expect(entity).toEqual({ progress_pct: 1, progress: 50 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101])('does not invent a valid recorded percentage from %s', (progress) => {
    const card = buildEntityCard({ type: 'workstream', id: 'stream-1', entity: { progress } });
    expect(card.facts).toEqual([{ label: 'Task completion', value: 'Not provided' }]);
  });

  it('preserves the existing non-parent progress convention', () => {
    const card = buildEntityCard({ type: 'artifact', id: 'artifact-1', entity: { progress: 0.5 } });
    expect(card.facts).toEqual([{ label: 'Progress', value: '50%' }]);
  });
});
