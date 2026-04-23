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
      assigned_agent_names: ['Dana'],
    });
    expect(workstream).not.toHaveProperty('primaryAgent');
    expect(workstream).not.toHaveProperty('ownerAgent');

    expect(milestone).toMatchObject({
      assigned_agent_ids: ['design-agent'],
      assigned_agent_names: ['Dana'],
    });
    expect(milestone).not.toHaveProperty('primaryAgent');
    expect(milestone).not.toHaveProperty('ownerAgent');

    expect(task).toMatchObject({
      assigned_agent_ids: ['design-agent'],
      assigned_agent_names: ['Dana'],
    });
    expect(task).not.toHaveProperty('primaryAgent');
    expect(task).not.toHaveProperty('ownerAgent');
  });

  it('folds coordination_dependency into initiative metadata instead of leaking to top level', () => {
    // Regression guard: the MCP schema exposes coordination_dependency as a
    // top-level field. Previously it was spread into the initiative entity
    // payload and the backend validator rejected it with
    //   "Field 'coordination_dependency' is not valid for entity type 'initiative'"
    // failing all 16 scaffold entities. It must land in metadata instead.
    const result = buildScaffoldInitiativeBatch({
      title: 'Cross-team Ship Window',
      workspace_id: 'ws-1',
      coordination_dependency: {
        name: 'Design → Engineering handoff',
        fromWorkstreamName: 'Design',
        toWorkstreamName: 'Engineering',
      },
      workstreams: [
        {
          title: 'Design',
          milestones: [{ title: 'Review', tasks: [{ title: 'Spec' }] }],
        },
        {
          title: 'Engineering',
          milestones: [{ title: 'Ship', tasks: [{ title: 'Build' }] }],
        },
      ],
    });

    const initiative = result.batch.find((entity) => entity.type === 'initiative');
    expect(initiative).toBeDefined();
    expect(initiative).not.toHaveProperty('coordination_dependency');
    const metadata = initiative?.metadata as Record<string, unknown> | undefined;
    expect(metadata).toBeDefined();
    expect(metadata?.coordination_dependency).toEqual({
      name: 'Design → Engineering handoff',
      from_workstream_name: 'Design',
      to_workstream_name: 'Engineering',
    });
    // Existing metadata defaults (live visibility) must still be present.
    expect(metadata?.live).toEqual({ visibility: 'public' });
  });

  it('omits coordination_dependency metadata entry when no hint is provided', () => {
    const result = buildScaffoldInitiativeBatch({
      title: 'Single-stream Initiative',
      workspace_id: 'ws-1',
      workstreams: [
        {
          title: 'Lane One',
          milestones: [{ title: 'M1', tasks: [{ title: 'T1' }] }],
        },
      ],
    });

    const initiative = result.batch.find((entity) => entity.type === 'initiative');
    expect(initiative).not.toHaveProperty('coordination_dependency');
    const metadata = initiative?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.coordination_dependency).toBeUndefined();
  });

  it('preserves optional goal_ids across the scaffold hierarchy', () => {
    const result = buildScaffoldInitiativeBatch({
      title: 'Goal-linked Initiative',
      workspace_id: 'ws-1',
      goal_ids: ['goal-init-1'],
      workstreams: [
        {
          title: 'Engineering',
          goal_ids: ['goal-ws-1'],
          milestones: [
            {
              title: 'Ship API',
              goal_ids: ['goal-ms-1'],
              tasks: [
                {
                  title: 'Add contract support',
                  goal_ids: ['goal-task-1'],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.batch[0]).toMatchObject({
      type: 'initiative',
      goal_ids: ['goal-init-1'],
    });
    expect(result.batch[1]).toMatchObject({
      type: 'workstream',
      goal_ids: ['goal-ws-1'],
    });
    expect(result.batch[2]).toMatchObject({
      type: 'milestone',
      goal_ids: ['goal-ms-1'],
    });
    expect(result.batch[3]).toMatchObject({
      type: 'task',
      goal_ids: ['goal-task-1'],
    });
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
