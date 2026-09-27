import { describe, expect, it, vi } from 'vitest';

import { resolveWriteWorkspace } from '../src/writeWorkspace';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('resolveWriteWorkspace', () => {
  it('prefers an explicit workspace, then the alias, then the session, without inferring', async () => {
    const infer = vi.fn();
    expect(await resolveWriteWorkspace({ args: { workspace_id: ` ${WS} ` }, sessionWorkspaceId: OTHER, infer })).toEqual({ workspaceId: WS, source: 'explicit' });
    expect(await resolveWriteWorkspace({ args: { command_center_id: WS }, sessionWorkspaceId: OTHER, infer })).toEqual({ workspaceId: WS, source: 'explicit' });
    expect(await resolveWriteWorkspace({ args: {}, sessionWorkspaceId: OTHER, infer })).toEqual({ workspaceId: OTHER, source: 'session' });
    expect(infer).not.toHaveBeenCalled();
  });

  it('infers the default workspace for a fresh session that never bootstrapped', async () => {
    const infer = vi.fn(async () => ({ id: WS, name: 'Acme' }));
    expect(await resolveWriteWorkspace({ args: {}, sessionWorkspaceId: null, infer })).toEqual({ workspaceId: WS, source: 'inferred', name: 'Acme' });
  });

  it('returns none when no workspace can be chosen unambiguously', async () => {
    expect(await resolveWriteWorkspace({ args: { workspace_id: '  ' }, sessionWorkspaceId: undefined, infer: async () => null })).toEqual({ workspaceId: null, source: 'none' });
  });
});
