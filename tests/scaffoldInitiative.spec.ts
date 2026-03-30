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

  it('maps primaryAgent shorthand onto assigned agents without leaking invalid fields', () => {
    const result = buildScaffoldInitiativeBatch({
      title: 'Series A Pitch Preparation',
      workstreams: [
        {
          title: 'Investor Deck',
          domain: 'design',
          primaryAgent: 'design',
          milestones: [
            {
              title: 'Deck Structure Finalized',
              primaryAgent: 'design',
              tasks: [
                {
                  title: 'Draft narrative arc and slide outline',
                  primaryAgent: 'design',
                },
              ],
            },
          ],
        },
      ],
    });

    const workstream = result.batch.find((entity) => entity.type === 'workstream');
    const milestone = result.batch.find((entity) => entity.type === 'milestone');
    const task = result.batch.find((entity) => entity.type === 'task');

    expect(workstream).toMatchObject({
      assigned_agent_ids: ['design-agent'],
      assigned_agent_names: ['Design'],
    });
    expect(workstream).not.toHaveProperty('primaryAgent');
    expect(workstream).not.toHaveProperty('ownerAgent');

    expect(milestone).toMatchObject({
      assigned_agent_ids: ['design-agent'],
      assigned_agent_names: ['Design'],
    });
    expect(milestone).not.toHaveProperty('primaryAgent');
    expect(milestone).not.toHaveProperty('ownerAgent');

    expect(task).toMatchObject({
      assigned_agent_ids: ['design-agent'],
      assigned_agent_names: ['Design'],
    });
    expect(task).not.toHaveProperty('primaryAgent');
    expect(task).not.toHaveProperty('ownerAgent');
  });
});

describe('buildScaffoldHierarchy', () => {
  it('aliases scaffold hierarchy labels across workstreams, milestones, and tasks', () => {
    const hierarchy = buildScaffoldHierarchy({
      result: {
        summary: '5/5 created',
        total: 5,
        created_count: 5,
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
            data: { id: 'ms-1-id', name: 'Ship MVP', status: 'planned' },
          },
          {
            index: 3,
            success: true,
            type: 'task',
            ref: 'task-1',
            id: 'task-1-id',
            data: { id: 'task-1-id', title: 'Draft narrative', status: 'todo' },
          },
          {
            index: 4,
            success: true,
            type: 'task',
            ref: 'task-2',
            id: 'task-2-id',
            data: { id: 'task-2-id', name: 'Review metrics', status: 'todo' },
          },
        ],
      },
      initiativeRef: 'initiative',
      wsRefs: ['ws-1'],
      msRefs: [['ms-1']],
      taskRefs: [[['task-1', 'task-2']]],
    });

    expect(hierarchy.initiative.title).toBe('Test Initiative');
    expect(hierarchy.workstreams[0]).toMatchObject({
      id: 'ws-1-id',
      name: 'Platform Lane',
      title: 'Platform Lane',
    });
    expect(hierarchy.workstreams[0]?.milestones[0]).toMatchObject({
      id: 'ms-1-id',
      name: 'Ship MVP',
      title: 'Ship MVP',
    });
    expect(hierarchy.workstreams[0]?.milestones[0]?.tasks[0]).toMatchObject({
      id: 'task-1-id',
      name: 'Draft narrative',
      title: 'Draft narrative',
    });
    expect(hierarchy.workstreams[0]?.milestones[0]?.tasks[1]).toMatchObject({
      id: 'task-2-id',
      name: 'Review metrics',
      title: 'Review metrics',
    });
  });
});
