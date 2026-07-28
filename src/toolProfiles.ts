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
export const V2_PUBLIC_SURFACE = serverManifest.tools.map((tool) => tool.name);

export const V2_CORE_PUBLIC_SURFACE = [
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
  'orgx_emit_activity',
  'orgx_request_attention',
  'orgx_poll_attention',
  'orgx_ack_attention',
  'orgx_request_question',
  'orgx_poll_question',
  'orgx_emit_execution_graph',
] as const;

export const WIDGET_AFFORDANCE_SURFACE = [
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
export const CHATGPT_PUBLIC_SURFACE = [
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
  'get_agent_status',
  'get_initiative_pulse',
  'scaffold_initiative',
  'handoff_task',
  'approve_agent_work',
  'review_artifact',
  'get_morning_brief',
  'get_operator_chronicle',
  'check_execution_readiness',
] as const;

export const GROUPED_V2_PUBLIC_SURFACE = [
  ...V2_PUBLIC_SURFACE,
] as const;

export const TOOL_PROFILES: Record<string, ToolProfile> = {
  v2: {
    description:
      'OrgX MCP v2 public surface plus direct widget affordances for decisions, agent status, initiative pulse, scaffold, artifacts, memory search, morning brief, and task delegation',
    tools: [...V2_PUBLIC_SURFACE],
  },
  chatgpt: {
    description:
      'Reviewer-ready ChatGPT App surface: canonical OrgX workflows and user-facing widgets without internal coordination transports, redundant aliases, or client-specific PR consolidation',
    tools: [...CHATGPT_PUBLIC_SURFACE],
  },
  memory: {
    description:
      'Shared organizational memory: decisions, artifacts, pending approvals, task context, and project progress',
    tools: [
      'orgx_bootstrap',
      'orgx_search',
      'orgx_inspect',
      'orgx_decide',
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
      'orgx_recommend',
      'orgx_write',
      'orgx_attach',
      'orgx_act',
      'orgx_plan',
      'orgx_spawn',
      'orgx_decide',
      'orgx_request_attention',
      'orgx_poll_attention',
      'orgx_ack_attention',
      'orgx_request_question',
      'orgx_poll_question',
      'orgx_emit_execution_graph',
      'orgx_submit_receipt',
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
      'orgx_decide',
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
      'orgx_write',
      'orgx_attach',
      'orgx_act',
      'orgx_plan',
      'orgx_spawn',
      'check_execution_readiness',
      'orgx_submit_receipt',
      'consolidate_pr',
    ],
  },
  observer: {
    description:
      'Read-only monitoring and reporting with bootstrap, search, inspect, recommend, plan, and decisions',
    tools: [
      'orgx_bootstrap',
      'orgx_search',
      'orgx_inspect',
      'orgx_recommend',
      'orgx_plan',
      'orgx_decide',
      'orgx_poll_attention',
      'orgx_poll_question',
      'get_operator_chronicle',
    ],
  },
  full: {
    description: 'All tools for admin/debug compatibility sessions',
    tools: null,
  },
};

export const TOOL_PROFILE_NAMES = Object.freeze(Object.keys(TOOL_PROFILES));

export interface ResolvedToolProfile {
  /** Effective profile after applying the fail-closed fallback. */
  name: string;
  /** Non-empty profile requested by the client, when one was supplied. */
  requestedName: string | null;
  /** True when an unknown profile was reduced to the public v2 surface. */
  fellBack: boolean;
  /** null is reserved for an explicit full/admin connection. */
  tools: Set<string> | null;
}

/**
 * Resolve profile negotiation once and retain the effective profile name.
 * Missing and unknown names fail closed to v2. Only an explicit `full`
 * request receives the compatibility/admin catalog.
 */
export function resolveToolProfile(
  profileName: string | undefined | null
): ResolvedToolProfile {
  const requestedName =
    typeof profileName === 'string' && profileName.trim().length > 0
      ? profileName.trim()
      : null;
  const effectiveName =
    requestedName && TOOL_PROFILES[requestedName]
      ? requestedName
      : DEFAULT_TOOL_PROFILE;
  const profile = TOOL_PROFILES[effectiveName] ?? TOOL_PROFILES.v2;

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
