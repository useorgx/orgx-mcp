import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('uses lifecycle to signal review and attention while leaving acceptance unverified', () => {
    expect(proofVerdictForStatus('completed')).toBe('open');
    expect(proofVerdictForStatus('in_review')).toBe('verifying');
    expect(proofVerdictForStatus('blocked')).toBe('needs-you');
    expect(proofVerdictForStatus('active')).toBe('open');
    expect(proofVerdictForStatus(null)).toBe('open');
  });

  it.each(['complete', 'completed', 'done', 'shipped', 'published', 'approved', 'accepted'])(
    'keeps lifecycle %s and four defined checks separate from accepted proof',
    (status) => {
      const card = buildEntityCard({
        type: 'task',
        id: 'task-1',
        entity: { title: 'Release', status },
        contextPack: { frame: { definitionOfDone: { checks: ['lint', 'types', 'tests', 'review'] } } },
      });
      expect(card.status).toBe(status);
      expect(card.proof).toMatchObject({
        verdict: 'open',
        rows: expect.arrayContaining([{ label: 'Checklist items', value: '4', kind: 'check' }]),
      });
    }
  );

  it('records a human review without turning an unversioned artifact approval into accepted proof', () => {
    const card = buildEntityCard({
      type: 'artifact',
      id: 'art-1',
      entity: {
        title: 'Release report',
        status: 'approved',
        version: 2,
        verification: {
          human_review: {
            status: 'approved',
            reviewed_at: '2026-05-13T10:00:00Z',
            reviewed_by: 'founder',
            reviewer_kind: 'human',
            auto_approved: false,
          },
        },
      },
    });
    expect(card.status).toBe('approved');
    expect(card.proof?.verdict).toBe('open');
    expect(card.proof?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringMatching(/review/i),
          value: expect.stringMatching(/approved/i),
        }),
      ])
    );
  });

  it('does not call an automated approval a recorded human review', () => {
    const card = buildEntityCard({
      type: 'artifact',
      id: 'art-1',
      entity: {
        status: 'approved',
        verification: {
          human_review: {
            status: 'approved',
            reviewed_at: '2026-05-13T10:00:00Z',
            reviewed_by: 'worker',
            reviewer_kind: 'agent',
            auto_approved: true,
          },
        },
      },
    });
    expect(card.proof?.verdict).toBe('open');
    expect(card.proof?.rows.some((row) => row.label === 'Recorded review')).toBe(false);
  });

  it('treats a passing evaluation and producer acceptance claims as unverified', () => {
    const card = buildEntityCard({
      type: 'artifact',
      id: 'art-1',
      entity: {
        status: 'approved',
        version: 2,
        verification: { eval: { status: 'passed', score: 1, threshold: 0.8 } },
        metadata: { reviewContract: { ruling: { state: 'accepted' } }, acceptance_status: 'accepted' },
      },
      contextPack: { decisions: [{ disposition: 'accepted', title: 'Sibling decision' }] },
    });
    expect(card.proof?.verdict).toBe('open');
    expect(card.proof?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Evaluation', value: expect.stringMatching(/passed/i) }),
      ])
    );
  });

  it.each(['active', 'in_review', 'done'])('keeps open blockers visible at lifecycle %s', (status) => {
    const card = buildEntityCard({
      type: 'task',
      id: 'task-1',
      entity: { status },
      contextPack: { blockers: [{ title: 'Scope decision needed' }] },
    });
    expect(card.proof).toMatchObject({
      verdict: 'needs-you',
      rows: expect.arrayContaining([{ label: 'Open blockers', value: '1', kind: 'neutral' }]),
    });
  });

  it('marks a subthreshold evaluation as failed and retains the separate open blocker', () => {
    const card = buildEntityCard({
      type: 'task',
      id: 'task-1',
      entity: {
        status: 'active',
        verification: { eval: { status: 'passed', score: 0.4, threshold: 0.8 } },
      },
      contextPack: { blockers: [{ title: 'Waiting on QA' }] },
    });
    expect(card.proof).toMatchObject({
      verdict: 'needs-you',
      rows: expect.arrayContaining([
        { label: 'Open blockers', value: '1', kind: 'neutral' },
        { label: 'Evaluation', value: 'Failed', kind: 'check' },
      ]),
    });
  });

  it.each(['task', 'objective', 'run'])('reports unverified acceptance for a completed %s with no attached ruling', (type) => {
    const card = buildEntityCard({ type, id: 'entity-1', entity: { status: 'completed' } });
    expect(card.status).toBe('completed');
    expect(card.proof?.verdict).toBe('open');
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
        { label: 'Checklist items', value: '3', kind: 'check' },
        { label: 'Open blockers', value: '1', kind: 'neutral' },
        { label: 'Acceptance', value: 'Unverified', kind: 'neutral' },
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

// Boots the real widget in JSDOM with its shared scripts (the MCP Apps SDK is
// skipped; ChatGPT globals deliver the payload).
async function bootEntityCard(toolOutput: unknown) {
  const { JSDOM } = await import('jsdom');
  const root = resolve(process.cwd(), 'public/widgets');
  const html = readFileSync(resolve(root, 'entity-card.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://mcp.useorgx.com/widgets/entity-card.html', runScripts: 'outside-only' });
  Object.assign(dom.window, { openai: { toolOutput, callTool: vi.fn(), setWidgetHeight: vi.fn() }, fetch: vi.fn().mockResolvedValue({ ok: true }) });
  for (const script of dom.window.document.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    if (src && /mcp-apps-sdk/.test(src)) continue;
    dom.window.eval(src ? readFileSync(resolve(root, src), 'utf8') : script.textContent!);
  }
  await vi.advanceTimersByTimeAsync(400);
  return dom;
}

describe('entity card widget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('draws a plan session inspected by orgx_inspect', async () => {
    const dom = await bootEntityCard({
      _v2_tool: 'orgx_inspect', type: 'plan_session', session_id: '11111111-1111-1111-1111-111111111111',
      status: 'drafting', plan_session: { title: 'Launch plan', status: 'drafting' },
    });
    const text = dom.window.document.getElementById('content')!.textContent!;
    expect(text).toContain('Launch plan');
    expect(text).not.toContain('Nothing to show here');
    dom.window.close();
  });

  it.each([
    { status: 'completed', blockers: [], proofLabel: 'Unverified', lifecycleState: 'succeeded' },
    {
      status: 'active',
      blockers: [{ title: 'Waiting on QA' }],
      proofLabel: 'Needs attention',
      lifecycleState: 'running',
    },
  ])(
    'renders lifecycle $status and a separate $proofLabel proof chip',
    async ({ status, blockers, proofLabel, lifecycleState }) => {
      const card = buildEntityCard({
        type: 'task',
        id: 'task-1',
        entity: { title: 'Cut release', status },
        contextPack: { blockers },
      });
      const dom = await bootEntityCard({ _v2_tool: 'orgx_inspect', type: 'task', id: 'task-1', card });
      try {
        const document = dom.window.document;
        expect(document.querySelector('.ec-status')?.getAttribute('state')).toBe(lifecycleState);
        const verdict = document.querySelector('.ec-verdict');
        expect(verdict?.hasAttribute('hidden')).toBe(false);
        expect(verdict?.getAttribute('label')).toBe(proofLabel);
      } finally {
        dom.window.close();
      }
    }
  );

  it('renders four defined checks as a count alongside unverified acceptance', async () => {
    const card = buildEntityCard({
      type: 'task',
      id: 'task-1',
      entity: { title: 'Release', status: 'done' },
      contextPack: { frame: { definitionOfDone: { checks: ['lint', 'types', 'unit', 'smoke'] } } },
    });
    const dom = await bootEntityCard({ _v2_tool: 'orgx_inspect', type: 'task', id: 'task-1', card });
    try {
      const section = dom.window.document.querySelector('.ec-proof');
      expect(section?.querySelector('.ec-counts [data-kind="check"]')?.textContent).toMatch(/4\s+checklist items/i);
      expect(section?.querySelector('.ec-verdict')?.getAttribute('label')).toBe('Unverified');
      expect(section?.querySelector('ox-receipt-row[status="met"]')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('shows an unverified chip for a persisted legacy card that inferred acceptance from completed work', async () => {
    const card = {
      type: 'task',
      id: 'task-1',
      title: 'Cut release',
      status: 'done',
      facts: [],
      related: [],
      proof: { verdict: 'accepted', rows: [{ label: 'Checks', value: '4', kind: 'check' }] },
    };
    const dom = await bootEntityCard({ _v2_tool: 'orgx_inspect', type: 'task', id: 'task-1', card });
    try {
      const section = dom.window.document.querySelector('.ec-proof');
      const verdict = section?.querySelector('.ec-verdict');
      expect(verdict?.getAttribute('label')).toBe('Unverified');
      expect(verdict?.hasAttribute('hidden')).toBe(false);
      expect(section?.querySelector('.ec-counts [data-kind="check"]')?.textContent).toMatch(/4\s+checklist items/i);
    } finally {
      dom.window.close();
    }
  });

  it('keeps a completed evaluation awaiting a result', async () => {
    const card = buildEntityCard({
      type: 'artifact', id: 'art-1', entity: { title: 'Release evidence', status: 'approved',
        verification: { eval: { status: 'completed' } } },
    });
    const dom = await bootEntityCard({ _v2_tool: 'orgx_inspect', type: 'artifact', id: 'art-1', card });
    try {
      const row = dom.window.document.querySelector('ox-receipt-row[label="Evaluation"]');
      expect(row?.getAttribute('value')?.toLowerCase()).toBe('completed');
      expect(row?.getAttribute('status')).toMatch(/^(pending|unverified)$/);
    } finally {
      dom.window.close();
    }
  });

  it('formats the Updated timestamp in the viewer zone and keeps due dates as calendar days', async () => {
    const updated = new Date(Date.now() - 60_000).toISOString();
    const expected = await (async () => {
      const probe = await bootEntityCard({ type: 'task', id: 't-0', card: { type: 'task', id: 't-0', title: 'Probe', facts: [] } });
      const value = (probe.window as any).OrgXTime.when(updated) as string;
      probe.window.close();
      return value;
    })();
    const card = buildEntityCard({ type: 'task', id: 't-1', entity: { title: 'Ship it', updated_at: updated, due_date: '2030-01-15' } });
    expect(card.facts).toEqual(expect.arrayContaining([{ label: 'Updated', value: updated }, { label: 'Due', value: '2030-01-15' }]));
    const dom = await bootEntityCard({ type: 'task', id: 't-1', card });
    const facts = Object.fromEntries(Array.from(dom.window.document.querySelectorAll('.ec-facts > div'))
      .map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent!.trim()]));
    expect(facts.Updated).toBe(expected);
    expect(facts.Updated).not.toMatch(/Tomorrow|Today/);
    expect(facts.Due).toMatch(/Jan 15, 2030/);
    dom.window.close();
  });
});
