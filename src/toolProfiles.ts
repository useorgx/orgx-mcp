/**
 * Tool Profiles — Subagent Isolation
 *
 * Defines the client-facing MCP discovery subsets negotiated through the
 * connection URL. This is distinct from the OrgX app's internal per-assignment
 * runtime manifest: one controls `tools/list`, the other controls what a
 * dispatched agent may execute after assignment.
 *
 * Narrow profiles reduce schema tokens injected per connection by 50-72%.
 *
 * Usage: pass ?profile=executor on the connection URL:
 *   wss://mcp.useorgx.com/sse?profile=executor
 *
 * Default is 'v2' — the compact public surface. Use profile=full only for
 * admin/debug compatibility sessions.
 */

import serverManifest from '../server.json';
import { CLAUDE_DIRECTORY_ADAPTER_IDS } from './claudeDirectoryTools';
import { WORKFLOW_TOOL_IDS, EXTENDED_WORKFLOW_TOOL_IDS } from './workflowTools';
import { RECEIPT_OPERATION_TOOLS } from './receiptOperationTools';
import { WIDGET_ONLY_TOOL_IDS } from './widgetToolContract';

export interface ToolProfile {
  /** Human-readable profile purpose */
  description: string;
  /** Tool IDs to register, or null for all tools */
  tools: string[] | null;
}

export const DEFAULT_TOOL_PROFILE = 'v2' as const;
export const SERVER_MANIFEST_VERSION = serverManifest.version;

/**
 * The checked-in server manifest is the public discovery contract. Keep the
 * exact order so tools/list, bootstrap, directory metadata, and public
 * discovery all describe the same surface.
 */
export const LEGACY_V2_PUBLIC_SURFACE = [
  "orgx_bootstrap",
  "orgx_tail",
  "orgx_search",
  "orgx_inspect",
  "orgx_controller_status",
  "orgx_recommend",
  "orgx_write",
  "orgx_attach",
  "orgx_act",
  "manage_lifecycle",
  "orgx_plan",
  "orgx_spawn",
  "orgx_decide",
  "orgx_expect",
  "orgx_submit_receipt",
  "orgx_emit_activity",
  "orgx_request_attention",
  "orgx_poll_attention",
  "orgx_ack_attention",
  "orgx_request_question",
  "orgx_poll_question",
  "orgx_emit_execution_graph",
  "approve_decision",
  "reject_decision",
  "orgx_widget_decide",
  "orgx_command_status",
  "orgx_panel_snapshot",
  "orgx_widget_receipt_call",
  "get_agent_status",
  "get_initiative_pulse",
  "scaffold_initiative",
  "spawn_agent_task",
  "handoff_task",
  "recommend_next_action",
  "query_org_memory",
  "recall_memory",
  "approve_agent_work",
  "delegate_agent_task",
  "track_project_progress",
  "review_artifact",
  "get_morning_brief",
  "get_operator_chronicle",
  "check_execution_readiness",
  "consolidate_pr",
  "request_independent_artifact_review",
  "resume_agent_run"
] as const;

export const LEGACY_V2_CORE_PUBLIC_SURFACE = [
  'orgx_bootstrap',
  'orgx_search',
  'orgx_inspect',
  'orgx_controller_status',
  'orgx_recommend',
  'orgx_write',
  'orgx_attach',
  'orgx_act',
  'manage_lifecycle',
  'orgx_plan',
  'orgx_spawn',
  'orgx_decide',
  'orgx_expect',
  'orgx_submit_receipt',
  'orgx_emit_activity',
  'orgx_request_attention',
  'orgx_poll_attention',
  'orgx_ack_attention',
  'orgx_request_question',
  'orgx_poll_question',
  'orgx_emit_execution_graph',
] as const;

export const LEGACY_WIDGET_AFFORDANCE_SURFACE = [
  'approve_decision',
  'reject_decision',
  'orgx_widget_decide',
  'orgx_command_status',
  'orgx_panel_snapshot',
  'orgx_widget_receipt_call',
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
  'resume_agent_run',
] as const;

export const CLIENT_INTEGRATION_PUBLIC_SURFACE = [
  'check_execution_readiness',
  'consolidate_pr',
] as const;
export const CLIENT_REPORTING_PUBLIC_SURFACE = [
  'get_operator_chronicle',
] as const;

/**
 * Reviewer-facing ChatGPT App surface.
 *
 * Keep this intentionally smaller than the general v2 catalog. ChatGPT should
 * see the canonical OrgX workflow plus user-facing widgets, not internal
 * activity/attention transports, duplicate compatibility aliases, or
 * client-specific GitHub orchestration such as consolidate_pr.
 */
export const LEGACY_CHATGPT_PUBLIC_SURFACE = [
  'orgx_bootstrap',
  'orgx_search',
  'orgx_inspect',
  'orgx_recommend',
  'orgx_write',
  'orgx_attach',
  'orgx_act',
  'manage_lifecycle',
  'orgx_plan',
  'orgx_spawn',
  'orgx_decide',
  'orgx_submit_receipt',
  'approve_decision',
  'reject_decision',
  'orgx_widget_decide',
  'orgx_command_status',
  'orgx_panel_snapshot',
  'orgx_widget_receipt_call',
  'get_agent_status',
  'get_initiative_pulse',
  'scaffold_initiative',
  'handoff_task',
  'approve_agent_work',
  'review_artifact',
  'get_morning_brief',
  'get_operator_chronicle',
  'check_execution_readiness',
  // Widget-only (ui.visibility ["app"]): the agent-status widget's Resume
  // button. See src/widgetToolContract.ts.
  'resume_agent_run',
] as const;

/**
 * Stable informational baseline shared by the fail-closed fallback and the
 * Claude Code plugin. Directory expansion must not widen either profile.
 */
export const LEGACY_INFORMATIONAL_SURFACE = [
  'orgx_search',
  'orgx_inspect',
  'orgx_recommend',
  'get_agent_status',
  'get_initiative_pulse',
  'get_morning_brief',
  'get_operator_chronicle',
] as const;

export const INFORMATIONAL_SURFACE = [
  'orgx_search',
  'orgx_inspect',
  'orgx_get_next_actions',
  'orgx_get_agent_status',
  'orgx_get_initiative_progress',
  'orgx_get_operator_brief',
  'orgx_get_operation_status',
] as const;

/**
 * Anthropic directory workflows. Read and write branches of canonical routers
 * are exposed through operation-specific adapters. Compatibility aliases and
 * internal coordination transports stay outside the model-facing inventory.
 */
export const LEGACY_CLAUDE_DIRECTORY_SURFACE = [
  ...LEGACY_INFORMATIONAL_SURFACE,
  'orgx_bootstrap',
  'check_execution_readiness',
  'orgx_command_status',
  'review_artifact',
  'orgx_attach',
  'orgx_submit_receipt',
  'manage_lifecycle',
  ...CLAUDE_DIRECTORY_ADAPTER_IDS,
  // Human Resume button only; hidden from model discovery.
  'resume_agent_run',
] as const;

/**
 * Claude Code plugin surface: the stable informational set plus the lean write set
 * the plugin needs to report real work (activity, receipts, artifacts,
 * decisions) and bind a session via bootstrap. This profile keeps normal
 * session persistence and telemetry.
 */
export const CLAUDE_PLUGIN_SURFACE = [
  ...LEGACY_INFORMATIONAL_SURFACE,
  'orgx_command_status',
  'orgx_controller_status',
  'orgx_emit_activity',
  'orgx_submit_receipt',
  'orgx_attach',
  'orgx_decide',
  'orgx_expect',
  'orgx_bootstrap',
  'orgx_tail',
] as const;

/**
 * Fail-closed fallback for unknown profile names. Seven informational tools,
 * WITHOUT the directory profile's
 * review-mode side effects (suppressed session persistence and telemetry),
 * so misconfigured clients stay attributable while gaining no write access.
 */
export const READ_ONLY_FALLBACK_PROFILE = 'read-only' as const;

/** Default model operations: 35 workflow operations and five portable receipt operations. */
export const V2_CORE_PUBLIC_SURFACE = [
  ...WORKFLOW_TOOL_IDS,
  ...RECEIPT_OPERATION_TOOLS.map((tool) => tool.id),
] as const;

/** Shared card callbacks: operation-specific tools plus private human interactions. */
export const WIDGET_AFFORDANCE_SURFACE = [
  'orgx_record_plan_edit',
  ...WIDGET_ONLY_TOOL_IDS,
] as const;

export const CHATGPT_PUBLIC_SURFACE = [
  ...V2_CORE_PUBLIC_SURFACE,
  ...WIDGET_AFFORDANCE_SURFACE,
] as const;
export const CLAUDE_DIRECTORY_SURFACE = [...CHATGPT_PUBLIC_SURFACE] as const;
export const V2_PUBLIC_SURFACE = [...CHATGPT_PUBLIC_SURFACE];
export const GROUPED_V2_PUBLIC_SURFACE = [...V2_PUBLIC_SURFACE] as const;
export const EXTENDED_PUBLIC_SURFACE = [...new Set([
  ...V2_PUBLIC_SURFACE,
  ...EXTENDED_WORKFLOW_TOOL_IDS,
])];

/** Complete read and click dependencies of widgets served by older profiles. */
const WIDGET_OPERATION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  orgx_get_workspace_context: ['orgx_get_initiative_progress'],
  orgx_get_agent_status: ['orgx_get_operation_status', 'resume_agent_run'],
  orgx_get_operator_brief: ['orgx_get_agent_status'],
  orgx_list_pending_decisions: ['orgx_get_operation_status', 'orgx_widget_decide'],
  orgx_open_decision_review: ['orgx_list_pending_decisions', 'orgx_get_operation_status', 'orgx_widget_decide'],
  orgx_create_initiative_hierarchy: ['orgx_launch_initiative', 'orgx_get_operation_status', 'orgx_widget_decide', 'orgx_get_initiative_progress'],
  orgx_start_agent_task: ['orgx_get_agent_status', 'orgx_get_operation_status'],
  orgx_handoff_task: ['orgx_get_agent_status', 'orgx_get_operation_status'],
  orgx_open_artifact_review: ['orgx_get_operation_status', 'orgx_widget_approve_artifact', 'orgx_widget_request_artifact_changes'],
  orgx_save_plan: ['orgx_record_plan_edit', 'orgx_get_operation_status'],

  orgx_bootstrap: ['orgx_get_workspace_context', 'orgx_get_initiative_progress'],
  orgx_inspect: ['orgx_get_operation_status', 'orgx_get_agent_status'],
  get_agent_status: ['orgx_get_agent_status', 'orgx_get_operation_status', 'resume_agent_run'],
  get_initiative_pulse: ['orgx_get_initiative_progress'],
  get_operator_chronicle: ['orgx_get_operator_brief', 'orgx_get_agent_status'],
  orgx_decide: ['orgx_list_pending_decisions', 'orgx_get_operation_status', 'orgx_widget_decide'],
  get_pending_decisions: ['orgx_list_pending_decisions', 'orgx_get_operation_status', 'orgx_widget_decide'],
  approve_agent_work: ['orgx_list_pending_decisions', 'orgx_get_operation_status', 'orgx_widget_decide'],
  approve_decision: ['orgx_list_pending_decisions', 'orgx_get_operation_status', 'orgx_widget_decide'],
  reject_decision: ['orgx_list_pending_decisions', 'orgx_get_operation_status', 'orgx_widget_decide'],
  orgx_plan: ['orgx_record_plan_edit', 'orgx_get_operation_status'],
  orgx_start_plan: ['orgx_record_plan_edit', 'orgx_get_operation_status'],
  orgx_read_plan: ['orgx_record_plan_edit', 'orgx_get_operation_status'],
  orgx_improve_plan: ['orgx_record_plan_edit', 'orgx_get_operation_status'],
  orgx_record_plan_edit: ['orgx_get_operation_status'],
  orgx_complete_plan: ['orgx_record_plan_edit', 'orgx_get_operation_status'],
  scaffold_initiative: ['orgx_launch_initiative', 'orgx_get_operation_status', 'orgx_widget_decide', 'orgx_get_initiative_progress'],
  orgx_spawn: ['orgx_get_agent_status', 'orgx_get_operation_status'],
  spawn_agent_task: ['orgx_get_agent_status', 'orgx_get_operation_status'],
  delegate_agent_task: ['orgx_get_agent_status', 'orgx_get_operation_status'],
  orgx_delegate_agent_task: ['orgx_get_agent_status', 'orgx_get_operation_status'],
  review_artifact: ['orgx_get_operation_status', 'orgx_widget_approve_artifact', 'orgx_widget_request_artifact_changes'],
  orgx_panel_snapshot: ['orgx_get_operation_status', 'orgx_get_work_receipt', 'orgx_list_work_receipts', 'orgx_widget_decide', 'orgx_widget_receipt_call', 'orgx_widget_select_workspace'],
};
function withWidgetDependencies(toolIds: readonly string[]): string[] {
  const result = new Set(toolIds);
  for (const toolId of result) {
    for (const dependency of WIDGET_OPERATION_DEPENDENCIES[toolId] ?? []) result.add(dependency);
  }
  return [...result];
}

export const TOOL_PROFILES: Record<string, ToolProfile> = {
  v2: {
    description:
      'Explicit OrgX workflow and portable receipt operations, with private human widget interactions and no public action routers',
    tools: [...V2_PUBLIC_SURFACE],
  },
  legacy: {
    description: 'Explicit compatibility profile for clients that still call legacy OrgX action routers and aliases. Migrate to the default operation catalog.',
    tools: withWidgetDependencies([...LEGACY_V2_PUBLIC_SURFACE, ...LEGACY_CHATGPT_PUBLIC_SURFACE]),
  },
  extended: {
    description: 'Explicit default operations plus specialist work transitions, plan critique, delegation checks and administrative actions. Every operation has its own schema.',
    tools: [...EXTENDED_PUBLIC_SURFACE],
  },
  chatgpt: {
    description:
      'ChatGPT workflow and portable receipt operations. Each model-facing tool performs one declared operation; private widget tools record human decisions with review authority',
    tools: [...CHATGPT_PUBLIC_SURFACE],
  },
  'claude-directory': {
    description:
      'Anthropic Connector Directory workflows: information retrieval, durable planning, entity creation and updates, bounded delegation, human decision review, linked artifacts, proof receipts, and lifecycle control with separate read and write operations',
    tools: [...CLAUDE_DIRECTORY_SURFACE],
  },
  'claude-directory-legacy': {
    description: 'Compatibility inventory for older Anthropic directory clients, including their current widget read and human-action dependencies. New connections use the shared fixed operation catalog.',
    tools: withWidgetDependencies([...LEGACY_CLAUDE_DIRECTORY_SURFACE]),
  },
  'claude-plugin': {
    description:
      'Claude Code plugin surface: the informational read set plus lean writes for activity, receipts, artifact attach, decisions, and session bootstrap',
    tools: [...CLAUDE_PLUGIN_SURFACE],
  },
  'claude-code-legacy': {
    description: 'Compatibility for the seven-tool informational Claude Code package. Preserves its declared permissions and response contracts without adding reporting or widget actions.',
    tools: [...LEGACY_INFORMATIONAL_SURFACE],
  },
  [READ_ONLY_FALLBACK_PROFILE]: {
    description:
      'Most restrictive read-only surface. Unknown profile names fail closed here so a typo never widens tool access',
    tools: [...INFORMATIONAL_SURFACE],
  },
  memory: {
    description:
      'Shared organizational memory: decisions, artifacts, pending approvals, task context, and project progress',
    tools: [
      'orgx_bootstrap',
      'orgx_search',
      'orgx_inspect',
      'orgx_decide',
      'orgx_expect',
      'orgx_recommend',
      'orgx_attach',
      'orgx_submit_receipt',
    ],
  },
  commander: {
    description:
      'Human operators: bootstrap, search, inspect, recommend, write, act, attach, plan, spawn, decide, and submit receipts',
    tools: [
      'orgx_bootstrap',
      'orgx_search',
      'orgx_inspect',
      'orgx_command_status',
      'orgx_recommend',
      'orgx_write',
      'orgx_attach',
      'orgx_act',
      'orgx_plan',
      'orgx_spawn',
      'orgx_decide',
      'orgx_expect',
      'orgx_request_attention',
      'orgx_poll_attention',
      'orgx_ack_attention',
      'orgx_request_question',
      'orgx_poll_question',
      'orgx_emit_execution_graph',
      'orgx_submit_receipt',
      'orgx_create_work',
      'orgx_complete_work',
      'orgx_events_tail',
      'orgx_tail',
      'check_execution_readiness',
      'scaffold_initiative',
      'consolidate_pr',
      'get_operator_chronicle',
    ],
  },
  planner: {
    description:
      'Planning: create initiatives, scaffold hierarchies, plan sessions',
    tools: [
      'orgx_bootstrap',
      'orgx_plan',
      'orgx_write',
      'orgx_act',
      'orgx_search',
      'orgx_inspect',
      'orgx_command_status',
      'orgx_decide',
      'orgx_expect',
      'orgx_request_attention',
      'orgx_poll_attention',
      'orgx_request_question',
      'orgx_poll_question',
      'scaffold_initiative',
    ],
  },
  executor: {
    description: 'Agent execution: progress reporting, changesets, spawning',
    tools: [
      'orgx_bootstrap',
      'orgx_emit_activity',
      'orgx_request_attention',
      'orgx_poll_attention',
      'orgx_ack_attention',
      'orgx_request_question',
      'orgx_poll_question',
      'orgx_emit_execution_graph',
      'orgx_search',
      'orgx_inspect',
      'orgx_command_status',
      'orgx_write',
      'orgx_attach',
      'orgx_act',
      'orgx_plan',
      'orgx_spawn',
      'orgx_expect',
      'check_execution_readiness',
      'orgx_submit_receipt',
      'orgx_create_work',
      'orgx_complete_work',
      'orgx_events_tail',
      'orgx_tail',
      'consolidate_pr',
      'orgx_lease',
    ],
  },
  observer: {
    description:
      'Read-only monitoring and reporting with bootstrap, search, inspect, recommend, plan, and decisions',
    tools: [
      'orgx_bootstrap',
      'orgx_search',
      'orgx_inspect',
      'orgx_command_status',
      'orgx_recommend',
      'orgx_plan',
      'orgx_decide',
      'orgx_poll_attention',
      'orgx_poll_question',
      'orgx_events_tail',
      'orgx_tail',
      'get_operator_chronicle',
    ],
  },
  full: {
    description: 'All tools for admin/debug compatibility sessions',
    tools: null,
  },
};

for (const [name, profile] of Object.entries(TOOL_PROFILES)) {
  if (name === READ_ONLY_FALLBACK_PROFILE || name === 'claude-plugin' || name === 'claude-code-legacy' || profile.tools === null) continue;
  profile.tools = withWidgetDependencies(profile.tools);
}

export const TOOL_PROFILE_NAMES = Object.freeze(Object.keys(TOOL_PROFILES));

export interface ResolvedToolProfile {
  /** Effective profile after applying the fail-closed fallback. */
  name: string;
  /** Non-empty profile requested by the client, when one was supplied. */
  requestedName: string | null;
  /** True when an unknown profile was reduced to the read-only fallback. */
  fellBack: boolean;
  /** null is reserved for an explicit full/admin connection. */
  tools: Set<string> | null;
}

/**
 * Resolve profile negotiation once and retain the effective profile name.
 * Missing names default to the compact v2 surface; UNKNOWN names fail closed
 * to the most restrictive read-only fallback so a typo never grants write
 * access. Only an explicit `full` request receives the compatibility/admin
 * catalog.
 */
export function resolveToolProfile(
  profileName: string | undefined | null
): ResolvedToolProfile {
  const requestedName =
    typeof profileName === 'string' && profileName.trim().length > 0
      ? profileName.trim()
      : null;
  const effectiveName = !requestedName
    ? DEFAULT_TOOL_PROFILE
    : TOOL_PROFILES[requestedName]
      ? requestedName
      : READ_ONLY_FALLBACK_PROFILE;
  const profile = TOOL_PROFILES[effectiveName] ?? TOOL_PROFILES.v2;

  if (requestedName && requestedName !== effectiveName) {
    console.warn(
      '[mcp:profiles] Unknown tool profile; failing closed to read-only surface',
      { requested: requestedName, effective: effectiveName }
    );
  }

  return {
    name: effectiveName,
    requestedName,
    fellBack: requestedName !== null && requestedName !== effectiveName,
    tools: profile.tools === null ? null : new Set(profile.tools),
  };
}

/**
 * Resolve a profile name to a Set of allowed tool IDs.
 * Returns null if the profile is "full" (all tools allowed).
 *
 * This compatibility helper remains the public resolver used by discovery
 * snapshots and integrations that only need the allowed ID set.
 */
export function resolveProfileToolSet(
  profileName: string | undefined | null
): Set<string> | null {
  return resolveToolProfile(profileName).tools;
}
