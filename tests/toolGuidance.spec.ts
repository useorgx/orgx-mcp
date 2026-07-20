import { describe, expect, it } from 'vitest';

import {
  canonicalizeToolCallGuidance,
  sanitizeToolResultGuidance,
} from '../src/toolGuidance';

describe('tool result guidance', () => {
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
