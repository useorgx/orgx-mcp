import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callOrgxApiJson } = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
vi.mock('../src/orgxApi', () => ({ callOrgxApiJson }));

import { executeWorkLease } from '../src/workLeases';

const call = {
  env: {} as never,
  userId: 'user-1',
  userEmail: 'u@example.com',
  orgxUserId: null,
  holder: 'claude-code:session-1',
};
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('orgx_lease', () => {
  beforeEach(() => callOrgxApiJson.mockReset());

  it('claims paths as this session and reports the lease', async () => {
    callOrgxApiJson.mockResolvedValue(
      json({ ok: true, data: { granted: true, extended: false, lease: { id: 'a1b2c3d4-0000-4000-8000-000000000000', holder: 'claude-code:session-1', paths: ['orgx/lib/a.ts'], expires_at: '2026-09-25T09:00:00.000Z' } } })
    );
    const result = await executeWorkLease({ action: 'claim', repo: 'hopeatina/orgx', paths: ['orgx/lib/a.ts'] }, call);
    expect(result).toMatchObject({ ok: true, text: 'Claimed orgx/lib/a.ts until 09:00 UTC (lease a1b2c3d4).' });
    const [, path, init] = callOrgxApiJson.mock.calls[0];
    expect(path).toBe('/api/v1/leases');
    expect(JSON.parse(String(init.body))).toEqual({ repo: 'hopeatina/orgx', paths: ['orgx/lib/a.ts'], holder: 'claude-code:session-1' });
  });

  it('says who holds the paths when a claim is refused', async () => {
    callOrgxApiJson.mockResolvedValue(
      json({ ok: true, data: { granted: false, conflicts: [{ id: 'x', holder: 'codex:thread-9', paths: ['orgx/lib/**'], overlapping_paths: ['orgx/lib/a.ts'], expires_at: '2026-09-25T08:40:00.000Z', reason: 'trust bridge' }] } })
    );
    const result = await executeWorkLease({ action: 'claim', repo: 'hopeatina/orgx', paths: ['orgx/lib/a.ts'] }, call);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('codex:thread-9 holds orgx/lib/a.ts until 08:40 UTC (trust bridge)');
  });

  it('lists and releases, and rejects incomplete input without calling OrgX', async () => {
    callOrgxApiJson.mockResolvedValueOnce(json({ ok: true, data: { leases: [] } }));
    expect((await executeWorkLease({ action: 'list', repo: 'hopeatina/orgx' }, call)).text).toBe('No live leases on hopeatina/orgx.');
    expect(callOrgxApiJson.mock.calls[0][1]).toBe('/api/v1/leases?repo=hopeatina%2Forgx');

    callOrgxApiJson.mockResolvedValueOnce(json({ ok: true }));
    const id = '11111111-2222-4333-8444-555555555555';
    expect((await executeWorkLease({ action: 'release', lease_id: id }, call)).ok).toBe(true);
    expect(callOrgxApiJson.mock.calls[1][1]).toBe(`/api/v1/leases/${id}`);

    callOrgxApiJson.mockClear();
    expect((await executeWorkLease({ action: 'claim', repo: 'hopeatina/orgx' }, call)).ok).toBe(false);
    expect((await executeWorkLease({ action: 'release' }, call)).ok).toBe(false);
    expect(callOrgxApiJson).not.toHaveBeenCalled();
  });
});
