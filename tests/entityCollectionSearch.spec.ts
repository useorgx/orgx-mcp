import { describe, expect, it } from 'vitest';

import { buildEntityCollectionSearchParams } from '../src/entityCollectionSearch';

describe('entity collection search contract', () => {
  it('translates the MCP-facing query field to the core API search parameter', () => {
    const params = buildEntityCollectionSearchParams({
      type: 'initiative',
      query: 'Floodgate',
      workspaceId: 'workspace-1',
      limit: 25,
    });

    expect(params.get('search')).toBe('Floodgate');
    expect(params.has('query')).toBe(false);
    expect(params.get('workspace_id')).toBe('workspace-1');
    expect(params.get('limit')).toBe('25');
  });
});
