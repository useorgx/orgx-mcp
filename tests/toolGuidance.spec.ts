import { describe, expect, it } from 'vitest';

import {
  canonicalizeToolCallGuidance,
  sanitizeToolResultGuidance,
} from '../src/toolGuidance';
import { buildBootstrapToolRouting } from '../src/bootstrapPayload';
import { CLAUDE_DIRECTORY_SURFACE } from '../src/toolProfiles';

describe('tool result guidance', () => {
  it('preserves only validated directory operation calls when explicitly enabled', () => {
    const visible = new Set(['orgx_read_plan', 'orgx_update_entity', 'orgx_check_delegation']);
    const result = sanitizeToolResultGuidance({ structuredContent: {
      suggested_next_calls: [
        { tool: 'orgx_read_plan', args: { session_id: '11111111-1111-4111-8111-111111111111' } },
        { tool: 'orgx_read_plan', args: {} },
        { tool: 'orgx_update_entity', args: { type: 'task', id: 'task-1', fields: { title: 'Revised' } } },
        { tool: 'orgx_update_entity', args: { type: 'task', id: 'task-1', fields: { status: 'done' } } },
        { tool: 'orgx_check_delegation', args: { action: 'guard', agent_type: 'engineering' } },
        { tool: 'orgx_delegate_work', args: { action: 'spawn', title: 'Hidden write', instructions: 'Do work' } },
        { tool: 'orgx_read_plan', args: { action: 'complete', plan_content: 'Cannot widen read' } },
      ],
    } }, visible, true);
    expect(result.structuredContent.suggested_next_calls).toEqual([
      { tool: 'orgx_read_plan', args: { session_id: '11111111-1111-4111-8111-111111111111' } },
      { tool: 'orgx_update_entity', args: { type: 'task', id: 'task-1', fields: { title: 'Revised' } } },
    ]);
  });

  it('keeps directory bootstrap workflows intact through the result sanitizer', () => {
    const visible = CLAUDE_DIRECTORY_SURFACE.filter((tool) => tool !== 'resume_agent_run');
    const routing = buildBootstrapToolRouting({ requestedProfile: 'claude-directory', visibleTools: visible });
    const result = sanitizeToolResultGuidance({ structuredContent: routing }, new Set(visible), true);
    expect(result.structuredContent.recommended_workflows).toEqual(routing.recommended_workflows);
    expect(result.structuredContent.recommended_workflows.plan_feature).toContain('orgx_start_plan');
    expect(result.structuredContent.recommended_workflows.execute_task).toContain('orgx_delegate_work');
  });

  it('never advertises directory-only operations or widget-only calls in other profile guidance', () => {
    const result = { structuredContent: {
      recommended_workflows: { continue: ['orgx_search', 'orgx_start_plan', 'resume_agent_run'] },
      next_call: { tool: 'orgx_read_plan', args: { session_id: '11111111-1111-4111-8111-111111111111' } },
    } };
    const visible = new Set(['orgx_search', 'orgx_start_plan', 'orgx_read_plan', 'resume_agent_run']);
    expect(sanitizeToolResultGuidance(result, visible).structuredContent).toEqual({
      recommended_workflows: { continue: ['orgx_search'] }, next_call: null,
    });
    expect(sanitizeToolResultGuidance(result, visible, true).structuredContent).toEqual({
      recommended_workflows: { continue: ['orgx_search', 'orgx_start_plan'] },
      next_call: { tool: 'orgx_read_plan', args: { session_id: '11111111-1111-4111-8111-111111111111' } },
    });
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
      new Set(['orgx_search', 'orgx_recommend'])
    );

    expect(result.structuredContent).toEqual({
      suggested_next_calls: [
        { tool: 'orgx_search', args: { type: 'initiative' } },
      ],
      recommended_workflows: { continue: ['orgx_search'] },
      next_action: {
        tool: 'orgx_recommend',
        label: 'Read the chronicle',
        args: { mode: 'morning_brief', period: '30d' },
      },
    });
  });
});
