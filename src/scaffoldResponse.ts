import type { BatchCreateSummary } from './batchCreate';

type JsonRecord = Record<string, unknown>;

const REF_MAP_INLINE_LIMIT = 300;
const CREATED_PREVIEW_LIMIT = 30;
const FAILED_PREVIEW_LIMIT = 30;
const TASK_INLINE_LIMIT = 250;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickDefined(record: JsonRecord, keys: readonly string[]): JsonRecord {
  const out: JsonRecord = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function tallyByType(
  items: Array<{ type: string | null | undefined }>
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const item of items) {
    const type = item.type || 'unknown';
    tally[type] = (tally[type] ?? 0) + 1;
  }
  return tally;
}

function compactInitiative(node: unknown): JsonRecord {
  const record = asRecord(node) ?? {};
  return pickDefined(record, [
    'id',
    'ref',
    'title',
    'name',
    'status',
    'domain',
    'persona',
    'success',
    'error',
  ]);
}

function compactTask(node: unknown): JsonRecord {
  const record = asRecord(node) ?? {};
  return pickDefined(record, [
    'id',
    'ref',
    'title',
    'name',
    'status',
    'priority',
    'type',
    'due_date',
    'domain',
    'persona',
    'success',
    'error',
  ]);
}

function compactMilestone(
  node: unknown,
  taskBudget: { remaining: number }
): JsonRecord {
  const record = asRecord(node) ?? {};
  const tasks = asArray(record.tasks);
  const includedTasks: JsonRecord[] = [];
  for (const task of tasks) {
    if (taskBudget.remaining <= 0) break;
    includedTasks.push(compactTask(task));
    taskBudget.remaining -= 1;
  }

  return {
    ...pickDefined(record, [
      'id',
      'ref',
      'title',
      'name',
      'status',
      'due_date',
      'domain',
      'persona',
      'success',
      'error',
    ]),
    task_count: tasks.length,
    omitted_task_count: Math.max(0, tasks.length - includedTasks.length),
    tasks: includedTasks,
  };
}

function compactWorkstream(
  node: unknown,
  taskBudget: { remaining: number }
): JsonRecord {
  const record = asRecord(node) ?? {};
  const milestones = asArray(record.milestones);
  const compactMilestones = milestones.map((milestone) =>
    compactMilestone(milestone, taskBudget)
  );
  const taskCount = compactMilestones.reduce(
    (sum, milestone) =>
      sum +
      (typeof milestone.task_count === 'number' ? milestone.task_count : 0),
    0
  );

  return {
    ...pickDefined(record, [
      'id',
      'ref',
      'title',
      'name',
      'status',
      'domain',
      'persona',
      'ownerAgent',
      'primaryAgent',
      'success',
      'error',
    ]),
    milestone_count: milestones.length,
    task_count: taskCount,
    milestones: compactMilestones,
  };
}

function compactHierarchy(hierarchy: unknown) {
  const record = asRecord(hierarchy) ?? {};
  const taskBudget = { remaining: TASK_INLINE_LIMIT };
  const workstreams = asArray(record.workstreams).map((workstream) =>
    compactWorkstream(workstream, taskBudget)
  );
  const milestoneCount = workstreams.reduce(
    (sum, workstream) =>
      sum +
      (typeof workstream.milestone_count === 'number'
        ? workstream.milestone_count
        : 0),
    0
  );
  const taskCount = workstreams.reduce(
    (sum, workstream) =>
      sum +
      (typeof workstream.task_count === 'number' ? workstream.task_count : 0),
    0
  );

  return {
    hierarchy: {
      initiative: compactInitiative(record.initiative),
      workstreams,
    },
    counts: {
      workstreams: workstreams.length,
      milestones: milestoneCount,
      tasks: taskCount,
      inline_tasks: TASK_INLINE_LIMIT - taskBudget.remaining,
      omitted_tasks: Math.max(
        0,
        taskCount - (TASK_INLINE_LIMIT - taskBudget.remaining)
      ),
    },
  };
}

function compactRefMap(refMap: Record<string, string> | undefined) {
  const entries = Object.entries(refMap ?? {});
  return {
    ref_map:
      entries.length <= REF_MAP_INLINE_LIMIT
        ? Object.fromEntries(entries)
        : Object.fromEntries(entries.slice(0, REF_MAP_INLINE_LIMIT)),
    ref_map_count: entries.length,
    ref_map_truncated: entries.length > REF_MAP_INLINE_LIMIT,
  };
}

function compactStreams(streams: unknown) {
  const record = asRecord(streams);
  if (!record) return undefined;
  const items = asArray(record.items)
    .map((item) => {
      const stream = asRecord(item);
      if (!stream) return null;
      return pickDefined(stream, [
        'id',
        'workstream_id',
        'status',
        'auto_continue',
        'agent_domain',
        'progress_pct',
        'current_job_id',
      ]);
    })
    .filter(Boolean);

  return {
    total: typeof record.total === 'number' ? record.total : items.length,
    by_status: asRecord(record.by_status) ?? {},
    workstream_to_stream_id: asRecord(record.workstream_to_stream_id) ?? {},
    items,
  };
}

function compactAgentAssignment(agentAssignment: unknown) {
  const record = asRecord(agentAssignment);
  if (!record) return undefined;
  const assignments = asArray(record.assignments)
    .map((item) => {
      const assignment = asRecord(item);
      if (!assignment) return null;
      return pickDefined(assignment, [
        'workstream_id',
        'agent_id',
        'agent_name',
        'domain',
      ]);
    })
    .filter(Boolean);
  return {
    ...pickDefined(record, ['attempted', 'ok', 'assigned_count', 'error']),
    assignments,
  };
}

function compactFallbackDispatch(fallback: unknown) {
  const record = asRecord(fallback);
  if (!record) return undefined;
  return pickDefined(record, ['attempted', 'ok', 'agent', 'message', 'error']);
}

function buildResultContract(params: {
  initiativeId?: string | null;
  workspaceId?: string | null;
}) {
  const listBase = params.initiativeId
    ? { initiative_id: params.initiativeId }
    : {};
  const workspaceScoped = params.workspaceId
    ? { workspace_id: params.workspaceId }
    : {};
  return {
    mode: 'compact_scaffold_result',
    reason:
      'Large scaffold results return summary stats and a renderable compact hierarchy instead of full entity rows.',
    do_not_retry_for_full_payload: true,
    stable_keys: [
      'initiative_id',
      'live_url',
      'summary_stats',
      'hierarchy',
      'ref_map',
    ],
    detail_policy:
      'Fetch details through list_entities/get_task_with_context with pagination instead of asking scaffold_initiative to return a larger payload.',
    suggested_next_calls: [
      {
        tool: 'list_entities',
        args: {
          type: 'workstream',
          ...listBase,
          ...workspaceScoped,
          limit: 50,
          fields: ['id', 'title', 'status', 'domain'],
        },
      },
      {
        tool: 'list_entities',
        args: {
          type: 'milestone',
          ...listBase,
          ...workspaceScoped,
          limit: 100,
          fields: ['id', 'title', 'status', 'workstream_id'],
        },
      },
      {
        tool: 'list_entities',
        args: {
          type: 'task',
          ...listBase,
          ...workspaceScoped,
          limit: 100,
          fields: ['id', 'title', 'status', 'priority', 'milestone_id'],
        },
      },
    ],
  };
}

export function buildCompactScaffoldResult(params: {
  result: BatchCreateSummary;
  hierarchy: unknown;
  initiativeId?: string | null;
  workspaceId?: string | null;
  liveUrl?: string | null;
  scaffoldStreamUrl?: string | null;
  scaffoldSessionId?: string | null;
  agentAssignment?: unknown;
  credentialStatus?: unknown;
  launch?: unknown;
  streams?: unknown;
  billingUsage?: unknown;
  scaffoldUsage?: unknown;
  fallbackAgentDispatch?: unknown;
}) {
  const { hierarchy, counts } = compactHierarchy(params.hierarchy);
  const refMap = compactRefMap(params.result.ref_map);
  const createdPreview = params.result.created.slice(0, CREATED_PREVIEW_LIMIT);
  const failedPreview = params.result.failed.slice(0, FAILED_PREVIEW_LIMIT);

  return {
    summary: params.result.summary,
    initiative_id: params.initiativeId ?? undefined,
    live_url: params.liveUrl ?? undefined,
    summary_stats: {
      requested_count: params.result.total,
      created_count: params.result.created_count,
      failed_count: params.result.failed_count,
      created_by_type: tallyByType(params.result.created),
      failed_by_type: tallyByType(params.result.failed),
      workstream_count: counts.workstreams,
      milestone_count: counts.milestones,
      task_count: counts.tasks,
      inline_task_count: counts.inline_tasks,
      omitted_task_count: counts.omitted_tasks,
    },
    hierarchy,
    created_preview: createdPreview,
    created_preview_count: createdPreview.length,
    created_count: params.result.created.length,
    failed_preview: failedPreview,
    failed_preview_count: failedPreview.length,
    failed_count: params.result.failed.length,
    ...refMap,
    scaffold_stream_url: params.scaffoldStreamUrl ?? undefined,
    scaffold_session_id: params.scaffoldSessionId ?? undefined,
    agent_assignment: compactAgentAssignment(params.agentAssignment),
    credential_status: params.credentialStatus,
    launch: params.launch,
    streams: compactStreams(params.streams),
    billing_usage: params.billingUsage,
    scaffold_usage: params.scaffoldUsage,
    fallback_agent_dispatch: compactFallbackDispatch(
      params.fallbackAgentDispatch
    ),
    result_contract: buildResultContract({
      initiativeId: params.initiativeId,
      workspaceId: params.workspaceId,
    }),
    tool_hints: {
      do_not_rerun_scaffold_for_more_detail: true,
      use_ref_map_or_list_entities_for_ids: true,
      large_payloads_are_intentionally_compacted: true,
    },
  };
}
