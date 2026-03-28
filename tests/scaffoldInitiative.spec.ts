import { describe, expect, it } from 'vitest';

import {
  buildScaffoldHierarchy,
  buildScaffoldInitiativeBatch,
} from '../src/scaffoldInitiative';

describe('buildScaffoldInitiativeBatch', () => {
  it('strips reserved _context while preserving entity context', () => {
    const result = buildScaffoldInitiativeBatch({
      title: 'Launch OrgX MCP',
      summary: 'Record the demo flow',
      workspace_id: 'ws-123',
      context: [
        {
          type: 'url',
          url: 'https://useorgx.com/blog/orgx-mcp-launch',
          note: 'Launch post',
        },
      ],
      _context: {
        client: {
          name: 'claude',
          version: '1.0.0',
        },
        conversation: {
          id: 'conv-123',
        },
      },
      workstreams: [
        {
          title: 'Engineering',
          milestones: [
            {
              title: 'Worker ready',
              tasks: [{ title: 'Ship worker' }],
            },
          ],
        },
      ],
    });

    expect(result.batch).toHaveLength(4);

    const initiative = result.batch[0];
    expect(initiative).toMatchObject({
      type: 'initiative',
      title: 'Launch OrgX MCP',
      summary: 'Record the demo flow',
      workspace_id: 'ws-123',
      context: [
        {
          type: 'url',
          url: 'https://useorgx.com/blog/orgx-mcp-launch',
          note: 'Launch post',
        },
      ],
    });
    expect(initiative).not.toHaveProperty('_context');
  });
});

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
