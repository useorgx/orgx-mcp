function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const TERMINAL_TASK_STATES = new Set([
  'done',
  'complete',
  'completed',
  'approved',
  'shipped',
  'resolved',
]);

function taskState(value: unknown): string {
  return asNonEmptyString(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '_') ?? '';
}

function taskArrays(record: Record<string, unknown>, keys: string[]): unknown[] {
  return uniqueByStableKey(keys.flatMap((key) => asArray(record[key])));
}

function staleHeartbeat(value: unknown, now = Date.now()): boolean {
  const raw = asNonEmptyString(value);
  if (!raw) return false;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && now - parsed > 120_000;
}

function completedTasksForAgent(agent: Record<string, unknown>): unknown[] {
  const explicit = taskArrays(agent, [
    'completed_tasks',
    'completedTasks',
    'recent_completed',
    'recentCompleted',
    'history',
  ]);
  const current = taskArrays(agent, [
    'current_tasks',
    'currentTasks',
    'active_tasks',
    'activeTasks',
    'tasks',
  ]).filter((task) => {
    if (!task || typeof task !== 'object') return false;
    const record = task as Record<string, unknown>;
    return TERMINAL_TASK_STATES.has(
      taskState(record.status ?? record.state ?? record.phase)
    );
  });
  return uniqueByStableKey([...explicit, ...current]);
}

function withDerivedTaskState(agent: Record<string, unknown>): Record<string, unknown> {
  const completed = completedTasksForAgent(agent);
  const status = normalizedStatus(agent.status);
  const heartbeat = agent.last_heartbeat_at ?? agent.lastHeartbeatAt;
  const nextStatus =
    (status === 'running' && staleHeartbeat(heartbeat)) ||
    ['stalled', 'stale'].includes(taskState(agent.status))
      ? 'stalled'
      : status;
  return {
    ...agent,
    status: nextStatus,
    completed_tasks: completed,
    completed_count: completed.length,
  };
}

function uniqueByStableKey(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedStatus(value: unknown): string {
  const status = asNonEmptyString(value)?.toLowerCase() ?? '';
  if (['running', 'active', 'executing', 'in_progress'].includes(status)) {
    return 'running';
  }
  if (['blocked', 'at_risk', 'waiting', 'paused'].includes(status)) {
    return 'blocked';
  }
  if (['queued', 'pending', 'not_started', 'todo'].includes(status)) {
    return 'queued';
  }
  if (['done', 'complete', 'completed', 'approved', 'shipped', 'resolved'].includes(status)) {
    return 'done';
  }
  if (['stalled', 'stale', 'outdated'].includes(status)) {
    return 'stalled';
  }
  return status || 'idle';
}

function statusPriority(value: unknown): number {
  switch (normalizedStatus(value)) {
    case 'blocked':
      return 5;
    case 'stalled':
      return 4;
    case 'running':
      return 3;
    case 'queued':
      return 2;
    case 'done':
    case 'idle':
      return 1;
    default:
      return 0;
  }
}

function canonicalAgentKey(agent: Record<string, unknown>): string {
  const haystack = [
    asNonEmptyString(agent.agent_id),
    asNonEmptyString(agent.agent_name),
    asNonEmptyString(agent.role),
    asNonEmptyString(agent.agent_type),
    asNonEmptyString(agent.domain),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (haystack.includes('pace') || haystack.includes('product')) {
    return 'pace|product';
  }
  if (haystack.includes('eli') || haystack.includes('engineer')) {
    return 'eli|engineering';
  }
  if (haystack.includes('mark') || haystack.includes('market')) {
    return 'mark|marketing';
  }
  if (haystack.includes('sage') || haystack.includes('sale')) {
    return 'sage|sales';
  }
  if (haystack.includes('orion') || haystack.includes('operat')) {
    return 'orion|operations';
  }
  if (haystack.includes('dana') || haystack.includes('design')) {
    return 'dana|design';
  }
  if (haystack.includes('xandy') || haystack.includes('orchestr')) {
    return 'xandy|orchestrator';
  }

  return [
    asNonEmptyString(agent.agent_name)?.toLowerCase(),
    asNonEmptyString(agent.role)?.toLowerCase(),
    asNonEmptyString(agent.domain)?.toLowerCase(),
    asNonEmptyString(agent.agent_type)?.toLowerCase(),
    asNonEmptyString(agent.agent_id)?.toLowerCase(),
  ]
    .filter(Boolean)
    .join('|');
}

function mergeAgentRecords(
  agents: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();

  for (const agent of agents) {
    const derivedAgent = withDerivedTaskState(agent);
    const key = canonicalAgentKey(agent);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...derivedAgent,
        status: normalizedStatus(derivedAgent.status),
        blockers: uniqueByStableKey(asArray(derivedAgent.blockers)),
        tasks: uniqueByStableKey(asArray(derivedAgent.tasks)),
        current_tasks: uniqueByStableKey(asArray(derivedAgent.current_tasks)),
        active_tasks: uniqueByStableKey(asArray(derivedAgent.active_tasks)),
        artifacts: uniqueByStableKey(asArray(derivedAgent.artifacts)),
        completed_tasks: uniqueByStableKey(asArray(derivedAgent.completed_tasks)),
        completed_count: Number(derivedAgent.completed_count) || 0,
      });
      continue;
    }

    const incomingPriority = statusPriority(derivedAgent.status);
    const existingPriority = statusPriority(existing.status);

    merged.set(key, {
      ...existing,
      ...(incomingPriority > existingPriority ? { status: normalizedStatus(derivedAgent.status) } : {}),
      agent_id: asNonEmptyString(existing.agent_id) ?? asNonEmptyString(agent.agent_id),
      agent_name:
        asNonEmptyString(existing.agent_name) ?? asNonEmptyString(agent.agent_name),
      role: asNonEmptyString(existing.role) ?? asNonEmptyString(agent.role),
      domain: asNonEmptyString(existing.domain) ?? asNonEmptyString(agent.domain),
      agent_type:
        asNonEmptyString(existing.agent_type) ?? asNonEmptyString(agent.agent_type),
      current_task:
        incomingPriority > existingPriority
          ? asNonEmptyString(agent.current_task) ??
            asNonEmptyString(existing.current_task)
          : asNonEmptyString(existing.current_task) ??
            asNonEmptyString(agent.current_task),
      blockers: uniqueByStableKey([
        ...asArray(existing.blockers),
        ...asArray(agent.blockers),
      ]),
      tasks: uniqueByStableKey([...asArray(existing.tasks), ...asArray(agent.tasks)]),
      current_tasks: uniqueByStableKey([
        ...asArray(existing.current_tasks),
        ...asArray(agent.current_tasks),
      ]),
      active_tasks: uniqueByStableKey([
        ...asArray(existing.active_tasks),
        ...asArray(agent.active_tasks),
      ]),
      completed_tasks: uniqueByStableKey([
        ...asArray(existing.completed_tasks),
        ...asArray(derivedAgent.completed_tasks),
      ]),
      completed_count: Math.max(
        Number(existing.completed_count) || 0,
        Number(derivedAgent.completed_count) || 0
      ),
      artifacts: uniqueByStableKey([
        ...asArray(existing.artifacts),
        ...asArray(agent.artifacts),
      ]),
    });
  }

  return Array.from(merged.values());
}

function isVisibleAgent(agent: Record<string, unknown>): boolean {
  const id = asNonEmptyString(agent.agent_id) ?? '';
  const name = asNonEmptyString(agent.agent_name) ?? '';
  const haystack = `${id} ${name}`.toLowerCase();
  return (
    haystack !== 'chatgpt-app orgx chatgpt app' &&
    !haystack.includes('chatgpt-app') &&
    !haystack.includes('orgx chatgpt app')
  );
}

function countAgentsByStatus(
  agents: Array<Record<string, unknown>>,
  status: string
): number {
  return agents.filter(
    (agent) =>
      typeof agent.status === 'string' &&
      agent.status.trim().toLowerCase() === status
  ).length;
}


const ACTIVE_TASK_STATES = new Set([
  'running',
  'active',
  'executing',
  'in_progress',
  'claimed',
]);

const QUEUED_TASK_STATES = new Set(['queued', 'pending', 'not_started', 'todo']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function recordMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(record.metadata) ?? {};
}

function recordString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  return firstString(record, keys) ?? firstString(recordMetadata(record), keys);
}

function recordTimestamp(record: Record<string, unknown>): string | null {
  return recordString(record, [
    'last_heartbeat_at',
    'lastHeartbeatAt',
    'heartbeat_at',
    'heartbeatAt',
    'updated_at',
    'updatedAt',
    'completed_at',
    'completedAt',
    'created_at',
    'createdAt',
  ]);
}

function timestampMillis(record: Record<string, unknown>): number {
  const raw = recordTimestamp(record);
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function evidenceTokens(
  record: Record<string, unknown>,
  keys: string[]
): Set<string> {
  const metadata = recordMetadata(record);
  const tokens = new Set<string>();
  for (const key of keys) {
    const direct = asNonEmptyString(record[key]);
    const nested = asNonEmptyString(metadata[key]);
    if (direct) tokens.add(direct.toLowerCase());
    if (nested) tokens.add(nested.toLowerCase());
  }
  return tokens;
}

function agentIdentityTokens(agent: Record<string, unknown>): Set<string> {
  return evidenceTokens(agent, [
    'agent_id',
    'agentId',
    'agent_name',
    'agentName',
    'role',
    'domain',
    'agent_type',
    'agentType',
  ]);
}

function taskOwnerTokens(task: Record<string, unknown>): Set<string> {
  return evidenceTokens(task, [
    'agent_id',
    'agentId',
    'agent_name',
    'agentName',
    'assigned_agent_id',
    'assignedAgentId',
    'assigned_to',
    'assignedTo',
    'assignee',
    'owner_agent_id',
    'ownerAgentId',
    'domain',
  ]);
}

function artifactOwnerTokens(artifact: Record<string, unknown>): Set<string> {
  return evidenceTokens(artifact, [
    'agent_id',
    'agentId',
    'agent_name',
    'agentName',
    'created_by_id',
    'createdById',
    'created_by_name',
    'createdByName',
    'producer_id',
    'producerId',
    'domain',
  ]);
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

function durableTaskId(record: Record<string, unknown>): string | null {
  return recordString(record, ['task_id', 'taskId', 'id', 'entity_id', 'entityId']);
}

function artifactTaskId(record: Record<string, unknown>): string | null {
  const entityType = recordString(record, ['entity_type', 'entityType']);
  return (
    recordString(record, ['task_id', 'taskId']) ??
    (taskState(entityType) === 'task'
      ? recordString(record, ['entity_id', 'entityId'])
      : null)
  );
}

function matchesArtifact(
  artifact: Record<string, unknown>,
  identity: Set<string>,
  taskIds: Set<string>
): boolean {
  const artifactTask = artifactTaskId(artifact);
  return (
    (!!artifactTask && taskIds.has(artifactTask)) ||
    intersects(identity, artifactOwnerTokens(artifact))
  );
}

function newest(records: Record<string, unknown>[]): Record<string, unknown> | null {
  return (
    [...records].sort((left, right) => timestampMillis(right) - timestampMillis(left))[0] ??
    null
  );
}

function evidenceSnapshot(
  record: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!record) return null;
  return {
    id: recordString(record, ['id', 'artifact_id', 'artifactId']),
    title: recordString(record, ['title', 'name', 'label']),
    status: recordString(record, ['status', 'state']),
    task_id: artifactTaskId(record),
    run_id: recordString(record, ['run_id', 'runId']),
    job_id: recordString(record, ['job_id', 'jobId']),
    eval_score:
      asRecord(record.verification)?.eval &&
      typeof asRecord(asRecord(record.verification)?.eval)?.score === 'number'
        ? asRecord(asRecord(record.verification)?.eval)?.score
        : recordMetadata(record).eval_score ?? null,
    created_at: recordString(record, ['created_at', 'createdAt', 'updated_at', 'updatedAt']),
  };
}

/**
 * Reconcile the fleet summary with durable task and artifact evidence.
 *
 * Upstream persona rows are configuration records and may say "idle" while a
 * claimed job is running. The projection therefore prefers durable work
 * evidence, exposes its IDs, and uses "unknown" or "stalled" when freshness
 * cannot be proven. It never turns missing evidence into idle.
 */
export function enrichAgentStatusWithDurableEvidence(
  data: Record<string, unknown>,
  tasksInput: unknown[],
  artifactsInput: unknown[],
  now = Date.now()
): Record<string, unknown> {
  if (!Array.isArray(data.agents)) return data;

  const tasks = tasksInput
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const artifacts = artifactsInput
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));

  return {
    ...data,
    agents: data.agents.map((rawAgent) => {
      const agent = asRecord(rawAgent);
      if (!agent) return rawAgent;

      const identity = agentIdentityTokens(agent);
      const existingTasks = taskArrays(agent, [
        'current_tasks',
        'currentTasks',
        'active_tasks',
        'activeTasks',
        'tasks',
      ])
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => Boolean(item));
      const existingTaskIds = new Set(
        existingTasks.map(durableTaskId).filter((id): id is string => Boolean(id))
      );
      const matchedTasks = uniqueByStableKey([
        ...existingTasks,
        ...tasks.filter((task) => {
          const id = durableTaskId(task);
          return (
            (!!id && existingTaskIds.has(id)) ||
            intersects(identity, taskOwnerTokens(task))
          );
        }),
      ])
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => Boolean(item));

      const taskIds = new Set(
        matchedTasks.map(durableTaskId).filter((id): id is string => Boolean(id))
      );
      const matchedArtifacts = artifacts.filter((artifact) =>
        matchesArtifact(artifact, identity, taskIds)
      );
      const activeTasks = matchedTasks.filter((task) =>
        ACTIVE_TASK_STATES.has(
          taskState(task.status ?? task.state ?? task.phase)
        )
      );
      const queuedTasks = matchedTasks.filter((task) =>
        QUEUED_TASK_STATES.has(
          taskState(task.status ?? task.state ?? task.phase)
        )
      );
      const terminalTasks = matchedTasks.filter((task) =>
        TERMINAL_TASK_STATES.has(
          taskState(task.status ?? task.state ?? task.phase)
        )
      );

      const focusTask =
        newest(activeTasks) ?? newest(queuedTasks) ?? newest(terminalTasks);
      const latestArtifact = newest(matchedArtifacts);
      const heartbeat =
        (focusTask ? recordTimestamp(focusTask) : null) ??
        recordString(agent, ['last_heartbeat_at', 'lastHeartbeatAt']);
      const heartbeatMs = heartbeat ? Date.parse(heartbeat) : Number.NaN;
      const isFresh =
        Number.isFinite(heartbeatMs) && now - heartbeatMs <= 120_000;
      const hasActiveTask = activeTasks.length > 0;
      const hasTerminalEvidence =
        terminalTasks.length > 0 || matchedArtifacts.length > 0;
      const hasStateConflict = hasActiveTask && matchedArtifacts.length > 0;

      let status = normalizedStatus(agent.status);
      let activityState = status;
      let observabilityState = 'fresh';
      let staleReason: string | null = null;

      if (hasActiveTask) {
        if (!heartbeat || !Number.isFinite(heartbeatMs)) {
          status = 'unknown';
          activityState = 'unknown';
          observabilityState = 'unknown';
          staleReason = 'active_task_missing_freshness_evidence';
        } else if (!isFresh || hasStateConflict) {
          status = 'stalled';
          activityState = 'stalled';
          observabilityState = 'stale';
          staleReason = hasStateConflict
            ? 'active_task_conflicts_with_delivered_artifact'
            : 'active_task_heartbeat_stale';
        } else {
          status = 'running';
          activityState = 'active';
          observabilityState = 'fresh';
        }
      } else if (queuedTasks.length > 0) {
        status = 'queued';
        activityState = 'queued';
        observabilityState = heartbeat ? (isFresh ? 'fresh' : 'stale') : 'unknown';
        if (observabilityState !== 'fresh') {
          staleReason = heartbeat
            ? 'queued_task_update_stale'
            : 'queued_task_missing_freshness_evidence';
        }
      } else if (hasTerminalEvidence) {
        status = 'done';
        activityState = 'terminal';
        observabilityState = 'terminal';
      } else if (!asNonEmptyString(agent.status)) {
        status = 'unknown';
        activityState = 'unknown';
        observabilityState = 'unknown';
        staleReason = 'no_agent_or_durable_work_state';
      }

      const runId =
        (focusTask ? recordString(focusTask, ['run_id', 'runId']) : null) ??
        (latestArtifact
          ? recordString(latestArtifact, ['run_id', 'runId'])
          : null) ??
        recordString(agent, ['run_id', 'runId']);
      const jobId =
        (focusTask ? recordString(focusTask, ['job_id', 'jobId']) : null) ??
        (latestArtifact
          ? recordString(latestArtifact, ['job_id', 'jobId'])
          : null) ??
        recordString(agent, ['job_id', 'jobId']);

      return {
        ...agent,
        status,
        activity_state: activityState,
        observability_state: observabilityState,
        status_source:
          matchedTasks.length > 0
            ? 'durable_task'
            : matchedArtifacts.length > 0
              ? 'artifact'
              : 'agent_record',
        stale_reason: staleReason,
        reconciliation_required: hasStateConflict,
        task_id: focusTask ? durableTaskId(focusTask) : null,
        run_id: runId,
        job_id: jobId,
        last_heartbeat_at: heartbeat,
        current_tasks: activeTasks,
        active_tasks: activeTasks,
        completed_tasks: terminalTasks,
        artifacts: matchedArtifacts,
        artifact_count: matchedArtifacts.length,
        latest_artifact: evidenceSnapshot(latestArtifact),
      };
    }),
  };
}

export function normalizeAgentStatusPayload(
  data: Record<string, unknown>
): Record<string, unknown> {
  if (!Array.isArray(data.agents)) return data;

  const agents = mergeAgentRecords(
    data.agents.filter(
    (agent): agent is Record<string, unknown> =>
      !!agent && typeof agent === 'object' && isVisibleAgent(agent)
    )
  );

  const summary =
    data.summary && typeof data.summary === 'object' && !Array.isArray(data.summary)
      ? (data.summary as Record<string, unknown>)
      : {};

  const completed = agents.reduce(
    (total, agent) => total + (Number(agent.completed_count) || 0),
    0
  );

  return {
    ...data,
    agents,
    summary: {
      ...summary,
      total: agents.length,
      running: countAgentsByStatus(agents, 'running'),
      stalled: countAgentsByStatus(agents, 'stalled'),
      queued: countAgentsByStatus(agents, 'queued'),
      blocked: countAgentsByStatus(agents, 'blocked'),
      idle: countAgentsByStatus(agents, 'idle'),
      completed,
    },
  };
}
