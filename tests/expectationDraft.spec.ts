import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/orgxApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orgxApi')>();
  return { ...actual, callOrgxApiJson: vi.fn() };
});

import { callOrgxApiJson } from '../src/orgxApi';
import { draftPlanExpectations, expectationDraftBody } from '../src/scaffoldFollowups';
import { expectationSetOfDecision, heldLaunchOf } from '../src/expectations';

const BATCH = [
  { type: 'initiative', ref: 'init', title: 'Launch the pricing page', metadata: { suggested_checks: [{ statement: 'Pricing matches the billing catalog' }] } },
  { type: 'workstream', ref: 'ws-1', initiative_ref: 'init', name: 'Build the page', assigned_agent_ids: ['engineering-agent'], metadata: {} },
  { type: 'milestone', ref: 'ms-1', initiative_ref: 'init', workstream_ref: 'ws-1', title: 'Backlog' },
  {
    type: 'task', ref: 'task-1', initiative_ref: 'init', workstream_ref: 'ws-1', milestone_ref: 'ms-1', title: 'Ship the page', description: 'Build it',
    assigned_agent_ids: ['engineering-agent'],
    metadata: { expected_artifacts: [{ type: 'eng.pull_request' }], acceptance_criteria: ['Checkout e2e passes'], suggested_checks: [{ statement: 'Lighthouse ≥ 90', verify: { kind: 'http', url: 'https://x.test' } }] },
  },
];

describe('expectationDraftBody', () => {
  it('sends the plan by ref with owners, artifacts, criteria and suggestions; milestones carry nothing', () => {
    const body = expectationDraftBody(BATCH, 'ws-uuid');
    expect(body).toMatchObject({
      workspace_id: 'ws-uuid',
      draft: false,
      initiative: { title: 'Launch the pricing page', suggested_checks: [{ statement: 'Pricing matches the billing catalog' }] },
      workstreams: [{ ref: 'ws-1', name: 'Build the page', owner_agent: 'engineering-agent' }],
      tasks: [{
        ref: 'task-1', workstream_ref: 'ws-1', title: 'Ship the page', description: 'Build it', owner_agent: 'engineering-agent',
        expected_artifacts: [{ type: 'eng.pull_request' }], acceptance_criteria: ['Checkout e2e passes'],
      }],
    });
    expect(JSON.stringify(body)).not.toContain('ms-1');
  });
});

describe('draftPlanExpectations', () => {
  beforeEach(() => vi.mocked(callOrgxApiJson).mockReset());

  it("returns OrgX's own bar for the plan", async () => {
    vi.mocked(callOrgxApiJson).mockResolvedValue(new Response(JSON.stringify({
      expectations: { set_id: null, status: 'drafted', checks: [{ id: 'exp_1', statement: 'Produces a PR for the page', source: 'artifact_type', verify: { kind: 'artifact' }, enabled: true }] },
    })));
    const set = await draftPlanExpectations({ env: {} as never, workspaceId: 'ws-uuid', batch: BATCH, actorUserId: 'u-1', userEmail: null });
    expect(set).toMatchObject({ origin: 'app', status: 'drafted' });
    expect(vi.mocked(callOrgxApiJson).mock.calls[0]![1]).toBe('/api/expectations/draft');
  });

  it('asks nothing without a workspace', async () => {
    expect(await draftPlanExpectations({ env: {} as never, workspaceId: null, batch: BATCH, actorUserId: null, userEmail: null })).toBeNull();
    expect(callOrgxApiJson).not.toHaveBeenCalled();
  });

});

describe("the app's agreement shapes", () => {
  it("reads the launch gate's blocked_reason as a hold", () => {
    expect(heldLaunchOf({ error: 'Agree first', blocked_reason: 'expectation_agreement', decision_id: 'd-1' })).toEqual({ decision_id: 'd-1', expectations: null });
    expect(heldLaunchOf({ error: 'nope', blocked_reason: 'blueprint_not_approved' })).toBeNull();
  });

  it('reads the bar off a get_pending_decisions agreement item', () => {
    const item = {
      id: 'd-1', type: 'decision_queue', summary: '2 checks across 2 owners…',
      kind: 'expectation_agreement',
      expectations: {
        kind: 'expectation_agreement', set_id: 'set-1', version: 2, status: 'drafted',
        groups: [],
        checks: [
          { id: 'exp_rule', statement: 'No outbound email is sent without approval', scope: 'initiative', verify: 'manual', required: true, source: 'rule', enabled: true },
          { id: 'exp_off', statement: 'Offered, off by default', scope: 'task', verify: 'manual', required: false, source: 'artifact_type', enabled: false },
        ],
      },
    };
    const set = expectationSetOfDecision(item);
    expect(set).toMatchObject({ id: 'set-1', version: '2', decision_id: 'd-1', status: 'drafted' });
    expect(set?.checks.map((c) => c.id)).toEqual(['exp_rule']);
  });
});
