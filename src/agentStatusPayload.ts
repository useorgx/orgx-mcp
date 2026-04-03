function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
  return status || 'idle';
}

function statusPriority(value: unknown): number {
  switch (normalizedStatus(value)) {
    case 'running':
      return 4;
    case 'blocked':
      return 3;
    case 'queued':
      return 2;
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
    const key = canonicalAgentKey(agent);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...agent,
        status: normalizedStatus(agent.status),
        blockers: uniqueByStableKey(asArray(agent.blockers)),
        tasks: uniqueByStableKey(asArray(agent.tasks)),
        current_tasks: uniqueByStableKey(asArray(agent.current_tasks)),
        active_tasks: uniqueByStableKey(asArray(agent.active_tasks)),
        artifacts: uniqueByStableKey(asArray(agent.artifacts)),
      });
      continue;
    }

    const incomingPriority = statusPriority(agent.status);
    const existingPriority = statusPriority(existing.status);

    merged.set(key, {
      ...existing,
      ...(incomingPriority > existingPriority ? { status: normalizedStatus(agent.status) } : {}),
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

  return {
    ...data,
    agents,
    summary: {
      ...summary,
      total: agents.length,
      running: countAgentsByStatus(agents, 'running'),
      queued: countAgentsByStatus(agents, 'queued'),
      blocked: countAgentsByStatus(agents, 'blocked'),
      idle: countAgentsByStatus(agents, 'idle'),
    },
  };
}
