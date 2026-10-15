import { describe, expect, it } from 'vitest';

import {
  buildClientActivationExperience,
  formatClientActivationExperience,
  listClientActivationHints,
  materializeActivationAction,
  type ClientActivationAction,
} from '../src/clientActivationExperience';
import { getClientHookCoverage } from '../src/clientHookCoverage';
import { detectSourceClient, type SourceClient } from '../src/cross-pollination';
import { requiresIdempotencyKey } from '../src/idempotencyKeys';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { getPublicOperationContract } from '../src/publicOperationContracts';
import { canonicalizeToolCallGuidance } from '../src/toolGuidance';
import { resolveProfileToolSet } from '../src/toolProfiles';
import { isWidgetOnlyTool } from '../src/widgetToolContract';

const v2 = resolveProfileToolSet('v2')!;
const SOURCE_CLIENTS: SourceClient[] = [
  'cursor', 'claude', 'chatgpt', 'codex', 'opencode', 'openclaw', 'vscode', 'goose', 'api', 'webapp', 'other',
];
const RETIRED_TOOLS = /\b(?:orgx_plan|orgx_write|orgx_recommend|orgx_bootstrap|orgx_submit_receipt|orgx_emit_activity|get_operator_chronicle|get_morning_brief)\b/;

function expectHintOnV2(hint: ClientActivationAction, label: string) {
  expect(v2.has(hint.tool), `${label}: ${hint.tool} is not on the v2 profile`).toBe(true);
  expect(isWidgetOnlyTool(hint.tool), `${label}: ${hint.tool} is widget-only`).toBe(false);
  expect(`${hint.prompt} ${hint.label}`, `${label}: prose names a retired tool`).not.toMatch(RETIRED_TOOLS);
  const contract = getPublicOperationContract(hint.tool)!;
  for (const field of hint.required_inputs ?? []) {
    expect(Object.hasOwn(contract.inputSchema, field), `${label}: ${hint.tool} has no ${field}`).toBe(true);
  }
  if (requiresIdempotencyKey(contract.inputSchema)) {
    // Writes carry a freshly minted key on every response.
    const key = hint.args?.idempotency_key;
    expect(typeof key === 'string' && /^mcp:[A-Za-z0-9_]+:[A-Za-z0-9-]+$/.test(key), `${label}: ${hint.tool} lacks idempotency_key`).toBe(true);
  }
  // The live guidance sanitizer must keep the hint exactly as built.
  expect(canonicalizeToolCallGuidance(hint, null, 'v2'), `${label}: ${JSON.stringify(hint)} fails its advertised schema`).toEqual(hint);
}

describe('clientActivationExperience', () => {
  it('suggests only v2 tools, with idempotency keys on writes, in every activation hint', () => {
    for (const hint of listClientActivationHints()) {
      expectHintOnV2(materializeActivationAction(hint)!, `playbook/${hint.label}`);
    }
    for (const sourceClient of SOURCE_CLIENTS) {
      for (const hint of getClientHookCoverage(sourceClient).reporting_entrypoints) {
        expectHintOnV2(hint, `${sourceClient}/reporting/${hint.label}`);
      }
      // Walk each client through every stage as it appears in a response.
      const state = createEmptyMcpActivationState();
      state.source_client = sourceClient;
      for (const stage of ['D1', 'A1', 'A2', 'A3', 'A4'] as const) {
        const experience = buildClientActivationExperience({ state, sourceClient });
        expectHintOnV2(experience!.next_action!, `${sourceClient}/${stage}`);
        state.milestones[stage] = '2026-10-14T00:00:00.000Z';
      }
      const done = buildClientActivationExperience({
        state, sourceClient, events: [{ event: 'mcp_multi_tool_activation', properties: {} }],
      });
      expectHintOnV2(done!.celebration!.next_action!, `${sourceClient}/celebration`);
    }
  });

  it('mints a distinct idempotency key for each write hint response', () => {
    const state = createEmptyMcpActivationState();
    state.milestones.D1 = '2026-10-14T00:00:00.000Z';
    const first = buildClientActivationExperience({ state, sourceClient: 'claude' })!.next_action!;
    const second = buildClientActivationExperience({ state, sourceClient: 'claude' })!.next_action!;
    expect(first).toMatchObject({ tool: 'orgx_start_plan', required_inputs: ['title'] });
    expect(first.args?.idempotency_key).not.toEqual(second.args?.idempotency_key);
    // The static playbook entry stays keyless.
    expect(listClientActivationHints().some((hint) => hint.args?.idempotency_key !== undefined)).toBe(false);
  });

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
      tool: 'orgx_start_plan',
      required_inputs: ['title'],
      label: 'Scaffold the first initiative',
    });
    expect(experience?.next_action?.args?.idempotency_key).toMatch(/^mcp:start_plan:/);
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
      'orgx_get_next_actions'
    );
    expect(experience?.next_stage).toBeNull();
    expect(experience?.celebration?.persistent_adoption).toMatchObject({
      label: 'Add the OrgX block to CLAUDE.md / AGENTS.md',
      canonical_block_url: 'https://mcp.useorgx.com/agents.md',
    });
    // Suggestion-phrased, never imperative-spammy.
    expect(
      experience?.celebration?.persistent_adoption.suggestion
    ).toContain('Optional:');
  });

  it('surfaces the persistence suggestion in guidance text only with the first-win celebration', () => {
    const state = createEmptyMcpActivationState();
    state.source_client = 'claude';
    state.milestones.D1 = '2026-03-23T09:00:00.000Z';
    state.milestones.A1 = '2026-03-23T09:05:00.000Z';
    state.milestones.A2 = '2026-03-23T09:10:00.000Z';
    state.milestones.A3 = '2026-03-23T09:15:00.000Z';
    state.milestones.A4 = '2026-03-23T09:15:00.000Z';

    const celebrated = buildClientActivationExperience({
      state,
      sourceClient: 'claude',
      events: [{ event: 'mcp_multi_tool_activation', properties: {} }],
    });
    const celebratedText = formatClientActivationExperience(celebrated);
    const occurrences =
      celebratedText.split('https://mcp.useorgx.com/agents.md').length - 1;
    expect(occurrences).toBe(1);
    expect(celebratedText).toContain("CLAUDE.md or AGENTS.md");

    // Same completed state, but the once-ever activation event is not firing
    // again (mcpActivationTracker never re-emits it), so no suggestion.
    const repeat = buildClientActivationExperience({
      state,
      sourceClient: 'claude',
      events: [],
    });
    expect(repeat?.celebration).toBeUndefined();
    expect(formatClientActivationExperience(repeat)).not.toContain(
      'agents.md'
    );
  });

  it('keeps the persistence suggestion out of ordinary in-progress responses', () => {
    const state = createEmptyMcpActivationState();
    state.source_client = 'cursor';
    state.milestones.D1 = '2026-03-23T10:00:00.000Z';

    const experience = buildClientActivationExperience({
      state,
      sourceClient: 'cursor',
    });

    expect(experience?.celebration).toBeUndefined();
    const text = formatClientActivationExperience(experience);
    expect(text).not.toContain('agents.md');
    expect(text).not.toContain('CLAUDE.md');
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
        expect.objectContaining({ tool: 'orgx_get_operator_brief' }),
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
      tool: 'orgx_get_operator_brief',
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
