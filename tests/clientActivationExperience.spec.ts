import { describe, expect, it } from 'vitest';

import { buildClientActivationExperience } from '../src/clientActivationExperience';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';

describe('clientActivationExperience', () => {
  it('picks the next client-specific activation step from the current milestone state', () => {
    const state = createEmptyMcpActivationState();
    state.source_client = 'cursor';
    state.milestones.D1 = '2026-03-23T10:00:00.000Z';

    const experience = buildClientActivationExperience({
      state,
      sourceClient: 'cursor',
    });

    expect(experience?.playbook).toBe('Cursor inline delivery loop');
    expect(experience?.progress_pct).toBe(20);
    expect(experience?.next_stage).toBe('A1');
    expect(experience?.next_action).toMatchObject({
      tool: 'scaffold_initiative',
      label: 'Scaffold the first initiative',
    });
  });

  it('emits a celebration once activation is completed', () => {
    const state = createEmptyMcpActivationState();
    state.source_client = 'claude';
    state.milestones.D1 = '2026-03-23T09:00:00.000Z';
    state.milestones.A1 = '2026-03-23T09:05:00.000Z';
    state.milestones.A2 = '2026-03-23T09:10:00.000Z';
    state.milestones.A3 = '2026-03-23T09:15:00.000Z';
    state.milestones.A4 = '2026-03-23T09:15:00.000Z';

    const experience = buildClientActivationExperience({
      state,
      sourceClient: 'claude',
      events: [
        {
          event: 'mcp_multi_tool_activation',
          properties: {},
        },
      ],
    });

    expect(experience?.celebration?.title).toBe('Activation complete');
    expect(experience?.celebration?.next_action?.tool).toBe(
      'recommend_next_action'
    );
    expect(experience?.next_stage).toBeNull();
  });
});
