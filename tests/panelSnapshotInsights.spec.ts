import { describe, expect, it, vi } from 'vitest';
import { outputFrontDoor } from './fixtures/outputFrontDoor';

import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';
import {
  buildPanelGoals,
  buildPanelGoalsWithReasons,
  buildPanelOutputs,
  goalsFailure,
  outputFamily,
  PANEL_GOAL_REASONS_META_KEY,
  PANEL_PREVIEW_META_KEY,
} from '../src/panelInsights';
import { buildPanelSnapshot, buildPanelWork, handlePanelSnapshot, type PanelSnapshot, type PanelSurfaceHost } from '../src/panelSurface';

/**
 * The redesign's new reads: Outputs, Goals, where a decision sits, what
 * happens if nobody decides, number questions, ready answers and a task's
 * place. Each piece carries only what OrgX recorded, and the words people or
 * agents wrote (previews, move reasons, evidence bodies) stay out of the
 * snapshot the model reads.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const INIT = '22222222-2222-4222-8222-222222222222';
const WSTREAM = '44444444-4444-4444-8444-444444444444';
const MILESTONE = '55555555-5555-4555-8555-555555555555';
const TASK = '66666666-6666-4666-8666-666666666666';
const GOAL = '77777777-7777-4777-8777-777777777777';
const ART = 'a1111111-1111-4111-8111-111111111111';
const ART2 = 'a2222222-2222-4222-8222-222222222222';
const ART3 = 'a3333333-3333-4333-8333-333333333333';
const D1 = '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c';
const PREVIEW = 'PRIVATE PREVIEW TEXT the model must not read';
const SUMMARY = 'PRIVATE SUMMARY TEXT the model must not read';
const REASON = 'PRIVATE MOVE REASON the model must not read';
const EVIDENCE_BODY = 'FULL EVIDENCE BODY that must never reach the snapshot';

function packet(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'orgx.human-review-packet.v1',
    id: `pkt-${D1}`,
    headDecisionId: D1,
    question: 'Ship it?',
    current: { state: 'pending', owner: null, blocked: false },
    recommendation: { status: 'ready', action: 'Approve', rationale: 'private rationale', provenance: null },
    evidence: [
      { id: 'ev-0', title: 'CI run', summary: EVIDENCE_BODY, sourceUrl: 'https://github.com/acme/repo/actions/runs/1', sourcePointer: 'src/app.ts:42', confidence: 0.92, freshness: '2026-10-01T09:00:00.000Z' },
      { id: 'ev-1', title: 'Percent confidence', summary: EVIDENCE_BODY, sourceUrl: null, sourcePointer: null, confidence: 80, freshness: 'not a date' },
    ],
    consequences: { approve: 'The deploy job starts.', change: null, reject: 'The agent revises.', defer: 'The release slips a week.', notCovered: 'The pricing copy.' },
    references: [
      { id: INIT, type: 'initiative', label: 'Release initiative', href: null },
      { id: WSTREAM, type: 'workstream', label: 'Checkout', href: null },
      { id: TASK, type: 'task', label: 'Wire the flag', href: null },
      { id: ART, type: 'artifact', label: 'PR', href: null },
    ],
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...extra,
  };
}

function decision(extra: Record<string, unknown> = {}) {
  return {
    id: D1,
    type: 'decision_queue',
    agent_name: 'Eli',
    summary: 'Ship release 4.2?',
    urgency: 'high',
    created_at: '2026-09-30T10:00:00.000Z',
    context: { initiative_id: INIT, milestone_id: MILESTONE },
    options: [],
    review_packet: packet(),
    widget_actionable: true,
    ...extra,
  };
}

function artifact(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Output ${id.slice(0, 4)}`,
    artifact_type: 'pull_request',
    status: 'in_review',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    description: 'artifact body that is not part of the panel',
    ...extra,
  };
}

describe('a decision packet, as far as OrgX recorded it', () => {
  const snap = () => buildPanelSnapshot({ workspace: { id: WS, name: 'Acme' }, decisions: [decision()], artifacts: [], viewerUserIds: [VIEWER] });

  it('names every level the packet or context names, and no others', () => {
    const levels = snap().focus!.levels!;
    expect(levels.initiative).toEqual({ id: INIT, title: 'Release initiative' });
    expect(levels.workstream).toEqual({ id: WSTREAM, title: 'Checkout' });
    expect(levels.milestone).toEqual({ id: MILESTONE, title: null });
    expect(levels.task).toEqual({ id: TASK, title: 'Wire the flag' });
    // No objective reference or id: the goal level stays empty rather than guessed.
    expect(levels.goal).toBeNull();
  });

  it('carries what happens if nobody decides and what it does not cover', () => {
    const focus = snap().focus!;
    expect(focus.consequence_if_deferred).toBe('The release slips a week.');
    expect(focus.consequence_not_covered).toBe('The pricing copy.');
  });

  it('joins the decision to the task it holds up and the output it is about', () => {
    const row = snap().queue[0]!;
    expect(row.task_id).toBe(TASK);
    expect(row.artifact_id).toBe(ART);
  });

  it('keeps evidence pointer, confidence and a real freshness, never the evidence body', () => {
    const s = snap();
    const [ci, pct] = s.focus!.evidence;
    expect(ci).toEqual({ title: 'CI run', source_url: 'https://github.com/acme/repo/actions/runs/1', pointer: 'src/app.ts:42', confidence: 0.92, freshness: '2026-10-01T09:00:00.000Z' });
    // A percent becomes a fraction; a freshness that is not a time is dropped.
    expect(pct).toEqual({ title: 'Percent confidence', source_url: null, confidence: 0.8 });
    const text = JSON.stringify(s);
    for (const forbidden of [EVIDENCE_BODY, 'private rationale', 'artifact body', 'summary']) expect(text).not.toContain(forbidden);
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });
});

describe('number questions and ready answers', () => {
  const contract = (extra: Record<string, unknown>) => ({
    kind: 'decision', actions: ['approve', 'reject'], labels: { approve: 'Send', reject: 'Send back' },
    reject_requires_reason: false, selection: null, items: null, answer: null, questions: null, ...extra,
  });
  const build = (actions: Record<string, unknown>) =>
    buildPanelSnapshot({ workspace: { id: WS, name: 'Acme' }, decisions: [decision({ widget_actions: actions })], artifacts: [] });

  it('carries a number field with its range and recommended amount', () => {
    const s = build(contract({ questions: { fields: [{ id: 'budget', type: 'number', label: 'Monthly budget', min: 0, max: '5000', step: 50, unit: 'USD', recommended_value: 1200, required: true }] } }));
    const field = s.focus!.widget_actions!.questions!.fields[0]!;
    expect(field.type).toBe('number');
    expect(field.number).toEqual({ min: 0, max: 5000, step: 50, unit: 'USD', recommended: 1200 });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });

  it('drops a recommended amount outside the range, and refuses a number field with no range', () => {
    const outside = build(contract({ questions: { fields: [{ id: 'n', type: 'number', label: 'Seats', min: 1, max: 10, recommended_value: 40 }] } }));
    expect(outside.focus!.widget_actions!.questions!.fields[0]!.number).toEqual({ min: 1, max: 10, step: 1, unit: null, recommended: null });
    const noRange = build(contract({ questions: { fields: [{ id: 'n', type: 'number', label: 'Seats' }] } }));
    expect(noRange.focus!.widget_actions?.questions ?? null).toBeNull();
  });

  it('carries the asker’s ready answers, deduped and at most six', () => {
    const s = build(contract({ answer: { required_for: ['approve'], max_length: 2000, suggestions: ['Yes, ship Friday', 'Yes, ship Friday', 'Hold for QA', 42, '', 'a', 'b', 'c', 'd', 'e'] } }));
    expect(s.focus!.widget_actions!.answer!.suggestions).toEqual(['Yes, ship Friday', 'Hold for QA', 'a', 'b', 'c', 'd']);
    const none = build(contract({ answer: { required_for: ['approve'], max_length: 2000 } }));
    expect(none.focus!.widget_actions!.answer!.suggestions).toBeUndefined();
  });
});

describe('where a task sits', () => {
  it('names its initiative, blocker and steps only when the agent status reports them', () => {
    const work = buildPanelWork({
      agents: [
        { agent_name: 'Dana', status: 'blocked', initiative_id: INIT, current_tasks: [
          { id: TASK, title: 'Wire the flag', status: 'blocked', blocker: 'Needs the staging key', workstream_id: WSTREAM, milestone_id: 'not-a-uuid',
            steps: [{ title: 'Read the spec', status: 'done' }, { title: 'Wire it', state: 'in progress' }, { title: 'Ship', status: 'todo' }, { title: 'Mystery', status: 'weird' }] },
        ] },
        { agent_name: 'Eli', status: 'running', current_tasks: [{ id: 'other', title: 'Reconcile', status: 'in_progress', blocker: 'ignored while running' }] },
      ],
    });
    const [dana, eli] = work.items;
    expect(dana).toMatchObject({ initiative_id: INIT, workstream_id: WSTREAM, blocker: 'Needs the staging key' });
    expect(dana!.milestone_id).toBeUndefined();
    expect(dana!.steps).toEqual([
      { title: 'Read the spec', state: 'done' },
      { title: 'Wire it', state: 'live' },
      { title: 'Ship', state: 'pending' },
    ]);
    // A running task's blocker is not shown; no steps, no step list.
    expect(eli!.blocker).toBeUndefined();
    expect(eli!.steps).toBeUndefined();
  });
});

describe('Outputs', () => {
  it('places each output on its chain from what the record says, newest first', () => {
    const { outputs } = buildPanelOutputs([
      artifact(ART, { artifact_type: 'pull_request', status: 'in_review', created_at: '2026-10-03T00:00:00.000Z', primary_url: 'https://github.com/acme/repo/pull/7' }),
      artifact(ART2, { artifact_type: 'blog_post', status: 'approved', approved_by_user_id: VIEWER, approved_at: '2026-10-02T12:00:00.000Z', created_at: '2026-10-02T00:00:00.000Z',
        metadata: { published_at: '2026-10-02T15:00:00.000Z', goal_impact: { objective_id: GOAL, label: '+2 paid workspaces' } } }),
      artifact(ART3, { artifact_type: 'image', status: 'approved', approved_by_user_id: 'system:judge', created_at: '2026-10-01T00:00:00.000Z', primary_url: 'javascript:alert(1)' }),
      artifact('not-a-uuid'),
      artifact('a4444444-4444-4444-8444-444444444444', { superseded_by: ART }),
    ], { viewerIds: [VIEWER], decisionByArtifact: new Map([[ART, D1]]) });
    expect(outputs.status).toBe('ok');
    expect(outputs.items.map((o) => [o.id, o.family, o.accepted.state])).toEqual([
      [ART, 'code', 'waiting'],
      [ART2, 'writing', 'accepted'],
      [ART3, 'media', 'unknown'],
    ]);
    const [pr, post, image] = outputs.items;
    expect(pr!.decision_id).toBe(D1);
    expect(pr!.external_url).toBe('https://github.com/acme/repo/pull/7');
    expect(pr!.landed).toBeNull();
    expect(post!.accepted).toEqual({ state: 'accepted', at: '2026-10-02T12:00:00.000Z', by: 'you' });
    expect(post!.landed).toEqual({ label: 'Published', at: '2026-10-02T15:00:00.000Z' });
    expect(post!.moved).toEqual({ objective_id: GOAL, label: '+2 paid workspaces' });
    // A judge's approval is not a person's acceptance; a non-https link is dropped.
    expect(image!.accepted.by).toBeNull();
    expect(image!.external_url).toBeNull();
  });

  it('reads checks from the checklist or the self-check, with the quality bar named only when recorded', () => {
    const { outputs } = buildPanelOutputs([
      artifact(ART, { verification: { criteria_checklist: { 'Has tests': true, 'Under 400 lines': false }, quality_bar: { name: 'Code' } } }),
      artifact(ART2, { verification: { self_check: { criteria_met: ['Cites sources'], criteria_unmet: ['Has a CTA'] } } }),
    ], { viewerIds: [] });
    const [a, b] = outputs.items;
    expect(a!.checks).toEqual([{ label: 'Has tests', met: true }, { label: 'Under 400 lines', met: false }]);
    expect(a!.checks_source).toBe('Code');
    expect(b!.checks).toEqual([{ label: 'Cites sources', met: true }, { label: 'Has a CTA', met: false }]);
    expect(b!.checks_source).toBeNull();
  });

  it('keeps the preview and summary out of the outputs and hands them to the widget alone', () => {
    const built = buildPanelOutputs([
      artifact(ART, { description: null, summary: SUMMARY, preview_markdown: PREVIEW }),
      artifact(ART2, { description: null }),
    ], { viewerIds: [] });
    expect(built.outputs.items.map((o) => o.has_preview)).toEqual([true, false]);
    expect(Object.keys(built.previews)).toEqual([ART]);
    expect(built.previews[ART]).toEqual({ summary: SUMMARY, preview: PREVIEW });
    const text = JSON.stringify(built.outputs);
    for (const forbidden of [SUMMARY, PREVIEW, 'artifact body', 'summary', 'preview_markdown']) expect(text).not.toContain(forbidden);
    expect(PANEL_PREVIEW_META_KEY).toBe('orgx/panelPreviews');
  });

  it('says unavailable when the artifact read failed, never an empty list', () => {
    expect(buildPanelOutputs(null, { viewerIds: [] }).outputs).toEqual({ status: 'unavailable', items: [], total: 0 });
  });

  it('places types into the four families, and anything else as other', () => {
    expect(['pull_request', 'blog_post', 'figma_mockup', 'runbook', 'mystery', null].map(outputFamily)).toEqual(['code', 'writing', 'media', 'routine', 'other', 'other']);
  });
});

describe('Goals', () => {
  const payload = {
    data: {
      objectives: [
        {
          id: GOAL, title: '40 paid workspaces', status: 'active', unit: 'workspaces', timeframe: '2026-12-31',
          target_value: 40, current_value: 23, baseline_value: 12,
          history: [{ at: '2026-09-01T00:00:00.000Z', value: 12 }, { at: 'nope', value: 3 }, { at: '2026-10-01T00:00:00.000Z', value: 23 }],
          moves: [
            { at: '2026-10-01T00:00:00.000Z', from: 21, to: 23, rationale: REASON, decision_id: D1 },
            { at: '2026-09-20T00:00:00.000Z', from: 19, to: 21 },
            { at: 'bad', from: 1, to: 2 },
          ],
          initiatives: [{ id: INIT, title: 'Release', status: 'active', risk_level: 'at_risk', milestones_total: 4, milestones_done: 9 }, { id: 'nope' }],
          initiative_total: 3,
        },
        { id: 'not-a-uuid', title: 'Dropped' },
      ],
      objective_total: 1,
      unlinked_initiatives: [{ id: WSTREAM, title: 'Docs refresh', milestones_total: 0, milestones_done: 0 }],
      unlinked_total: 1,
      quality_bars: [{ id: 'qb-code', name: 'Code', domain: 'engineering', criteria: 6 }, { id: 'qb-x' }],
    },
  };

  it('carries progress, history and initiatives as recorded', () => {
    const goals = buildPanelGoals(payload);
    expect(goals.status).toBe('ok');
    const [g] = goals.items;
    expect(g).toMatchObject({ id: GOAL, unit: 'workspaces', due: '2026-12-31', target: 40, current: 23, baseline: 12, initiative_total: 3 });
    expect(g!.history).toEqual([{ at: '2026-09-01T00:00:00.000Z', value: 12 }, { at: '2026-10-01T00:00:00.000Z', value: 23 }]);
    expect(g!.moves.map((m) => [m.delta, m.has_reason, m.decision_id])).toEqual([[2, true, D1], [2, false, null]]);
    // Milestones done never exceed the total.
    expect(g!.initiatives).toEqual([expect.objectContaining({ id: INIT, risk: 'at_risk', milestones_total: 4, milestones_done: 4 })]);
    expect(goals.unlinked.map((i) => i.title)).toEqual(['Docs refresh']);
    expect(goals.quality_bars).toEqual([{ id: 'qb-code', name: 'Code', domain: 'engineering', criteria: 6 }]);
  });

  it('keeps why a goal moved out of the snapshot and hands it to the widget alone', () => {
    const { goals, reasons } = buildPanelGoalsWithReasons(payload);
    expect(JSON.stringify(goals)).not.toContain(REASON);
    expect(JSON.stringify(goals)).not.toContain('rationale');
    expect(reasons).toEqual({ [GOAL]: [REASON, null] });
    expect(PANEL_GOAL_REASONS_META_KEY).toBe('orgx/panelGoalReasons');
  });

  it('says quality bars could not be read when the read had none, and unavailable without objectives', () => {
    expect(buildPanelGoals({ data: { objectives: [] } }).quality_bars).toBeNull();
    const failed = buildPanelGoals(null, goalsFailure({ status: 404 }));
    expect(failed).toMatchObject({ status: 'unavailable', items: [], reason: 'This OrgX workspace cannot report goal progress yet.' });
    expect(goalsFailure({ status: 403 })).toBe('This account cannot read goals in this workspace.');
    expect(goalsFailure(new Error('x'))).toBe('Goals could not be read right now.');
  });

  it('fits the output schema in the snapshot', () => {
    const s = buildPanelSnapshot({ workspace: { id: WS, name: 'Acme' }, decisions: [], artifacts: [] });
    s.goals = buildPanelGoals(payload);
    s.outputs = buildPanelOutputs([artifact(ART, { summary: SUMMARY })], { viewerIds: [] }).outputs;
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });
});

describe('the outputs and goals reads', () => {
  const goalsPayload = { data: { objectives: [{ id: GOAL, title: 'Goal', target_value: 10, current_value: 4, moves: [{ at: '2026-10-01T00:00:00.000Z', from: 3, to: 4, rationale: REASON }] }], quality_bars: [] } };
  function host(overrides: Partial<PanelSurfaceHost> = {}): PanelSurfaceHost {
    return {
      authRequired: vi.fn(() => null),
      viewerUserIds: vi.fn(() => [VIEWER]),
      sessionWorkspace: vi.fn(() => ({ id: WS, name: 'Acme' })),
      inferWorkspace: vi.fn(async () => null),
      fetchPendingDecisions: vi.fn(async () => ({ ok: true, data: { decisions: [decision()], _widget_meta: { approval_tokens: { [D1]: 'tok-1' }, token_ttl_seconds: 900 } } })),
      fetchArtifacts: vi.fn(async () => [artifact(ART, { description: null, summary: SUMMARY, preview_markdown: PREVIEW })]),
      fetchGoalProgress: vi.fn(async () => goalsPayload),
      run: vi.fn((runner) => runner()),
      ...overrides,
    } as PanelSurfaceHost;
  }

  it('adds outputs only for view outputs, with the decision joined and the words in _meta only', async () => {
    const h = host();
    const plain = await handlePanelSnapshot(h, {});
    expect((plain.structuredContent as Record<string, unknown>).outputs).toBeUndefined();
    const result = await handlePanelSnapshot(h, { view: 'outputs' });
    const snap = result.structuredContent as unknown as PanelSnapshot;
    expect(snap.outputs!.items.map((o) => [o.id, o.decision_id, o.has_preview])).toEqual([[ART, D1, true]]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(PREVIEW);
    expect(JSON.stringify(result.structuredContent)).not.toContain(SUMMARY);
    expect((result._meta as Record<string, unknown>)[PANEL_PREVIEW_META_KEY]).toEqual({ [ART]: { summary: SUMMARY, preview: PREVIEW } });
    expect(h.fetchGoalProgress).not.toHaveBeenCalled();
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snap).success).toBe(true);
  });

  it('reads canonical summary only for the selected visible output and keeps it widget-only', async () => {
    const fetchArtifactReview = vi.fn(async () => ({ artifact: artifact(ART), reviewContractSource: 'canonical' as const, reviewContract: { schemaVersion: 'artifact_review_contract.v1', frontDoor: outputFrontDoor() } }));
    const h = host({ fetchArtifactReview });
    await handlePanelSnapshot(h, { view: 'outputs' });
    await handlePanelSnapshot(h, { view: 'outputs', query: ART2 });
    expect(fetchArtifactReview).not.toHaveBeenCalled();
    const result = await handlePanelSnapshot(h, { view: 'outputs', query: ART });
    expect(fetchArtifactReview).toHaveBeenCalledTimes(1);
    expect((result._meta?.[PANEL_PREVIEW_META_KEY] as Record<string, unknown>)[ART]).toMatchObject({ frontDoor: outputFrontDoor() });
    expect(JSON.stringify(result.structuredContent)).not.toContain(outputFrontDoor().answer);
  });

  it.each(['different subject', 'entity fallback', 'read failure'])('keeps existing preview when canonical summary has %s', async (problem) => {
    const fetchArtifactReview = vi.fn(async () => {
      if (problem === 'read failure') throw new Error('unavailable');
      return { artifact: artifact(problem === 'different subject' ? ART2 : ART), reviewContractSource: problem === 'entity fallback' ? 'entity_fallback' as const : 'canonical' as const, reviewContract: { schemaVersion: 'artifact_review_contract.v1', frontDoor: outputFrontDoor() } };
    });
    const result = await handlePanelSnapshot(host({ fetchArtifactReview }), { view: 'outputs', query: ART });
    expect(result._meta?.[PANEL_PREVIEW_META_KEY]).toEqual({ [ART]: { summary: SUMMARY, preview: PREVIEW } });
  });

  it('reads goal progress only for view goals, with move reasons in _meta only', async () => {
    const h = host();
    const result = await handlePanelSnapshot(h, { view: 'goals' });
    expect(h.fetchGoalProgress).toHaveBeenCalledWith({ workspaceId: WS });
    const snap = result.structuredContent as unknown as PanelSnapshot;
    expect(snap.goals!.items[0]!.moves[0]!.has_reason).toBe(true);
    expect(JSON.stringify(result.structuredContent)).not.toContain(REASON);
    expect((result._meta as Record<string, unknown>)[PANEL_GOAL_REASONS_META_KEY]).toEqual({ [GOAL]: [REASON] });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snap).success).toBe(true);
  });

  it('keeps the queue and says why when the goals read fails', async () => {
    const err = Object.assign(new Error('nope'), { status: 404 });
    const result = await handlePanelSnapshot(host({ fetchGoalProgress: vi.fn(async () => { throw err; }) }), { view: 'goals' });
    const snap = result.structuredContent as unknown as PanelSnapshot;
    expect(snap.queue).toHaveLength(1);
    expect(snap.goals).toMatchObject({ status: 'unavailable', reason: 'This OrgX workspace cannot report goal progress yet.' });
  });
});

describe('the decision contract the app sends', () => {
  const contract = (extra: Record<string, unknown>) => ({
    kind: 'decision', actions: ['approve', 'reject'], labels: { approve: 'Send', reject: 'Send back' },
    reject_requires_reason: true, selection: null, items: null, answer: null, questions: null, ...extra,
  });
  const build = (extra: Record<string, unknown>) =>
    buildPanelSnapshot({ workspace: { id: WS, name: 'Acme' }, decisions: [decision(extra)], artifacts: [] });

  it('reads a number range nested under `number`, as the app sends it', () => {
    const s = build({ widget_actions: contract({ questions: { fields: [
      { id: 'seats', type: 'number', label: 'Seats', required: true, number: { min: 1, max: 50, step: 1, unit: 'seats', recommended: 12 } },
    ] } }) });
    expect(s.focus!.widget_actions!.questions!.fields[0]!.number).toEqual({ min: 1, max: 50, step: 1, unit: 'seats', recommended: 12 });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });

  it('carries a text question’s suggestions, and none on other types', () => {
    const s = build({ widget_actions: contract({ questions: { fields: [
      { id: 'lead', type: 'text', label: 'Opening line', suggestions: ['Exports run nightly', 'Exports run nightly', 7, 'Your data, every night'] },
      { id: 'ok', type: 'boolean', label: 'Ship it?', suggestions: ['Yes'] },
    ] } }) });
    const [lead, ok] = s.focus!.widget_actions!.questions!.fields;
    expect(lead!.suggestions).toEqual(['Exports run nightly', 'Your data, every night']);
    expect(ok!.suggestions).toBeUndefined();
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });

  it('names the quality bar only when a send back is possible and the bar is whole', () => {
    const bar = { id: 'qb-post', name: 'Launch post' };
    expect(build({ widget_actions: contract({ quality_bar: bar }) }).focus!.widget_actions!.quality_bar).toEqual(bar);
    expect(build({ widget_actions: contract({ actions: ['approve'], quality_bar: bar }) }).focus!.widget_actions!.quality_bar).toBeUndefined();
    expect(build({ widget_actions: contract({ quality_bar: { id: 'qb-post' } }) }).focus!.widget_actions!.quality_bar).toBeUndefined();
    const s = build({ widget_actions: contract({ quality_bar: bar }) });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });

  it('shows the asker’s own title, and the summary only when it set none', () => {
    expect(build({ title: 'Approve the 4.2 release' }).queue[0]!.title).toBe('Approve the 4.2 release');
    expect(build({}).queue[0]!.title).toBe('Ship release 4.2?');
  });

  it('carries the output’s type with its id, and links the initiative to its own page', () => {
    const s = build({ context: { initiative_id: INIT, artifact_type: 'pull_request' } });
    expect(s.queue[0]).toMatchObject({ artifact_id: ART, artifact_type: 'pull_request' });
    expect(s.focus!.why!.initiative_url).toMatch(new RegExp(`/initiatives/${INIT}$`));
    // No output named, no type: it would label nothing.
    const bare = build({ context: { artifact_type: 'pull_request' }, review_packet: packet({ references: [] }) });
    expect(bare.queue[0]!.artifact_type).toBeUndefined();
  });
});

describe('a goal’s pace', () => {
  const goal = (pace: unknown) => ({
    data: { objectives: [{ id: GOAL, title: '40 paid workspaces', status: 'active', target_value: 40, current_value: 23, baseline_value: 12, pace }] },
  });

  it('carries the pace OrgX computed, and nothing it cannot stand behind', () => {
    expect(buildPanelGoals(goal({ per_week: 1.6, direction: 'up', remaining: 17, weeks_left: 10.6, due_at: '2026-12-31T23:59:59.999Z' })).items[0]!.pace)
      .toEqual({ per_week: 1.6, direction: 'up', remaining: 17, weeks_left: 10.6 });
    for (const bad of [null, { per_week: 0, direction: 'up', remaining: 17, weeks_left: 2 }, { per_week: 1, direction: 'sideways', remaining: 1, weeks_left: 1 }]) {
      expect(buildPanelGoals(goal(bad)).items[0]!.pace).toBeNull();
    }
    const s = buildPanelSnapshot({ workspace: { id: WS, name: 'Acme' }, decisions: [], artifacts: [] });
    s.goals = buildPanelGoals(goal({ per_week: 1.6, direction: 'up', remaining: 17, weeks_left: 10.6 }));
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(s).success).toBe(true);
  });
});
