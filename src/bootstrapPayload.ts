import {
  SERVER_MANIFEST_VERSION,
  V2_PUBLIC_SURFACE,
  resolveProfileToolSet,
  resolveToolProfile,
} from './toolProfiles';
import { isWidgetOnlyTool } from './widgetToolContract';

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
  const requestedInitiativeId = nonEmptyString(args.initiative_id);
  if (!requestedWorkspaceId && !requestedInitiativeId) {
    return { context: current, changed: false, requestedWorkspaceId: null };
  }

  const context: BootstrapSessionContext = { ...current };
  if (requestedWorkspaceId) {
    const workspaceChanged = current.workspaceId !== requestedWorkspaceId;
    context.workspaceId = requestedWorkspaceId;
    context.workspaceName =
      fetchedWorkspaceName ??
      (workspaceChanged ? undefined : current.workspaceName);
    if (workspaceChanged && !requestedInitiativeId) {
      delete context.initiativeId;
    }
  }
  if (requestedInitiativeId) {
    context.initiativeId = requestedInitiativeId;
  }

  return {
    context,
    changed:
      current.workspaceId !== context.workspaceId ||
      current.workspaceName !== context.workspaceName ||
      current.initiativeId !== context.initiativeId,
    requestedWorkspaceId,
  };
}

/**
 * The model an agent names at orgx_bootstrap, recorded once for the session so
 * orgx_submit_receipt can default to it. A bootstrap that names no model keeps
 * whatever the session already holds; naming a different one replaces it (and
 * drops a provider that belonged to the old model).
 */
export function resolveBootstrapSessionModel(
  args: Record<string, unknown>,
  current: { model?: string; modelProvider?: string }
): { model?: string; modelProvider?: string; changed: boolean } {
  const model = nonEmptyString(args.model)?.slice(0, 120);
  if (!model) {
    return { model: current.model, modelProvider: current.modelProvider, changed: false };
  }
  const given = nonEmptyString(args.model_provider)?.slice(0, 60);
  const modelProvider = given ?? (model === current.model ? current.modelProvider : undefined);
  return {
    model,
    ...(modelProvider ? { modelProvider } : {}),
    changed: model !== current.model || modelProvider !== current.modelProvider,
  };
}

export const V2_PUBLIC_TOOL_IDS = V2_PUBLIC_SURFACE;

const LEGACY_GUIDANCE_PROFILES = new Set(['legacy', 'full', 'claude-plugin', 'memory', 'commander', 'planner', 'executor', 'observer']);

export const LEGACY_BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE: Record<
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

export const LEGACY_BOOTSTRAP_RECOMMENDED_WORKFLOWS = {
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

/** Directory workflows use its operation-specific read/write contracts. */
export const LEGACY_CLAUDE_DIRECTORY_RECOMMENDED_WORKFLOWS = {
  plan_feature: [
    'orgx_bootstrap', 'orgx_read_plan', 'orgx_start_plan', 'orgx_improve_plan',
    'orgx_record_plan_edit', 'orgx_complete_plan', 'orgx_create_entity',
  ],
  scaffold_hierarchy: [
    'orgx_bootstrap', 'orgx_search', 'orgx_create_entity', 'orgx_inspect',
    'orgx_update_entity', 'orgx_submit_receipt',
  ],
  execute_task: [
    'orgx_bootstrap', 'orgx_search', 'orgx_inspect', 'check_execution_readiness',
    'orgx_check_delegation', 'orgx_delegate_work', 'get_agent_status',
    'orgx_attach', 'orgx_complete_with_proof', 'orgx_submit_receipt',
  ],
  record_decision: ['orgx_search', 'orgx_record_decision', 'orgx_inspect'],
  human_decision_review: ['orgx_list_pending_decisions', 'orgx_open_decision_review'],
  review_and_prove_work: [
    'review_artifact', 'orgx_attach', 'orgx_complete_with_proof', 'orgx_submit_receipt',
  ],
  control_execution: ['get_agent_status', 'manage_lifecycle', 'orgx_command_status'],
} as const;

const CURRENT_SAFE_FIRST_CALLS: BootstrapSafeFirstCall[] = [
  { tool: 'orgx_get_workspace_context', args: {} },
  { tool: 'orgx_get_operator_brief', args: { period: '30d' } },
  { tool: 'orgx_search', args: { type: 'initiative', limit: 10 } },
];

export const BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE: Record<string, BootstrapSafeFirstCall[]> = {
  v2: CURRENT_SAFE_FIRST_CALLS,
  chatgpt: CURRENT_SAFE_FIRST_CALLS,
  'claude-directory': CURRENT_SAFE_FIRST_CALLS,
  extended: CURRENT_SAFE_FIRST_CALLS,
  'read-only': CURRENT_SAFE_FIRST_CALLS.filter((call) => call.tool !== 'orgx_get_workspace_context'),
};

/** Ordered operation stages for the current host-independent workflow catalog. */
export const BOOTSTRAP_RECOMMENDED_WORKFLOWS = {
  plan_feature: [
    'orgx_get_workspace_context', 'orgx_read_plan', 'orgx_start_plan',
    'orgx_save_plan', 'orgx_record_plan_edit', 'orgx_complete_plan',
  ],
  scaffold_hierarchy: [
    'orgx_get_workspace_context', 'orgx_start_plan', 'orgx_save_plan',
    'orgx_validate_initiative_plan', 'orgx_create_initiative_hierarchy',
    'orgx_inspect', 'orgx_validate_work_receipt', 'orgx_submit_work_receipt',
  ],
  execute_task: [
    'orgx_get_workspace_context', 'orgx_search', 'orgx_inspect',
    'orgx_check_execution_readiness', 'orgx_estimate_agent_task',
    'orgx_start_agent_task', 'orgx_get_agent_status', 'orgx_get_operation_status',
    'orgx_attach_artifact', 'orgx_complete_work_with_proof',
    'orgx_validate_work_receipt', 'orgx_submit_work_receipt',
  ],
  record_decision: ['orgx_search', 'orgx_capture_decision', 'orgx_inspect'],
  human_decision_review: ['orgx_list_pending_decisions', 'orgx_open_decision_review'],
  review_and_prove_work: [
    'orgx_open_artifact_review', 'orgx_attach_artifact',
    'orgx_request_independent_artifact_review', 'orgx_complete_work_with_proof',
    'orgx_validate_work_receipt', 'orgx_submit_work_receipt', 'orgx_get_work_receipt',
  ],
  control_execution: [
    'orgx_get_agent_status', 'orgx_get_operation_status',
    'orgx_pause_work', 'orgx_resume_work', 'orgx_retry_work', 'orgx_cancel_work',
  ],
  preserve_work_receipt: [
    'orgx_validate_work_receipt', 'orgx_submit_work_receipt',
    'orgx_get_work_receipt', 'orgx_list_work_receipts', 'orgx_get_receipt_review_queue',
  ],
} as const;

/** Both directory and ChatGPT hosts use the same portable operation stages. */
export const CLAUDE_DIRECTORY_RECOMMENDED_WORKFLOWS = BOOTSTRAP_RECOMMENDED_WORKFLOWS;

function isVisibleCanonicalTool(
  tool: string,
  visibleTools: ReadonlySet<string> | null,
  profile?: string
): boolean {
  const inventory = resolveProfileToolSet(profile);
  return (
    !isWidgetOnlyTool(tool) &&
    (inventory === null || inventory.has(tool)) &&
    (visibleTools === null || visibleTools.has(tool))
  );
}

export function getBootstrapSafeFirstCalls(
  profile: string,
  visibleTools: ReadonlySet<string> | null = null
): BootstrapSafeFirstCall[] {
  const resolved = resolveToolProfile(profile).name;
  const legacy = LEGACY_GUIDANCE_PROFILES.has(resolved) || resolved === 'claude-directory-legacy';
  const source = legacy ? LEGACY_BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE : BOOTSTRAP_SAFE_FIRST_CALLS_BY_PROFILE;
  const calls = source[resolved] ?? source.v2;
  return calls.filter((call) => isVisibleCanonicalTool(call.tool, visibleTools, resolved));
}

export function getBootstrapRecommendedWorkflows(
  visibleTools: ReadonlySet<string> | null = null,
  profile?: string
): Record<string, string[]> {
  const resolved = resolveToolProfile(profile).name;
  const workflows = resolved === 'claude-directory-legacy'
    ? LEGACY_CLAUDE_DIRECTORY_RECOMMENDED_WORKFLOWS
    : LEGACY_GUIDANCE_PROFILES.has(resolved)
      ? LEGACY_BOOTSTRAP_RECOMMENDED_WORKFLOWS
      : BOOTSTRAP_RECOMMENDED_WORKFLOWS;
  return Object.fromEntries(
    Object.entries(workflows).map(([name, tools]) => [
      name,
      tools.filter((tool: string) => isVisibleCanonicalTool(tool, visibleTools, resolved)),
    ])
  );
}

export function buildBootstrapToolRouting(params: {
  requestedProfile?: string | null;
  /** Tools in this connection's tools/list that the model may call. */
  visibleTools: readonly string[];
  /**
   * Tools in this connection's tools/list that only widgets may call
   * (ui.visibility ["app"]). Reported separately so nothing the model cannot
   * call is ever advertised to it as callable.
   */
  widgetOnlyTools?: readonly string[];
}) {
  const resolved = resolveToolProfile(params.requestedProfile);
  const visibleTools = [...new Set(params.visibleTools)].sort();
  const visibleToolSet = new Set(visibleTools);
  const widgetOnlyTools = [...new Set(params.widgetOnlyTools ?? [])]
    .filter((tool) => !visibleToolSet.has(tool))
    .sort();

  return {
    profile: resolved.name,
    ...(resolved.requestedName ? { requested_profile: resolved.requestedName } : {}),
    profile_fallback: resolved.fellBack,
    manifest: {
      version: SERVER_MANIFEST_VERSION,
      public_profile: 'v2',
      // The fixed public manifest size is not what this connection can call;
      // reporting it beside visible_tools_count read as a discovery mismatch
      // (plan v3 A02). Agents get the effective set only.
      negotiated_profile: resolved.name,
      visible_tools_count: visibleTools.length,
    },
    safe_first_calls: getBootstrapSafeFirstCalls(
      resolved.name,
      visibleToolSet
    ),
    recommended_workflows: getBootstrapRecommendedWorkflows(visibleToolSet, resolved.name),
    visible_tools_count: visibleTools.length,
    visible_tools: visibleTools,
    // visible_tools + widget_only_tools is exactly this connection's tools/list.
    widget_only_tools: widgetOnlyTools,
    listed_tools_count: visibleTools.length + widgetOnlyTools.length,
  };
}
