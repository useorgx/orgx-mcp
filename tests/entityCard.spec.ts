import { describe, expect, it } from 'vitest';

import {
  buildEntityCard,
  entityWebUrl,
  proofVerdictForStatus,
} from '../src/entityCard';

describe('entity card for orgx_inspect', () => {
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
        progress: 0.5,
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
      { label: 'Progress', value: '50%' },
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
