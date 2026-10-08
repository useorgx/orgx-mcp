import { describe, expect, it } from 'vitest';

import {
  describeExpectationSet,
  expectationSetOfDecision,
  expectationSummaryText,
  findExpectationSet,
  heldLaunchFromError,
  heldLaunchOf,
  normalizeExpectationSet,
  normalizeSuggestedChecks,
  scaffoldExpectationSet,
  suggestedExpectationSet,
} from '../src/expectations';
import { OrgXApiError } from '../src/orgxApi';
import { buildScaffoldInitiativeBatch } from '../src/scaffoldInitiative';
import { buildCompactScaffoldResult, buildScaffoldDraftResult } from '../src/scaffoldResponse';
import { OPENAI_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas';

const DECISION_ID = '5b1c9e2a-4f3d-4a8b-9e61-2c7d0a9f4b13';

// The shape the "Agree on done" app PR documents for scaffold `expectations`.
const APP_SET = {
  id: 'set-1',
  status: 'drafted',
  version: 3,
  decision_id: DECISION_ID,
  checks: [
    { scope: 'workstream', scope_id: 'ws-1', statement: 'Every PR is reviewed by a person', verify: 'manual', source: 'rule', source_ref: 'policy:pr_review', owner_agent: 'engineering-agent' },
    { scope: 'task', scope_id: 'task-1-1-1', statement: 'The checkout e2e suite passes', verify: { kind: 'command', command: 'pnpm e2e' }, required: true, source: 'artifact_type', source_ref: 'layer:pr', owner_agent: 'engineering-agent' },
    { scope: 'workstream', scope_id: 'ws-2', statement: 'Ends with one clear call to action', verify: 'manual', source: 'learned', source_ref: 'ledger-decision-9', source_label: 'your call on the launch post', owner_agent: 'marketing-agent', new_since_last: true },
    { scope: 'initiative', statement: 'Lighthouse performance is 90 or higher', verify: 'http', source: 'suggested' },
    { scope: 'task', scope_id: 'task-2-1-1', statement: 'No claim without a source', source: 'drafted', owner_agent: 'marketing-agent' },
  ],
};

describe('expectation sets (Agree on done)', () => {
  it('reads the app set with its sources, verify kinds and owners', () => {
    const set = normalizeExpectationSet(APP_SET)!;
    expect(set).toMatchObject({ id: 'set-1', status: 'drafted', version: '3', decision_id: DECISION_ID, origin: 'app', omitted_count: 0 });
    expect(set.checks.map((c) => [c.source, c.verify, c.required])).toEqual([
      ['rule', 'manual', true],
      ['artifact_type', 'command', true],
      ['learned', 'manual', false],
      ['suggested', 'http', false],
      ['drafted', 'manual', false],
    ]);
    expect(set.checks[2]).toMatchObject({ source_label: 'your call on the launch post', new_since_last: true, source_ref: 'ledger-decision-9' });
    expect(describeExpectationSet(set)).toBe(
      '5 checks across 2 owners: 1 from your rules, 1 from the kind of work, 1 learned from your past calls, 1 suggested in chat, 1 drafted to fill a gap, 1 new since last time.'
    );
  });

  it('accepts the aliases the app uses and drops what it cannot place', () => {
    const set = normalizeExpectationSet({
      status: 'approved',
      checks: [
        { text: 'From policy', source: 'policy' },
        { check: 'From a promoted criterion', source: 'promoted' },
        { statement: 'No source, so not shown' },
        { statement: 'Disabled', source: 'rule', enabled: false },
        'a bare string has no source',
      ],
    })!;
    expect(set.status).toBe('agreed');
    expect(set.checks.map((c) => [c.statement, c.source])).toEqual([
      ['From policy', 'rule'],
      ['From a promoted criterion', 'learned'],
    ]);
    expect(normalizeExpectationSet({ checks: [{ statement: 'x' }] })).toBeNull();
    expect(normalizeExpectationSet(null)).toBeNull();
  });

  it('finds the set one level down, as an array, or under data', () => {
    expect(findExpectationSet({ data: { expectations: APP_SET } })?.id).toBe('set-1');
    expect(findExpectationSet({ expectations: APP_SET.checks })?.checks).toHaveLength(5);
    expect(findExpectationSet({ nothing: true })).toBeNull();
  });

  it('caps a huge set and says how many it left out', () => {
    const checks = Array.from({ length: 130 }, (_, i) => ({ statement: `Check ${i}`, source: 'drafted' }));
    const set = normalizeExpectationSet({ checks })!;
    expect(set.checks).toHaveLength(120);
    expect(set.omitted_count).toBe(10);
  });
});

describe('suggested_checks on scaffold', () => {
  const args = {
    title: 'Launch the pricing page',
    workstreams: [
      {
        title: 'Build',
        ownerAgent: 'engineering-agent',
        suggested_checks: ['Lighthouse is 90 or higher', { statement: 'Old URLs redirect', verify: 'http', required: true }, 'Lighthouse is 90 or higher'],
        milestones: [
          { title: 'Page', suggested_checks: ['ignored on a milestone'], tasks: [{ title: 'Ship it', suggestedChecks: ['Checkout e2e passes'] }] },
        ],
      },
    ],
  };

  it('moves them onto workstream and task metadata, never as a column', () => {
    const { batch, warnings } = buildScaffoldInitiativeBatch(args as Record<string, unknown>);
    const ws = batch.find((e) => e.type === 'workstream')!;
    const ms = batch.find((e) => e.type === 'milestone')!;
    const task = batch.find((e) => e.type === 'task')!;
    expect(ws).not.toHaveProperty('suggested_checks');
    expect(ms).not.toHaveProperty('suggested_checks');
    expect(task).not.toHaveProperty('suggestedChecks');
    expect((ws.metadata as Record<string, unknown>).suggested_checks).toEqual([
      { statement: 'Lighthouse is 90 or higher', verify: 'manual', required: false },
      { statement: 'Old URLs redirect', verify: 'http', required: true },
    ]);
    expect((task.metadata as Record<string, unknown>).suggested_checks).toEqual([
      { statement: 'Checkout e2e passes', verify: 'manual', required: false },
    ]);
    expect(warnings.map((w) => w.code)).toContain('suggested_checks_on_milestone_ignored');
  });

  it('shows them as a suggested-only bar in draft mode, never as agreed', () => {
    const { batch } = buildScaffoldInitiativeBatch(args as Record<string, unknown>);
    const draft = buildScaffoldDraftResult({ batch, expectations: suggestedExpectationSet(batch) });
    expect(draft.expectations).toMatchObject({ status: 'drafted', origin: 'suggested', decision_id: null });
    expect(draft.expectations!.checks.map((c) => [c.scope, c.scope_id, c.source, c.owner_agent])).toEqual([
      ['workstream', 'ws-1', 'suggested', 'engineering-agent'],
      ['workstream', 'ws-1', 'suggested', 'engineering-agent'],
      ['task', 'task-1-1-1', 'suggested', 'engineering-agent'],
    ]);
    expect(OPENAI_OUTPUT_SCHEMAS.scaffold_initiative.safeParse(draft).success).toBe(true);
    expect(expectationSummaryText(draft.expectations!)).toContain('These are suggestions');
  });

  it('caps and dedupes what one node may suggest', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Check ${i}`);
    expect(normalizeSuggestedChecks(many)).toHaveLength(20);
    expect(normalizeSuggestedChecks(['A', 'a', ' A '])).toHaveLength(1);
    expect(normalizeSuggestedChecks(undefined)).toEqual([]);
  });
});

describe('the scaffold result carries the bar', () => {
  const batch = buildScaffoldInitiativeBatch({
    title: 'T',
    workstreams: [{ title: 'W', suggested_checks: ['From chat'], milestones: [{ title: 'M', tasks: [{ title: 'K' }] }] }],
  }).batch;

  it("prefers OrgX's own set (from the launch answer) over the caller's suggestions", () => {
    const set = scaffoldExpectationSet({ followupExpectations: normalizeExpectationSet(APP_SET), batch });
    expect(set).toMatchObject({ origin: 'app', id: 'set-1' });
  });

  it('reads a set the created initiative carries', () => {
    const set = scaffoldExpectationSet({
      results: [{ success: true, data: { type: 'initiative', id: 'i-1', expectations: APP_SET } }],
      batch,
    });
    expect(set?.id).toBe('set-1');
  });

  it('maps suggested scope refs to created ids and names the decision a held launch waits on', () => {
    const set = scaffoldExpectationSet({
      batch,
      refMap: { 'ws-1': '11111111-1111-4111-8111-111111111111' },
      launch: { held_for_agreement: true, decision_id: DECISION_ID },
    })!;
    expect(set.checks[0]!.scope_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(set.decision_id).toBe(DECISION_ID);
    expect(expectationSummaryText(set, { held_for_agreement: true })).toContain('Waiting for you to agree in Needs you');
  });

  it('validates against the scaffold output schema and lists expectations as a stable key', () => {
    const payload = buildCompactScaffoldResult({
      result: { total: 1, created_count: 1, failed_count: 0, created: [], failed: [], results: [], ref_map: {}, summary: 'ok' } as never,
      hierarchy: { initiative: { id: 'i-1', title: 'T' }, workstreams: [] },
      expectations: normalizeExpectationSet(APP_SET),
    });
    expect(payload.expectations?.checks).toHaveLength(5);
    expect(payload.result_contract.stable_keys).toContain('expectations');
    expect(OPENAI_OUTPUT_SCHEMAS.scaffold_initiative.safeParse(payload).success).toBe(true);
  });

  it('says each state in the text hosts read', () => {
    const drafted = normalizeExpectationSet({ ...APP_SET, decision_id: null })!;
    expect(expectationSummaryText(drafted)).toContain('OrgX asks you to agree on it before work starts');
    expect(expectationSummaryText({ ...drafted, decision_id: DECISION_ID })).toContain('Waiting for you to agree in Needs you');
    expect(expectationSummaryText({ ...drafted, status: 'agreed' })).toContain('Agreed; every receipt is judged against it');
    expect(expectationSummaryText({ ...drafted, status: 'sent_back' })).toContain('Sent back; OrgX is redrafting it');
    expect(expectationSummaryText(null)).toBe('');
  });
});

describe('a launch held for agreement', () => {
  it('reads the 409 body the sign-off gate answers with', () => {
    const held = heldLaunchOf({ error: { code: 'expectation_agreement_required', decision_id: DECISION_ID }, expectations: APP_SET });
    expect(held?.decision_id).toBe(DECISION_ID);
    expect(held?.expectations?.checks).toHaveLength(5);
    expect(heldLaunchOf({ decision: { id: DECISION_ID, kind: 'expectation_agreement' } })?.decision_id).toBe(DECISION_ID);
    expect(heldLaunchOf({ error: { code: 'spawn_guard_blocked' } })).toBeNull();
  });

  it('lifts it from an API error, including a body clipped mid-set', () => {
    const body = JSON.stringify({ code: 'expectation_agreement_required', decision_id: DECISION_ID, expectations: APP_SET });
    const whole = new OrgXApiError('Agree first', `API 409 from https://x/launch: ${body}`, 409);
    expect(heldLaunchFromError(whole)).toMatchObject({ decision_id: DECISION_ID });
    const clipped = new OrgXApiError('Agree first', `API 409 from https://x/launch: ${body.slice(0, 120)}`, 409);
    expect(heldLaunchFromError(clipped)).toEqual({ decision_id: DECISION_ID, expectations: null });
    expect(heldLaunchFromError(new OrgXApiError('Nope', 'API 500 from https://x: {"error":"down"}', 500))).toBeNull();
    expect(heldLaunchFromError(new Error('stream activation failed'))).toBeNull();
  });
});

describe('expectation_agreement decisions', () => {
  it('carry their set wherever the app puts it, keyed to the decision', () => {
    const fromContext = expectationSetOfDecision({ id: DECISION_ID, decision_kind: 'expectation_agreement', context: { expectations: { ...APP_SET, decision_id: undefined } } });
    expect(fromContext?.decision_id).toBe(DECISION_ID);
    expect(expectationSetOfDecision({ id: DECISION_ID, type: 'expectation_agreement', metadata: { expectations: APP_SET } })?.checks).toHaveLength(5);
    // Only the agreement decision kind carries a bar.
    expect(expectationSetOfDecision({ id: DECISION_ID, type: 'decision_queue', expectations: APP_SET })).toBeNull();
  });
});
