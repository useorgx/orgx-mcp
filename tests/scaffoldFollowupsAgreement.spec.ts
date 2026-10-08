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
