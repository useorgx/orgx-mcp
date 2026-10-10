import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/orgxApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orgxApi')>();
  return { ...actual, callOrgxApiJson: vi.fn() };
});

import { callOrgxApiJson, OrgXApiError } from '../src/orgxApi';
import { runScaffoldPostCreateFollowups } from '../src/scaffoldFollowups';

const INITIATIVE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const DECISION = '5b1c9e2a-4f3d-4a8b-9e61-2c7d0a9f4b13';
const SET = { status: 'drafted', decision_id: DECISION, checks: [{ statement: 'Every PR is reviewed by a person', source: 'rule' }] };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function apiWith(launch: () => Response) {
  vi.mocked(callOrgxApiJson).mockImplementation(async (...a: unknown[]) => {
    const path = String(a[1]);
    if (path.includes('/assign-agents')) return json({ ok: true, data: { assignments: [] } });
    if (path.includes('/billing/scaffolds/consume')) return json({ ok: true });
    if (path.includes('/credentials/status')) return json({ ok: true, data: { can_execute: true, has_credentials: true } });
    if (path.includes('/launch')) return launch();
    if (path.startsWith('/api/entities?')) return json({ data: [] });
    return json({ ok: true });
  });
}
const run = () => runScaffoldPostCreateFollowups({
  env: {} as never,
  createdInitiativeId: INITIATIVE,
  launchAfterCreate: true,
  actorUserId: 'user-1',
  hierarchy: { workstreams: [] },
  resolveUserEmail: () => null,
});

describe('scaffold launch held for agreement', () => {
  beforeEach(() => vi.mocked(callOrgxApiJson).mockReset());

  it('a 409 from the sign-off gate is a hold, not a failure, and names the decision', async () => {
    const body = JSON.stringify({ error: { code: 'expectation_agreement_required', message: 'Agree first' }, decision_id: DECISION, expectations: SET });
    apiWith(() => { throw new OrgXApiError('Agree first', `API 409 from https://x/launch: ${body}`, 409); });
    const out = await run();
    expect(out.launch).toMatchObject({ attempted: true, ok: false, held_for_agreement: true, decision_id: DECISION, error_kind: 'expectation_agreement_pending' });
    expect(out.launch).not.toHaveProperty('error');
    expect(out.expectations?.checks).toHaveLength(1);
    // A held launch never falls back to dispatching an agent on its own.
    expect(out.fallback_agent_dispatch).toBeUndefined();
  });

  it('a launch that answers with an agreed bar carries it, and approval material stays out of the payload', async () => {
    apiWith(() => json({ message: 'Initiative launched', expectations: { ...SET, status: 'agreed' }, _widget_meta: { approval_tokens: { [DECISION]: 't' } } }));
    const out = await run();
    expect(out.launch).toMatchObject({ ok: true, message: 'Initiative launched' });
    expect(out.expectations?.status).toBe('agreed');
    expect(out.widget_meta).toEqual({ approval_tokens: { [DECISION]: 't' } });
  });

  it('any other launch failure stays a failure', async () => {
    apiWith(() => { throw new OrgXApiError('down', 'API 500 from https://x/launch: {"error":"down"}', 500); });
    const out = await run();
    expect(out.launch).toMatchObject({ attempted: true, ok: false, error_kind: 'launch_failed' });
    expect(out.launch?.held_for_agreement).toBeUndefined();
  });
});

// The app's own shapes, as it sends them (orgx lib/server/expectations/agreement.ts).
const APP_SET = {
  expectations: {
    set_id: 'set-1',
    initiative_id: INITIATIVE,
    status: 'drafted',
    version: 1,
    decision_id: null,
    summary: '2 checks across 2 owners: 1 from your rules, 1 from the kind of work. Agents start when you agree.',
    checks: [
      { id: 'exp_rule', scope: 'initiative', scope_id: INITIATIVE, statement: 'No outbound email is sent without approval', verify: { kind: 'manual', reviewer: 'u-1' }, required: true, source: 'rule', source_ref: 'policy:no_email', owner_agent: null, enabled: true },
      { id: 'exp_pr', scope: 'task', scope_id: 't-1', statement: 'Produces an artifact of type eng.pull_request for “Ship the page”', verify: { kind: 'artifact', artifact_type: 'eng.pull_request' }, required: true, source: 'artifact_type', source_ref: 'artifact_type:eng.pull_request', owner_agent: 'engineering-agent', enabled: true },
      { id: 'exp_off', scope: 'task', scope_id: 't-1', statement: 'Correctness & risk: are the failure modes named?', verify: { kind: 'manual', reviewer: 'u-1' }, required: false, source: 'artifact_type', source_ref: 'layer_stack:eng/correctness_risk', owner_agent: 'engineering-agent', enabled: false },
    ],
  },
};

describe('scaffold drafts the bar before launch', () => {
  beforeEach(() => vi.mocked(callOrgxApiJson).mockReset());

  function appWith(launch: () => Response) {
    const paths: string[] = [];
    vi.mocked(callOrgxApiJson).mockImplementation(async (...a: unknown[]) => {
      const path = String(a[1]);
      paths.push(path);
      if (path === `/api/initiatives/${INITIATIVE}/expectations`) return json(APP_SET);
      if (path.includes('/assign-agents')) return json({ ok: true, data: { assignments: [] } });
      if (path.includes('/credentials/status')) return json({ ok: true, data: { can_execute: true, has_credentials: true } });
      if (path.includes('/launch')) return launch();
      if (path.startsWith('/api/entities?')) return json({ data: [] });
      return json({ ok: true });
    });
    return paths;
  }

  it('drafts the persisted bar first, so the launch gate has something to hold', async () => {
    const paths = appWith(() => json({ message: 'Initiative launched' }));
    await run();
    const draft = paths.indexOf(`/api/initiatives/${INITIATIVE}/expectations`);
    expect(draft).toBeGreaterThanOrEqual(0);
    expect(draft).toBeLessThan(paths.findIndex((p) => p.includes('/launch')));
  });

  it("the app's real 409 (blocked_reason, no set in the body) holds launch and shows the drafted bar with its decision", async () => {
    const body = JSON.stringify({
      error: 'Agree on what done means for “Ship it” before work starts. It is waiting for you in Needs you.',
      blocked_reason: 'expectation_agreement',
      expectation_set_id: 'set-1',
      decision_id: DECISION,
      current_status: 'draft',
    });
    appWith(() => { throw new OrgXApiError('Conflict', `API 409 from https://x/launch: ${body}`, 409); });
    const out = await run();
    expect(out.launch).toMatchObject({ held_for_agreement: true, decision_id: DECISION });
    expect(out.expectations).toMatchObject({ id: 'set-1', status: 'drafted', decision_id: DECISION, origin: 'app' });
    // Offered-but-off checks are not part of the bar shown.
    expect(out.expectations?.checks.map((c) => c.id)).toEqual(['exp_rule', 'exp_pr']);
    expect(out.expectations?.checks.map((c) => c.source)).toEqual(['rule', 'artifact_type']);
  });

  it('a launch that goes through shows the drafted bar as agreed', async () => {
    appWith(() => json({ message: 'Initiative launched' }));
    expect((await run()).expectations).toMatchObject({ id: 'set-1', status: 'agreed' });
  });

  it('an app that cannot draft a bar leaves the scaffold as it was', async () => {
    vi.mocked(callOrgxApiJson).mockImplementation(async (...a: unknown[]) => {
      const path = String(a[1]);
      if (path.endsWith('/expectations')) throw new OrgXApiError('Not found', 'API 404', 404);
      if (path.includes('/credentials/status')) return json({ ok: true, data: { can_execute: true, has_credentials: true } });
      if (path.includes('/launch')) return json({ message: 'Initiative launched' });
      return json({ ok: true, data: [] });
    });
    const out = await run();
    expect(out.launch).toMatchObject({ ok: true });
    expect(out.expectations ?? null).toBeNull();
  });
});
