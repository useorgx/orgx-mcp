function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
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

  const agents = data.agents.filter(
    (agent): agent is Record<string, unknown> =>
      !!agent && typeof agent === 'object' && isVisibleAgent(agent)
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
