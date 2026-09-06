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
      const rows: unknown[] = [];
      const positions = new Map<string, number>();
      for (const value of agent[field] as unknown[]) {
        const task = projectTask(value);
        const record = task && typeof task === 'object'
          ? task as Record<string, unknown> : null;
        const id = typeof record?.task_id === 'string' ? record.task_id : null;
        const position = id ? positions.get(id) : undefined;
        if (position === undefined) {
          if (id) positions.set(id, rows.length);
          rows.push(task);
        } else {
          const previous = rows[position] as Record<string, unknown>;
          const before = Date.parse(String(previous.updated_at ?? ''));
          const after = Date.parse(String(record?.updated_at ?? ''));
          // Enrichment may return the same entity in app and database shapes.
          // Keep its position stable and prefer the newest observed version.
          if (!Number.isFinite(before) || (Number.isFinite(after) && after >= before)) {
            rows[position] = task;
          }
        }
      }
      projected[field] = rows;
    }
  }
  return projected;
}
