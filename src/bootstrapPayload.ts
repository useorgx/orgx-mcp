export type BootstrapSafeFirstCall = {
  tool: string;
  args: Record<string, unknown>;
};

export type BootstrapSessionContext = {
  workspaceId?: string;
  workspaceName?: string;
  initiativeId?: string;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function resolveBootstrapSessionContext(
  args: Record<string, unknown>,
  current: BootstrapSessionContext,
  fetchedWorkspaceName?: string | null
): { context: BootstrapSessionContext; changed: boolean; requestedWorkspaceId: string | null } {
  const requestedWorkspaceId =
    nonEmptyString(args.workspace_id) ?? nonEmptyString(args.command_center_id);
  if (!requestedWorkspaceId) {
    return { context: current, changed: false, requestedWorkspaceId: null };
  }

  const nextWorkspaceName =
    fetchedWorkspaceName ??
    (current.workspaceId === requestedWorkspaceId
      ? current.workspaceName
      : undefined);
  const context = {
    ...current,
    workspaceId: requestedWorkspaceId,
    workspaceName: nextWorkspaceName,
  };

  return {
    context,
    changed:
      current.workspaceId !== context.workspaceId ||
      current.workspaceName !== context.workspaceName,
    requestedWorkspaceId,
  };
}

export const V2_PUBLIC_TOOL_IDS = [
  'orgx_act',
  'orgx_attach',
  'orgx_bootstrap',
  'orgx_decide',
  'orgx_emit_activity',
  'orgx_emit_execution_graph',
  'orgx_inspect',
  'orgx_plan',
  'orgx_recommend',
  'orgx_search',
  'orgx_spawn',
  'orgx_submit_receipt',
  'orgx_write',
  'approve_decision',
  'reject_decision',
  'get_agent_status',
  'get_initiative_pulse',
  'scaffold_initiative',
  'spawn_agent_task',
  'handoff_task',
  'recommend_next_action',
  'query_org_memory',
  'recall_memory',
  'approve_agent_work',
  'delegate_agent_task',
  'track_project_progress',
  'review_artifact',
  'get_morning_brief',
  'get_operator_chronicle',
  'check_execution_readiness',
  'consolidate_pr',
] as const;

export const BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE: Record<
  string,
  BootstrapSafeFirstCall[]
> = {
  memory: [
    {
      tool: 'orgx_search',
      args: { query: 'recent decisions', type: 'decision', limit: 10 },
    },
    { tool: 'get_operator_chronicle', args: { period: '30d' } },
  ],
  commander: [
    { tool: 'get_operator_chronicle', args: { period: '30d' } },
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
  ],
  planner: [
    { tool: 'orgx_plan', args: { action: 'resume' } },
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
  ],
  executor: [
    { tool: 'orgx_search', args: { type: 'task', status: 'active', limit: 10 } },
    { tool: 'orgx_recommend', args: { mode: 'next_action', limit: 5 } },
  ],
  observer: [
    { tool: 'get_operator_chronicle', args: { period: '30d' } },
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
  ],
  full: [
    { tool: 'get_operator_chronicle', args: { period: '30d' } },
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
  ],
};

export const BOOTSTRAP_RECOMMENDED_WORKFLOWS = {
  plan_feature: [
    'orgx_bootstrap',
    'orgx_plan',
    'orgx_write',
    'orgx_act',
    'orgx_submit_receipt',
  ],
  execute_task: [
    'orgx_bootstrap',
    'orgx_search',
    'orgx_inspect',
    'orgx_spawn',
    'orgx_emit_activity',
    'orgx_emit_execution_graph',
    'orgx_attach',
    'consolidate_pr',
    'orgx_act',
    'orgx_submit_receipt',
  ],
} as const;

export function getBootstrapSafeFirstCalls(profile: string) {
  return (
    BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE[profile] ??
    BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE.full
  );
}
