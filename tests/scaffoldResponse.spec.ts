import { describe, expect, it } from 'vitest';

import { buildCompactScaffoldResult } from '../src/scaffoldResponse';

describe('compact scaffold responses', () => {
  it('keeps scaffold tool results small and gives agents retrieval hints', () => {
    const tasks = Array.from({ length: 260 }, (_, index) => ({
      id: `task-${index}`,
      ref: `task-${index}`,
      title: `Task ${index}`,
      description: 'x'.repeat(500),
      status: 'todo',
      metadata: { noisy: 'y'.repeat(500) },
    }));
    const result = buildCompactScaffoldResult({
      initiativeId: 'init-1',
      workspaceId: 'workspace-1',
      liveUrl: 'https://useorgx.com/live/init-1',
      result: {
        summary: 'Created 263/263 entities',
        total: 263,
        created_count: 263,
        failed_count: 0,
        warnings: [],
        failed: [],
        ref_map: Object.fromEntries([
          ['initiative', 'init-1'],
          ['ws-1', 'ws-1-id'],
          ['ms-1', 'ms-1-id'],
          ...tasks.map((task) => [task.ref, task.id] as const),
        ]),
        created: [
          { index: 0, type: 'initiative', id: 'init-1', ref: 'initiative' },
          { index: 1, type: 'workstream', id: 'ws-1-id', ref: 'ws-1' },
          { index: 2, type: 'milestone', id: 'ms-1-id', ref: 'ms-1' },
          ...tasks.map((task, index) => ({
            index: index + 3,
            type: 'task',
            id: task.id,
            ref: task.ref,
            title: task.title,
          })),
        ],
        results: [],
      },
      hierarchy: {
        initiative: {
          id: 'init-1',
          title: 'Launch',
          description: 'Large private context that should not go to the LLM.',
        },
        workstreams: [
          {
            id: 'ws-1-id',
            ref: 'ws-1',
            title: 'Platform',
            description: 'large',
            milestones: [
              {
                id: 'ms-1-id',
                ref: 'ms-1',
                title: 'Ready',
                tasks,
              },
            ],
          },
        ],
      },
    });

    expect(result.summary_stats.task_count).toBe(260);
    expect(result.summary_stats.inline_task_count).toBe(250);
    expect(result.summary_stats.omitted_task_count).toBe(10);
    expect(result.created_preview).toHaveLength(30);
    expect(result.created_count).toBe(263);
    expect(result.result_contract.do_not_retry_for_full_payload).toBe(true);
    expect(result.result_contract.suggested_next_calls[2]?.tool).toBe(
      'list_entities'
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Large private context');
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain('"description"');
  });
});
