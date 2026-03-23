import { describe, expect, it } from 'vitest';

import {
  applyMcpActivationObservation,
  createEmptyMcpActivationState,
} from '../src/mcpActivationTracker';

describe('mcpActivationTracker', () => {
  it('tracks skill catalog discovery with client context', () => {
    const result = applyMcpActivationObservation(
      createEmptyMcpActivationState(),
      {
        toolId: 'list_entities',
        args: { type: 'skill' },
        sourceClient: 'cursor',
        workspaceId: 'ws-1',
      }
    );

    expect(result.state.source_client).toBe('cursor');
    expect(result.state.workspace_id).toBe('ws-1');
    expect(result.state.milestones.D1).toBeTruthy();
    expect(result.events[0]).toMatchObject({
      event: 'mcp_skill_catalog_viewed',
      properties: {
        activation_stage: 'D1',
        source_client: 'cursor',
        workspace_id: 'ws-1',
      },
    });
  });

  it('marks activation complete after structure, task creation, and morning brief', () => {
    const scaffolded = applyMcpActivationObservation(
      createEmptyMcpActivationState(),
      {
        toolId: 'scaffold_initiative',
        workspaceId: 'ws-1',
        initiativeId: 'init-1',
        data: {
          hierarchy: {
            workstreams: [
              {
                milestones: [
                  {
                    tasks: [{ type: 'task', id: 'task-1' }],
                  },
                ],
              },
            ],
          },
        },
      }
    );

    expect(scaffolded.state.milestones.A1).toBeTruthy();
    expect(scaffolded.state.milestones.A2).toBeTruthy();
    expect(scaffolded.events.map((event) => event.event)).toEqual([
      'mcp_structure_created',
      'mcp_task_created',
    ]);

    const activated = applyMcpActivationObservation(scaffolded.state, {
      toolId: 'get_morning_brief',
      workspaceId: 'ws-1',
      initiativeId: 'init-1',
    });

    expect(activated.state.milestones.A3).toBeTruthy();
    expect(activated.state.milestones.A4).toBeTruthy();
    expect(activated.events.map((event) => event.event)).toEqual([
      'mcp_morning_brief_viewed',
      'mcp_multi_tool_activation',
    ]);
  });

  it('does not re-emit the activation event once the funnel is complete', () => {
    const initial = applyMcpActivationObservation(
      createEmptyMcpActivationState(),
      {
        toolId: 'scaffold_initiative',
        data: {
          hierarchy: {
            tasks: [{ type: 'task', id: 'task-1' }],
          },
        },
      }
    );
    const completed = applyMcpActivationObservation(initial.state, {
      toolId: 'get_morning_brief',
    });
    const repeated = applyMcpActivationObservation(completed.state, {
      toolId: 'get_morning_brief',
    });

    expect(repeated.events).toEqual([]);
  });
});
