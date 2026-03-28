import { describe, expect, it } from 'vitest';

import { buildScaffoldHierarchy } from '../src/scaffoldInitiative';

describe('buildScaffoldHierarchy', () => {
  it('aliases workstream names into title for widget consumers', () => {
    const hierarchy = buildScaffoldHierarchy({
      result: {
        summary: '3/3 created',
        total: 3,
        created_count: 3,
        failed_count: 0,
        created: [],
        failed: [],
        ref_map: {},
        results: [
          {
            index: 0,
            success: true,
            type: 'initiative',
            ref: 'initiative',
            id: 'init-1',
            data: { id: 'init-1', title: 'Test Initiative', status: 'draft' },
          },
          {
            index: 1,
            success: true,
            type: 'workstream',
            ref: 'ws-1',
            id: 'ws-1-id',
            data: { id: 'ws-1-id', name: 'Platform Lane', status: 'active' },
          },
          {
            index: 2,
            success: true,
            type: 'milestone',
            ref: 'ms-1',
            id: 'ms-1-id',
            data: { id: 'ms-1-id', title: 'Ship MVP', status: 'planned' },
          },
        ],
      },
      initiativeRef: 'initiative',
      wsRefs: ['ws-1'],
      msRefs: [['ms-1']],
      taskRefs: [[[]]],
    });

    expect(hierarchy.initiative.title).toBe('Test Initiative');
    expect(hierarchy.workstreams[0]).toMatchObject({
      id: 'ws-1-id',
      name: 'Platform Lane',
      title: 'Platform Lane',
    });
  });
});
