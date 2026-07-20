import {
  SERVER_MANIFEST_VERSION,
  V2_CORE_PUBLIC_SURFACE,
  V2_PUBLIC_SURFACE,
  resolveToolProfile,
} from './toolProfiles';

export type BootstrapSafeFirstCall = {
  tool: string;
  args: Record<string, unknown>;
};

export type BootstrapSessionContext = {
  workspaceId?: string;
  workspaceName?: string;
  initiativeId?: string;
};

export type BootstrapWorkspaceCandidate = Record<string, unknown>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function pickBootstrapWorkspaceFallback(
  candidates: BootstrapWorkspaceCandidate[]
): Pick<BootstrapSessionContext, 'workspaceId' | 'workspaceName'> | null {
  const normalized = candidates
    .map((workspace) => {
      const workspaceId = nonEmptyString(workspace.id);
      if (!workspaceId) return null;
      return {
        workspaceId,
        workspaceName:
          nonEmptyString(workspace.name) ??
          nonEmptyString(workspace.title) ??
          undefined,
        isDefault:
          workspace.is_default === true || workspace.isDefault === true,
      };
    })
    .filter((workspace): workspace is {
      workspaceId: string;
      workspaceName: string | undefined;
      isDefault: boolean;
    } => Boolean(workspace));

  if (normalized.length === 0) return null;

  const defaults = normalized.filter((workspace) => workspace.isDefault);
  const selected =
    defaults.length === 1
      ? defaults[0]
      : defaults.length === 0 && normalized.length === 1
      ? normalized[0]
      : null;

  if (!selected) return null;
  return {
    workspaceId: selected.workspaceId,
    ...(selected.workspaceName ? { workspaceName: selected.workspaceName } : {}),
  };
}

export function resolveBootstrapSessionContext(
  args: Record<string, unknown>,
  current: BootstrapSessionContext,
  fetchedWorkspaceName?: string | null
): {
  context: BootstrapSessionContext;
  changed: boolean;
  requestedWorkspaceId: string | null;
} {
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

export const V2_PUBLIC_TOOL_IDS = V2_PUBLIC_SURFACE;

const CANONICAL_GUIDANCE_TOOL_IDS = new Set<string>(V2_CORE_PUBLIC_SURFACE);

export const BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE: Record<
  string,
  BootstrapSafeFirstCall[]
> = {
  memory: [
    {
      tool: 'orgx_search',
      args: { query: 'recent decisions', type: 'decision', limit: 10 },
    },
    { tool: 'orgx_recommend', args: { mode: 'morning_brief', period: '30d' } },
  ],
  commander: [
    { tool: 'orgx_recommend', args: { mode: 'morning_brief', period: '30d' } },
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
  ],
  planner: [
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
    { tool: 'orgx_search', args: { type: 'plan_session', status: 'active', limit: 10 } },
  ],
  executor: [
    { tool: 'orgx_search', args: { type: 'task', status: 'active', limit: 10 } },
    { tool: 'orgx_recommend', args: { mode: 'next_action', limit: 5 } },
  ],
  observer: [
    { tool: 'orgx_recommend', args: { mode: 'morning_brief', period: '30d' } },
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
  ],
  v2: [
    { tool: 'orgx_recommend', args: { mode: 'morning_brief', period: '30d' } },
    { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
  ],
  full: [
    { tool: 'orgx_recommend', args: { mode: 'morning_brief', period: '30d' } },
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
  scaffold_hierarchy: [
    'orgx_bootstrap',
    'orgx_plan',
    'orgx_write',
    'orgx_inspect',
    'orgx_search',
    'orgx_spawn',
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
    'orgx_act',
    'orgx_submit_receipt',
  ],
} as const;

function isVisibleCanonicalTool(
  tool: string,
  visibleTools: ReadonlySet<string> | null
): boolean {
  return (
    CANONICAL_GUIDANCE_TOOL_IDS.has(tool) &&
    (visibleTools === null || visibleTools.has(tool))
  );
}

export function getBootstrapSafeFirstCalls(
  profile: string,
  visibleTools: ReadonlySet<string> | null = null
): BootstrapSafeFirstCall[] {
  const calls =
    BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE[profile] ??
    BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE.v2;
  return calls.filter((call) => isVisibleCanonicalTool(call.tool, visibleTools));
}

export function getBootstrapRecommendedWorkflows(
  visibleTools: ReadonlySet<string> | null = null
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(BOOTSTRAP_RECOMMENDED_WORKFLOWS).map(([name, tools]) => [
      name,
      tools.filter((tool) => isVisibleCanonicalTool(tool, visibleTools)),
    ])
  );
}

export function buildBootstrapToolRouting(params: {
  requestedProfile?: string | null;
  visibleTools: readonly string[];
}) {
  const resolved = resolveToolProfile(params.requestedProfile);
  const visibleTools = [...new Set(params.visibleTools)].sort();
  const visibleToolSet = new Set(visibleTools);

  return {
    profile: resolved.name,
    ...(resolved.requestedName ? { requested_profile: resolved.requestedName } : {}),
    profile_fallback: resolved.fellBack,
    manifest: {
      version: SERVER_MANIFEST_VERSION,
      public_profile: 'v2',
      public_tools_count: V2_PUBLIC_TOOL_IDS.length,
      negotiated_profile: resolved.name,
      visible_tools_count: visibleTools.length,
    },
    safe_first_calls: getBootstrapSafeFirstCalls(
      resolved.name,
      visibleToolSet
    ),
    recommended_workflows: getBootstrapRecommendedWorkflows(visibleToolSet),
    visible_tools_count: visibleTools.length,
    visible_tools: visibleTools,
  };
}
