import { describe, expect, it } from 'vitest';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { applyToolArgumentAliases, TOOLS_WITH_ARGUMENT_ALIASES } from '../src/toolArgumentAliases';
import { CHATGPT_TOOL_DEFINITIONS } from '../src/toolDefinitions';

const TASK = '44444444-4444-4444-8444-444444444444';
const INITIATIVE = '22222222-2222-4222-8222-222222222222';

function inputShape(toolId: string): Record<string, unknown> {
  const tool = [...CHATGPT_TOOL_DEFINITIONS, ...CONTRACT_TOOL_DEFINITIONS].find(
    (definition) => definition.id === toolId
  );
  expect(tool, toolId).toBeDefined();
  return tool!.inputSchema as Record<string, unknown>;
}

describe('argument aliases callers really send (A5)', () => {
  it('handoff_task: reason maps to note; note wins when both are sent', () => {
    expect(applyToolArgumentAliases('handoff_task', { task_id: TASK, agent: 'eli', reason: 'Take over' })).toEqual({
      task_id: TASK,
      agent: 'eli',
      note: 'Take over',
    });
    expect(
      applyToolArgumentAliases('handoff_task', { task_id: TASK, agent: 'eli', note: 'Keep', reason: 'Ignored' })
    ).toEqual({ task_id: TASK, agent: 'eli', note: 'Keep' });
  });

  it.each(['orgx_recommend', 'recommend_next_action'])(
    '%s: initiative_id maps to entity_type=initiative + entity_id',
    (toolId) => {
      expect(applyToolArgumentAliases(toolId, { initiative_id: INITIATIVE, limit: 3 })).toEqual({
        entity_type: 'initiative',
        entity_id: INITIATIVE,
        limit: 3,
      });
      // An explicit scope wins.
      expect(
        applyToolArgumentAliases(toolId, {
          initiative_id: INITIATIVE,
          entity_type: 'workstream',
          entity_id: 'ws-1',
        })
      ).toEqual({ entity_type: 'workstream', entity_id: 'ws-1' });
    }
  );

  it('orgx_bootstrap: initiativeId / initiative map to initiative_id; initiative_id wins', () => {
    expect(applyToolArgumentAliases('orgx_bootstrap', { initiativeId: INITIATIVE })).toEqual({
      initiative_id: INITIATIVE,
    });
    expect(applyToolArgumentAliases('orgx_bootstrap', { initiative: INITIATIVE })).toEqual({
      initiative_id: INITIATIVE,
    });
    expect(
      applyToolArgumentAliases('orgx_bootstrap', { initiative_id: INITIATIVE, initiativeId: 'other' })
    ).toEqual({ initiative_id: INITIATIVE });
  });

  it('leaves current arguments and other tools untouched', () => {
    const args = { task_id: TASK, agent: 'eli', note: 'n' };
    expect(applyToolArgumentAliases('handoff_task', args)).toEqual(args);
    expect(applyToolArgumentAliases('orgx_search', { reason: 'x' })).toEqual({ reason: 'x' });
  });

  it('declares every alias on the input schema so hosts keep it', () => {
    expect([...TOOLS_WITH_ARGUMENT_ALIASES].sort()).toEqual(
      ['handoff_task', 'orgx_bootstrap', 'orgx_recommend', 'recommend_next_action'].sort()
    );
    expect(inputShape('handoff_task')).toHaveProperty('reason');
    expect(inputShape('orgx_recommend')).toHaveProperty('initiative_id');
    expect(inputShape('recommend_next_action')).toHaveProperty('initiative_id');
    expect(inputShape('orgx_bootstrap')).toHaveProperty('initiativeId');
    expect(inputShape('orgx_bootstrap')).toHaveProperty('initiative');
    expect(inputShape('orgx_bootstrap')).toHaveProperty('command_center_id');
  });
});
