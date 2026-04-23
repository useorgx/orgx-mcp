import { describe, expect, it } from 'vitest';

import {
  isInitiativeScopedChildListQuery,
  resolveListEntitiesWorkspaceScope,
} from '../src/listEntitiesWorkspaceScope';

describe('listEntities workspace scoping', () => {
  it('treats initiative-scoped child stream queries as initiative-bound', () => {
    expect(
      isInitiativeScopedChildListQuery(
        'stream',
        '66cf267d-0163-48d5-9444-6dba101d86d2'
      )
    ).toBe(true);
  });

  it('does not auto-apply session workspace scope to initiative-scoped child queries', () => {
    expect(
      resolveListEntitiesWorkspaceScope({
        type: 'stream',
        initiativeId: '66cf267d-0163-48d5-9444-6dba101d86d2',
        sessionWorkspaceId: 'dfc0a646-6f63-4b77-9a29-09c1040c8623',
      })
    ).toBeNull();
  });

  it('keeps explicit workspace scope when the caller passes one', () => {
    expect(
      resolveListEntitiesWorkspaceScope({
        type: 'stream',
        initiativeId: '66cf267d-0163-48d5-9444-6dba101d86d2',
        explicitWorkspaceId: '00000000-0000-0000-0000-000000000123',
        sessionWorkspaceId: 'dfc0a646-6f63-4b77-9a29-09c1040c8623',
      })
    ).toBe('00000000-0000-0000-0000-000000000123');
  });

  it('does not auto-apply session workspace scope to exact id lookups', () => {
    expect(
      resolveListEntitiesWorkspaceScope({
        type: 'initiative',
        id: '21dcfaa6-12c8-4d02-8ca3-8de4c5b57ee5',
        sessionWorkspaceId: 'dfc0a646-6f63-4b77-9a29-09c1040c8623',
      })
    ).toBeNull();
  });

  it('still auto-applies session workspace scope to non-initiative list queries', () => {
    expect(
      resolveListEntitiesWorkspaceScope({
        type: 'initiative',
        sessionWorkspaceId: 'dfc0a646-6f63-4b77-9a29-09c1040c8623',
      })
    ).toBe('dfc0a646-6f63-4b77-9a29-09c1040c8623');
  });
});
