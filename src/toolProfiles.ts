/**
 * Tool Profiles — Subagent Isolation
 *
 * @deprecated Tool selection is now server-driven via `lib/server/toolManifest.ts`.
 * The server builds a per-assignment tool manifest from `agent_capabilities.tool_manifest`
 * in the database, falling back to the hard-coded capability registry. This file is
 * retained for backward compatibility during the cutover period. New code should use
 * `buildToolManifestForAssignment()` from `@/lib/server/toolManifest` instead.
 *
 * Defines tool subsets so different agent types only see relevant tools.
 * This reduces schema tokens injected per connection by 50-72%.
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

export const GROUPED_V2_PUBLIC_SURFACE = [
  ...V2_CORE_PUBLIC_SURFACE,
  ...WIDGET_AFFORDANCE_SURFACE,
  ...CLIENT_REPORTING_PUBLIC_SURFACE,
  ...CLIENT_INTEGRATION_PUBLIC_SURFACE,
] as const;

/**
 * `server.json` is the published, versioned client capability contract. Every
 * default-client discovery surface derives from this list so source,
 * deployment metadata, bootstrap, and client profiles cannot silently drift.
 */
export const V2_PUBLIC_SURFACE = serverManifest.tools.map((tool) => tool.name);

export const TOOL_PROFILES: Record<string, ToolProfile> = {
  v2: {
    description:
      'OrgX MCP v2 public surface plus direct widget affordances for decisions, agent status, initiative pulse, scaffold, artifacts, memory search, morning brief, and task delegation',
    tools: [...V2_PUBLIC_SURFACE],
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

/**
 * Resolve a profile name to a Set of allowed tool IDs.
 * Returns null if the profile is "full" (all tools allowed).
 *
 * @deprecated Use server-side `buildToolManifestForAssignment()` instead.
 * This function is retained for backward compatibility during cutover.
 */
export function resolveProfileToolSet(
  profileName: string | undefined | null
): Set<string> | null {
  if (profileName === 'full') return null;
  if (!profileName) return new Set(TOOL_PROFILES.v2.tools ?? []);
  const profile = TOOL_PROFILES[profileName];
  if (!profile) return new Set(TOOL_PROFILES.v2.tools ?? []);
  if (profile.tools === null) return null;
  return new Set(profile.tools);
}
