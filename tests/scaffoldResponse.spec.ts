import { describe, expect, it } from 'vitest';

import {
  buildCompactScaffoldResult,
  buildScaffoldDraftResult,
} from '../src/scaffoldResponse';

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

  /**
   * Result-contract / tool_hints schema lock.
   *
   * scaffold_initiative is the highest-volume agent entry point. Agents
   * read result_contract + tool_hints to decide what to do next: retry,
   * paginate, or move on. Any change to these field names or to the shape
   * of suggested_next_calls is a breaking change for every agent that
   * follows the breadcrumbs — this test makes that change visible in CI.
   */
  it('result_contract carries the stable shape agents rely on', () => {
    const result = buildCompactScaffoldResult({
      initiativeId: 'init-x',
      workspaceId: 'ws-x',
      liveUrl: 'https://useorgx.com/live/init-x',
      result: {
        summary: 'Created 4/4 entities',
        total: 4,
        created_count: 4,
        failed_count: 0,
        warnings: [],
        failed: [],
        ref_map: { initiative: 'init-x', 'ws-1': 'ws-id', 'ms-1': 'ms-id', 't-1': 't-id' },
        created: [
          { index: 0, type: 'initiative', id: 'init-x' },
          { index: 1, type: 'workstream', id: 'ws-id' },
          { index: 2, type: 'milestone', id: 'ms-id' },
          { index: 3, type: 'task', id: 't-id' },
        ],
        results: [],
      },
      hierarchy: {
        initiative: { id: 'init-x', title: 'Test' },
        workstreams: [
          {
            id: 'ws-id',
            title: 'WS',
            milestones: [{ id: 'ms-id', title: 'MS', tasks: [{ id: 't-id', title: 'T' }] }],
          },
        ],
      },
      firstAgentWork: {
        mode: 'launch',
        status: 'work_started',
        initiative_id: 'init-x',
        first_stream_id: 'stream-x',
      },
    });

    // Top-level stable keys agents may rely on.
    expect(result).toHaveProperty('mode');
    expect(result).toHaveProperty('initiative_id');
    expect(result).toHaveProperty('live_url');
    expect(result).toHaveProperty('summary_stats');
    expect(result).toHaveProperty('hierarchy');
    expect(result).toHaveProperty('ref_map');
    expect(result).toHaveProperty('first_agent_work');
    expect(result).toHaveProperty('result_contract');
    expect(result).toHaveProperty('tool_hints');

    // result_contract shape.
    expect(result.result_contract.mode).toBe('compact_scaffold_result');
    expect(result.result_contract.do_not_retry_for_full_payload).toBe(true);
    expect(Array.isArray(result.result_contract.stable_keys)).toBe(true);
    expect(result.result_contract.stable_keys).toEqual(
      expect.arrayContaining([
        'mode',
        'initiative_id',
        'live_url',
        'summary_stats',
        'hierarchy',
        'ref_map',
        'first_agent_work',
      ])
    );
    expect(typeof result.result_contract.detail_policy).toBe('string');
    expect(typeof result.result_contract.reason).toBe('string');

    // suggested_next_calls is the breadcrumb agents follow when they want
    // more detail. Each call must name a tool and an args object.
    const nextCalls = result.result_contract.suggested_next_calls;
    expect(Array.isArray(nextCalls)).toBe(true);
    expect(nextCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of nextCalls) {
      expect(typeof call.tool).toBe('string');
      expect(call.tool.length).toBeGreaterThan(0);
      expect(call.args).toBeTypeOf('object');
    }
    // The three call types we depend on for follow-up reads.
    const tools = nextCalls.map((c) => c.tool);
    expect(tools).toContain('list_entities');

    // tool_hints flags the compaction policy so agents stop guessing.
    expect(result.tool_hints).toMatchObject({
      do_not_rerun_scaffold_for_more_detail: true,
      use_ref_map_or_list_entities_for_ids: true,
      large_payloads_are_intentionally_compacted: true,
    });

    // summary_stats shape.
    expect(result.summary_stats).toMatchObject({
      requested_count: expect.any(Number),
      created_count: expect.any(Number),
      failed_count: expect.any(Number),
      workstream_count: expect.any(Number),
      milestone_count: expect.any(Number),
      task_count: expect.any(Number),
    });
    expect(result.summary_stats.created_by_type).toBeTypeOf('object');
    expect(result.summary_stats.failed_by_type).toBeTypeOf('object');
  });

  it('initiative-scoped suggested_next_calls carry the initiative_id and workspace_id', () => {
    const result = buildCompactScaffoldResult({
      initiativeId: 'init-args',
      workspaceId: 'ws-args',
      liveUrl: null,
      result: {
        summary: '',
        total: 0,
        created_count: 0,
        failed_count: 0,
        warnings: [],
        failed: [],
        ref_map: {},
        created: [],
        results: [],
      },
      hierarchy: { initiative: { id: 'init-args', title: '' }, workstreams: [] },
    });

    for (const call of result.result_contract.suggested_next_calls) {
      expect(call.args).toMatchObject({
        initiative_id: 'init-args',
        workspace_id: 'ws-args',
      });
    }
  });

  it('builds a no-write draft response with entity counts and dependency hints', () => {
    const result = buildScaffoldDraftResult({
      workspaceId: 'ws-1',
      idempotencyKey: 'scaffold:draft',
      dependencyEdges: [
        {
          type: 'workstream',
          name: 'Design handoff',
          from_ref: 'ws-design',
          to_ref: 'ws-eng',
        },
      ],
      batch: [
        { type: 'initiative', ref: 'initiative', title: 'Launch' },
        { type: 'workstream', ref: 'ws-design', title: 'Design' },
        {
          type: 'workstream',
          ref: 'ws-eng',
          title: 'Engineering',
          depends_on: ['ws-design'],
        },
      ],
    });

    expect(result.mode).toBe('draft');
    expect(result.summary_stats).toMatchObject({
      requested_count: 3,
      created_count: 0,
      failed_count: 0,
      dependency_edge_count: 1,
    });
    expect(result.tool_hints).toMatchObject({
      draft_mode_has_no_side_effects: true,
      use_mode_scaffold_to_create_without_launch: true,
      use_mode_launch_to_create_and_start_agents: true,
    });
    expect(result.entity_plan_preview[2]).toMatchObject({
      ref: 'ws-eng',
      depends_on: ['ws-design'],
    });
  });
});
