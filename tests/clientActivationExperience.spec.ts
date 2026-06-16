import { describe, expect, it } from 'vitest';

import { buildClientActivationExperience } from '../src/clientActivationExperience';
import { detectSourceClient } from '../src/cross-pollination';
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
      tool: 'orgx_plan',
      args: { action: 'start' },
      label: 'Scaffold the first initiative',
    });
    expect(experience?.hook_coverage.coverage_level).toBe('native_hooks');
    expect(experience?.hook_coverage.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'Lifecycle hooks',
          status: 'wired',
        }),
      ])
    );
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
      'orgx_recommend'
    );
    expect(experience?.next_stage).toBeNull();
  });

  it('keeps ChatGPT chronicle reporting tied to the action-list proof gap', () => {
    const state = createEmptyMcpActivationState();
    state.source_client = 'chatgpt';

    const experience = buildClientActivationExperience({
      state,
      sourceClient: 'chatgpt',
    });

    expect(experience?.hook_coverage.coverage_level).toBe('tool_actions');
    expect(experience?.hook_coverage.reporting_entrypoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'get_operator_chronicle' }),
      ])
    );
    expect(experience?.hook_coverage.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'Ambient lifecycle hooks',
          status: 'missing',
        }),
      ])
    );
    expect(experience?.hook_coverage.required_proof.join('\n')).toContain(
      'installed ChatGPT app action list'
    );
  });

  it('recognizes Codex as its own reporting client instead of generic other', () => {
    const state = createEmptyMcpActivationState();
    state.source_client = 'codex';
    state.milestones.D1 = '2026-06-05T09:00:00.000Z';
    state.milestones.A1 = '2026-06-05T09:05:00.000Z';
    state.milestones.A2 = '2026-06-05T09:10:00.000Z';

    const experience = buildClientActivationExperience({
      state,
      sourceClient: 'codex',
    });

    expect(detectSourceClient({ name: 'Codex CLI' })).toBe('codex');
    expect(experience?.source_client).toBe('codex');
    expect(experience?.playbook).toBe('Codex local execution proof loop');
    expect(experience?.next_stage).toBe('A3');
    expect(experience?.next_action).toMatchObject({
      tool: 'get_operator_chronicle',
      args: { period: '30d' },
    });
    expect(experience?.hook_coverage.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'Native lifecycle hooks',
          status: 'missing',
        }),
        expect.objectContaining({
          surface: 'Direct chronicle action in active Codex sessions',
          status: 'partial',
        }),
        // The WEG execution-graph emitter is wired even though Codex has no
        // native activity/receipt hook bundle.
        expect.objectContaining({
          surface: 'Execution-graph auto-emit hook',
          status: 'wired',
        }),
      ])
    );
  });

  it('reports the execution-graph auto-emit hook as wired for Claude Code and Cursor', () => {
    for (const sourceClient of ['claude', 'cursor'] as const) {
      const state = createEmptyMcpActivationState();
      state.source_client = sourceClient;
      const experience = buildClientActivationExperience({
        state,
        sourceClient,
      });
      expect(experience?.hook_coverage.surfaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            surface: 'Execution-graph auto-emit hook',
            status: 'wired',
          }),
        ])
      );
    }
  });
});
