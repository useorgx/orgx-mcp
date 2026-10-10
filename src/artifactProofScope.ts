type RecordValue = Record<string, unknown>;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

/** The persisted response scope wins over request/session hints. No metadata adds scope. */
export function artifactProofScope(input: {
  toolId: string;
  args: RecordValue;
  data: RecordValue;
  sessionWorkspaceId?: string | null;
  sessionInitiativeId?: string | null;
}): { workspaceId: string | null; initiativeIds: string[] } {
  const workspaceId = text(input.args.workspace_id) ?? input.sessionWorkspaceId ?? null;
  const direct = text(input.data.initiative_id) ??
    (input.toolId === 'get_initiative_pulse' ? text(input.data.id) : null) ??
    text(input.args.initiative_id) ?? input.sessionInitiativeId ?? null;
  const ids = new Set<string>(direct ? [direct] : []);
  if (Array.isArray(input.data.agents)) {
    for (const raw of input.data.agents) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const agent = raw as RecordValue;
      for (const value of [agent.initiative_id, agent.initiativeId, agent.workspace_initiative_id]) {
        const id = text(value);
        if (id) ids.add(id);
      }
      for (const values of [agent.current_tasks, agent.currentTasks, agent.active_tasks, agent.activeTasks, agent.tasks, agent.items]) {
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const task = value as RecordValue;
          const id = text(task.initiative_id) ?? text(task.initiativeId);
          if (id) ids.add(id);
        }
      }
    }
  }
  return { workspaceId, initiativeIds: [...ids] };
}
