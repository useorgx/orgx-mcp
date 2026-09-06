/** Canonical task fields shared by the app status response and entity enrichment. */
function projectTask(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const task = value as Record<string, unknown>;
  return {
    ...task,
    task_id: task.task_id ?? task.taskId ?? task.id,
    title: task.title ?? task.name,
    status: task.status ?? task.state ?? null,
    priority: task.priority ?? null,
    initiative_id: task.initiative_id ?? task.initiativeId ?? null,
    workstream_id: task.workstream_id ?? task.workstreamId ?? null,
    milestone_id: task.milestone_id ?? task.milestoneId ?? null,
    updated_at: task.updated_at ?? task.updatedAt ?? null,
    blocker: task.blocker ?? null,
  };
}

export function projectAgentStatusTasks(
  agent: Record<string, unknown>
): Record<string, unknown> {
  const projected = { ...agent };
  for (const field of ['tasks', 'current_tasks', 'active_tasks', 'completed_tasks']) {
    if (Array.isArray(agent[field])) {
      projected[field] = (agent[field] as unknown[]).map(projectTask);
    }
  }
  return projected;
}
