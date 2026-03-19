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
 * Default is 'full' — all tools registered, backward compatible.
 */

export interface ToolProfile {
  /** Human-readable profile purpose */
  description: string;
  /** Tool IDs to register, or null for all tools */
  tools: string[] | null;
}

export const TOOL_PROFILES: Record<string, ToolProfile> = {
  commander: {
    description: 'Human operators: decisions, status, entity CRUD, org overview',
    tools: [
      'get_pending_decisions',
      'approve_decision',
      'reject_decision',
      'get_decision_history',
      'get_agent_status',
      'get_initiative_pulse',
      'get_org_snapshot',
      'query_org_memory',
      'recommend_next_action',
      'list_entities',
      'get_task_with_context',
      'create_entity',
      'update_entity',
      'entity_action',
      'verify_entity_completion',
      'scaffold_initiative',
      'comment_on_entity',
      'list_entity_comments',
      'score_next_up_queue',
      'scoring_config',
      'queue_action',
      'record_quality_score',
      'workspace',
      'configure_org',
      'stats',
    ],
  },
  planner: {
    description:
      'Planning: create initiatives, scaffold hierarchies, plan sessions',
    tools: [
      'start_plan_session',
      'get_active_sessions',
      'improve_plan',
      'record_plan_edit',
      'complete_plan',
      'scaffold_initiative',
      'create_entity',
      'update_entity',
      'batch_create_entities',
      'list_entities',
      'get_task_with_context',
      'entity_action',
      'query_org_memory',
      'get_initiative_pulse',
      'recommend_next_action',
      'workspace',
    ],
  },
  executor: {
    description: 'Agent execution: progress reporting, changesets, spawning',
    tools: [
      'orgx_emit_activity',
      'orgx_apply_changeset',
      'sync_client_state',
      'spawn_agent_task',
      'handoff_task',
      'update_stream_progress',
      'get_initiative_stream_state',
      'entity_action',
      'list_entities',
      'get_task_with_context',
      'comment_on_entity',
      'workspace',
    ],
  },
  observer: {
    description: 'Read-only monitoring and reporting',
    tools: [
      'get_pending_decisions',
      'get_agent_status',
      'get_initiative_pulse',
      'get_org_snapshot',
      'query_org_memory',
      'get_decision_history',
      'recommend_next_action',
      'list_entities',
      'get_task_with_context',
      'list_entity_comments',
      'score_next_up_queue',
      'scoring_config',
      'get_initiative_stream_state',
      'workspace',
      'stats',
    ],
  },
  full: {
    description: 'All tools (default, backward compatible)',
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
  if (!profileName || profileName === 'full') return null;
  const profile = TOOL_PROFILES[profileName];
  if (!profile || profile.tools === null) return null;
  return new Set(profile.tools);
}
