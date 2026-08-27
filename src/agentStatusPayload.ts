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
