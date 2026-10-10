import { describe, expect, it } from 'vitest';

import {
  canonicalizeToolCallGuidance,
  sanitizeToolResultGuidance,
} from '../src/toolGuidance';
import { buildBootstrapToolRouting } from '../src/bootstrapPayload';
import { CLAUDE_DIRECTORY_SURFACE } from '../src/toolProfiles';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';

describe('tool result guidance', () => {
  it('validates named ledger next_calls and filters incompatible search calls against the negotiated profile', () => {
    const result = { structuredContent: { next_calls: [
      { tool: 'orgx_search', args: { scope: 'work_ledger', receipt_id: 'receipt-1' } },
      { tool: 'orgx_list_work_receipts', args: { view: 'review' } },
      { tool: 'orgx_search', args: { scope: 'work_ledger', view: 'unsupported' } },
    ] } };
    expect(sanitizeToolResultGuidance(result, new Set(['orgx_search', 'orgx_list_work_receipts'])).structuredContent.next_calls)
      .toEqual([{ tool: 'orgx_list_work_receipts', args: { view: 'review' } }]);
    expect(sanitizeToolResultGuidance(result, new Set(['orgx_expect'])).structuredContent.next_calls).toEqual([]);
  });

  it('preserves validated historical directory calls only on the explicit compatibility profile', () => {
    const visible = new Set(['orgx_read_plan', 'orgx_update_entity', 'orgx_check_delegation']);
    const result = sanitizeToolResultGuidance({ structuredContent: {
      suggested_next_calls: [
        { tool: 'orgx_read_plan', args: {} },
        { tool: 'orgx_update_entity', args: { type: 'task', id: 'task-1', fields: { title: 'Revised' } } },
        { tool: 'orgx_update_entity', args: { type: 'task', id: 'task-1', fields: { status: 'done' } } },
        { tool: 'orgx_check_delegation', args: { action: 'guard', agent_type: 'engineering' } },
        { tool: 'orgx_delegate_work', args: { action: 'spawn', title: 'Hidden write', instructions: 'Do work' } },
        { tool: 'orgx_read_plan', args: { action: 'complete', plan_content: 'Cannot widen read' } },
      ],
    } }, visible, 'claude-directory-legacy');
    expect(result.structuredContent.suggested_next_calls).toEqual([
      { tool: 'orgx_read_plan', args: {} },
      { tool: 'orgx_update_entity', args: { type: 'task', id: 'task-1', fields: { title: 'Revised' } } },
    ]);
  });

  it('keeps directory bootstrap workflows intact through the result sanitizer', () => {
    const visible = CLAUDE_DIRECTORY_SURFACE.filter((tool) => tool !== 'resume_agent_run');
    const routing = buildBootstrapToolRouting({ requestedProfile: 'claude-directory', visibleTools: visible });
    const result = sanitizeToolResultGuidance({ structuredContent: routing }, new Set(visible), true);
    expect(result.structuredContent.recommended_workflows).toEqual(routing.recommended_workflows);
    expect(result.structuredContent.recommended_workflows.plan_feature).toContain('orgx_start_plan');
    expect(result.structuredContent.recommended_workflows.execute_task).toContain('orgx_start_agent_task');
    expect(result.structuredContent.recommended_workflows.preserve_work_receipt).toContain('orgx_validate_work_receipt');
  });

  it('shares current operation guidance across hosts and excludes app-only and profile-invisible calls', () => {
    const result = { structuredContent: {
      recommended_workflows: { continue: ['orgx_search', 'orgx_start_plan', 'resume_agent_run'] },
      next_call: { tool: 'orgx_read_plan', args: {} },
    } };
    const visible = new Set(['orgx_search', 'orgx_start_plan', 'orgx_read_plan', 'resume_agent_run']);
    expect(sanitizeToolResultGuidance(result, visible, 'claude-plugin').structuredContent).toEqual({
      recommended_workflows: { continue: ['orgx_search'] }, next_call: null,
    });
    expect(sanitizeToolResultGuidance(result, visible, true).structuredContent).toEqual({
      recommended_workflows: { continue: ['orgx_search', 'orgx_start_plan'] },
      next_call: { tool: 'orgx_read_plan', args: {} },
    });
    expect(sanitizeToolResultGuidance(result, visible).structuredContent).toEqual(
      sanitizeToolResultGuidance(result, visible, true).structuredContent
    );
  });

  it('preserves scored next actions while sanitizing their nested call breadcrumbs', () => {
    const recommendation = { key: 'task:42', label: 'Review the release', ready: false,
      initiativeId: 'initiative-1', nextTaskId: 'task-42', score: 13.5,
      suggested_next_calls: [{ tool: 'orgx_inspect', args: { type: 'task', id: 'task-42' } }] };
    const result = sanitizeToolResultGuidance({ structuredContent: {
      recommendations: [recommendation], next_action: recommendation,
      next_call: { label: 'Malformed continuation without a tool' },
    } }, new Set(['orgx_inspect']));
    expect(result.structuredContent.next_action).toEqual(recommendation);
    expect(result.structuredContent.next_action).toEqual(result.structuredContent.recommendations[0]);
    expect(result.structuredContent.next_call).toBeNull();
    expect(sanitizeToolResultGuidance({ structuredContent: { next_action: {
      ...recommendation, suggested_next_calls: [{ tool: 'orgx_spawn', args: { title: 'Hidden action' } }],
    } } }, new Set(['orgx_inspect'])).structuredContent.next_action).toEqual({
      ...recommendation, suggested_next_calls: [],
    });
  });

  it('rewrites legacy list breadcrumbs to the visible canonical search contract', () => {
    expect(
      canonicalizeToolCallGuidance(
        {
          tool: 'list_entities',
          label: 'Continue',
          args: { type: 'task', search: 'migration', limit: 10, offset: 10 },
        },
        new Set(['orgx_search'])
      )
    ).toEqual({
      tool: 'orgx_search',
      label: 'Continue',
      args: { type: 'task', query: 'migration', limit: 10, offset: 10 },
    });
  });

  it('removes dead and profile-invisible calls from nested result guidance', () => {
    const result = sanitizeToolResultGuidance(
      {
        structuredContent: {
          suggested_next_calls: [
            { tool: 'list_entities', args: { type: 'initiative' } },
            { tool: 'orgx_spawn', args: { title: 'Delegate' } },
            { tool: 'resume_plan_session', args: {} },
          ],
          recommended_workflows: {
            continue: ['orgx_search', 'orgx_spawn', 'list_entities'],
          },
          next_action: {
            tool: 'get_operator_chronicle',
            label: 'Read the chronicle',
            args: { period: '30d' },
          },
        },
      },
      new Set(['orgx_search', 'orgx_get_operator_brief'])
    );

    expect(result.structuredContent).toEqual({
      suggested_next_calls: [
        { tool: 'orgx_search', args: { type: 'initiative' } },
      ],
      recommended_workflows: { continue: ['orgx_search'] },
      next_action: {
        tool: 'orgx_get_operator_brief',
        label: 'Read the chronicle',
        args: { period: '30d' },
      },
    });
  });

  it('validates new receipt, save, and status contracts without permitting hidden routing fields', () => {
    const visible = new Set(['orgx_get_work_receipt', 'orgx_save_plan', 'orgx_get_operation_status']);
    const id = '11111111-1111-4111-8111-111111111111';
    const result = sanitizeToolResultGuidance({ structuredContent: { suggested_next_calls: [
      { tool: 'orgx_get_work_receipt', args: { receipt_id: 'receipt-1' } },
      { tool: 'orgx_get_work_receipt', args: { receipt_id: 'receipt-1', action: 'accept' } },
      { tool: 'orgx_save_plan', args: { session_id: id, plan_content: '# Saved', expected_version: 3 } },
      { tool: 'orgx_save_plan', args: { session_id: id, plan_content: '# Unsafe overwrite' } },
      { tool: 'orgx_get_operation_status', args: { kind: 'run', id } },
      { tool: 'orgx_get_operation_status', args: { kind: 'run' } },
      { tool: 'orgx_get_operation_status', args: {} },
    ] } }, visible);
    expect(result.structuredContent.suggested_next_calls).toEqual([
      { tool: 'orgx_get_work_receipt', args: { receipt_id: 'receipt-1' } },
      { tool: 'orgx_save_plan', args: { session_id: id, plan_content: '# Saved', expected_version: 3 } },
      { tool: 'orgx_get_operation_status', args: { kind: 'run', id } },
    ]);
  });

  it('rewrites old router continuations into one advertised operation without human authority', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const cases = [
      [{ tool: 'orgx_plan', args: { action: 'start', feature_name: 'Release', initial_plan: '# Plan' } }, { tool: 'orgx_start_plan', args: { title: 'Release', initial_plan: '# Plan' } }],
      [{ tool: 'orgx_spawn', args: { action: 'spawn', task_id: id } }, { tool: 'orgx_start_agent_task', args: { task_id: id } }],
      [{ tool: 'orgx_act', args: { action: 'launch', type: 'initiative', id } }, { tool: 'orgx_launch_initiative', args: { initiative_id: id } }],
      [{ tool: 'manage_lifecycle', args: { action: 'pause', level: 'task', id } }, { tool: 'orgx_pause_work', args: { level: 'task', id } }],
      [{ tool: 'orgx_write', args: { operation: 'create', type: 'task', title: 'Implement', workstream_id: id } }, { tool: 'orgx_create_task', args: { title: 'Implement', workstream_id: id } }],
      [{ tool: 'approve_decision', args: { decision_id: id, note: 'Model judgment' } }, { tool: 'orgx_open_decision_review', args: { decision_id: id } }],
    ];
    for (const [raw, expected] of cases) {
      expect(canonicalizeToolCallGuidance(raw, new Set(CLAUDE_DIRECTORY_SURFACE)), String(raw.tool)).toEqual(expected);
    }
  });

  it('keeps valid legacy router calls only when the compatibility profile and grant expose them', () => {
    const raw = { tool: 'orgx_spawn', args: { action: 'estimate', title: 'Route work' } };
    expect(canonicalizeToolCallGuidance(raw, new Set(['orgx_spawn']), 'legacy')).toEqual(raw);
    expect(canonicalizeToolCallGuidance(raw, new Set(['orgx_spawn']), 'v2')).toBeNull();
    expect(canonicalizeToolCallGuidance(raw, new Set(['orgx_search']), 'legacy')).toBeNull();
    expect(canonicalizeToolCallGuidance({ tool: 'orgx_read_plan', args: { action: 'complete' } }, new Set(['orgx_read_plan']))).toBeNull();
  });

  it('passes the actual profile through registration when an operation ID retains a legacy schema', async () => {
    const current = { tool: 'orgx_start_plan', args: { title: 'Current plan' } };
    const legacy = { tool: 'orgx_start_plan', args: { feature_name: 'Legacy plan' } };
    async function invoke(profile: string) {
      let handler!: () => Promise<{ structuredContent: { suggested_next_calls: unknown[] } }>;
      const server = { registerTool: (_name: string, _config: unknown, callback: typeof handler) => { handler = callback; } };
      installToolResultGuidanceWrapper(server as never, new Set(['orgx_start_plan']), undefined, undefined, false, profile);
      server.registerTool('guidance-fixture', {}, async () => ({ structuredContent: { suggested_next_calls: [current, legacy] } }));
      return (await handler()).structuredContent.suggested_next_calls;
    }
    expect(await invoke('chatgpt')).toEqual([current]);
    expect(await invoke('claude-directory-legacy')).toEqual([legacy]);
  });
});
