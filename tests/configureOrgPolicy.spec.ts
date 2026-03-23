import { describe, expect, it } from 'vitest';

import {
  describeAppliedPolicy,
  resolveConfigureOrgWorkspaceId,
} from '../src/configureOrgPolicy';

describe('configureOrgPolicy helpers', () => {
  it('uses the explicit workspace id when present', () => {
    expect(
      resolveConfigureOrgWorkspaceId(
        { workspace_id: 'ws-1' },
        'session-ws'
      )
    ).toEqual({
      workspaceId: 'ws-1',
      error: null,
    });
  });

  it('rejects mismatched workspace aliases', () => {
    expect(
      resolveConfigureOrgWorkspaceId({
        workspace_id: 'ws-1',
        command_center_id: 'ws-2',
      })
    ).toEqual({
      workspaceId: null,
      error: 'workspace_id and command_center_id must match when both are provided',
    });
  });

  it('describes artifact collection mode in success text', () => {
    expect(
      describeAppliedPolicy(
        'artifact_collection',
        { mode: 'minimal' },
        'ws-1'
      )
    ).toBe('✓ Applied artifact collection policy for workspace ws-1 (minimal mode)');
  });
});
