import { describe, expect, it } from 'vitest';

import {
  canonicalizeToolCallGuidance,
  sanitizeToolResultGuidance,
} from '../src/toolGuidance';

describe('tool result guidance', () => {
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
