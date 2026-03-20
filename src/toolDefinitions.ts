/**
 * MCP Tool Definitions
 *
 * Centralized definitions for all MCP tools.
 * Extracted from index.ts for better maintainability.
 *
 * IMPORTANT: Tool Naming Convention
 * ==================================
 * Tool IDs must match the MCP pattern: ^[a-zA-Z0-9_-]{1,64}$
 * - Only alphanumeric characters, underscores (_), and hyphens (-)
 * - NO dots (.) allowed
 * - Use underscores for namespacing: studio_brand_ingest, NOT studio.brand.ingest
 */

import { z } from 'zod';
import {
  ENTITY_TYPES as SHARED_ENTITY_TYPES,
  LIFECYCLE_ENTITY_TYPES as SHARED_LIFECYCLE_ENTITY_TYPES,
  MISSION_CONTROL_NODE_TYPES,
} from './shared/entity';

// =============================================================================
// WIDGET URIs
// =============================================================================

export const WIDGET_URIS = {
  decisions: 'ui://widget/decisions.html',
  agentStatus: 'ui://widget/agent-status.html',
  searchResults: 'ui://widget/search-results.html',
  initiativePulse: 'ui://widget/initiative-pulse.html',
  taskSpawned: 'ui://widget/task-spawned.html',
  decisionHistory: 'ui://widget/search-results.html', // Reuse search results widget
  testMinimal: 'ui://widget/test-minimal.html', // Minimal widget to validate MCP Apps rendering
  morningBrief: 'ui://widget/morning-brief.html', // Intelligence Flywheel: curated receipts + exceptions + ROI delta
} as const;


// =============================================================================
// OAUTH SCOPES — single source of truth for all discovery endpoints
// =============================================================================

export const OAUTH_SCOPES_SUPPORTED = [
  'decisions:read',
  'decisions:write',
  'agents:read',
  'agents:write',
  'initiatives:read',
  'initiatives:write',
  'memory:read',
  'offline_access',
] as const;

// =============================================================================
// SECURITY SCHEMES
// =============================================================================

export const SECURITY_SCHEMES = {
  // Read-only tools can work anonymously but unlock more with auth
  readOptionalAuth: [
    { type: 'noauth' as const },
    {
      type: 'oauth2' as const,
      scopes: [
        'decisions:read',
        'agents:read',
        'initiatives:read',
        'memory:read',
      ],
    },
  ],
  // Write tools require authentication
  writeRequiresAuth: [{ type: 'oauth2' as const, scopes: ['decisions:write'] }],
  // Agent spawning requires auth
  agentRequiresAuth: [{ type: 'oauth2' as const, scopes: ['agents:write'] }],
  // Task handoffs require both agent spawning and entity writes
  handoffRequiresAuth: [
    {
      type: 'oauth2' as const,
      scopes: ['agents:write', 'initiatives:write'],
    },
  ],
  // Entity write tools require initiatives:write (entities are part of the initiative system)
  entityWriteRequiresAuth: [
    { type: 'oauth2' as const, scopes: ['initiatives:write'] },
  ],
  // Entity read tools require initiatives:read (avoid leaking data via service-key routes)
  entityReadRequiresAuth: [
    { type: 'oauth2' as const, scopes: ['initiatives:read'] },
  ],
  // Generic auth-required tools (no specific scopes enforced yet)
  authRequired: [{ type: 'oauth2' as const }],
} as const;

// =============================================================================
// CLIENT CONTEXT SCHEMA
// =============================================================================

/**
 * Client context schema for conversation tracking across MCP clients.
 * Added to all tool inputSchemas via `_context` parameter.
 * Underscore prefix indicates reserved system parameter.
 */
export const CLIENT_CONTEXT_SCHEMA = z
  .object({
    client: z.object({
      name: z
        .string()
        .describe(
          'Client identifier: claude-code, chatgpt, cursor, web-ui, api'
        ),
      version: z.string().optional().describe('Client version, e.g., "1.2.3"'),
      platform: z
        .string()
        .optional()
        .describe('Platform: macos, windows, linux, web'),
    }),
    conversation: z
      .object({
        id: z
          .string()
          .describe('Client conversation/chat ID (client-specific format)'),
        title: z
          .string()
          .optional()
          .describe('Human-readable conversation title'),
        parentId: z
          .string()
          .optional()
          .describe('Parent conversation ID for branched/forked conversations'),
        startedAt: z
          .string()
          .optional()
          .describe('ISO timestamp when conversation began'),
      })
      .optional(),
    user: z
      .object({
        timezone: z
          .string()
          .optional()
          .describe('User timezone, e.g., "America/Los_Angeles"'),
        locale: z.string().optional().describe('User locale, e.g., "en-US"'),
        workingDirectory: z
          .string()
          .optional()
          .describe('Working directory for CLI tools'),
      })
      .optional(),
    session: z
      .object({
        orgxSessionId: z
          .string()
          .optional()
          .describe('OrgX session ID (for resume)'),
        previousRunIds: z
          .array(z.string())
          .optional()
          .describe('Related previous run IDs in this conversation'),
      })
      .optional(),
  })
  .optional()
  .describe(
    'Client context for conversation tracking (strongly recommended for cross-client continuity)'
  );

/**
 * Helper to add _context parameter to any tool inputSchema.
 * Use this when defining tools to enable conversation tracking.
 *
 * @example
 * inputSchema: withClientContext({
 *   query: z.string().describe('Search query'),
 * })
 */
export function withClientContext<T extends z.ZodRawShape>(
  schema: T
): T & { _context: typeof CLIENT_CONTEXT_SCHEMA } {
  return {
    ...schema,
    _context: CLIENT_CONTEXT_SCHEMA,
  };
}

// =============================================================================
// PLAN SESSION TOOLS
// =============================================================================

export const PLAN_SESSION_TOOLS = [
  {
    id: 'start_plan_session',
    title: 'Start Plan Session',
    description:
      'Start a new planning session to track your feature plan. USE WHEN: user begins planning a new feature or initiative. NEXT: Use improve_plan for suggestions, record_plan_edit to track changes, complete_plan when done. DO NOT USE: for creating initiative hierarchies — use scaffold_initiative instead.',
    inputSchema: {
      feature_name: z
        .string()
        .min(1)
        .describe('Name of the feature being planned'),
      initial_plan: z
        .string()
        .optional()
        .describe('Initial plan content if any'),
    },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Starting plan session...',
      'openai/toolInvocation/invoked': 'Plan session started',
    },
  },
  {
    id: 'get_active_sessions',
    title: 'Get Active Plan Sessions',
    description: 'Check for any active planning sessions you have open. USE WHEN: resuming a conversation or checking if a plan session exists. NEXT: Continue with improve_plan or complete_plan. Read-only.',
    inputSchema: {},
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Checking active sessions...',
      'openai/toolInvocation/invoked': 'Retrieved active sessions',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'improve_plan',
    title: 'Improve Plan',
    description:
      'Get AI suggestions to improve your plan based on past patterns and best practices. USE WHEN: user wants feedback on a plan draft. NEXT: Apply suggestions via record_plan_edit. DO NOT USE: without an active plan session — call start_plan_session first.',
    inputSchema: {
      session_id: z.string().min(1).describe('Plan session ID'),
      plan_content: z
        .string()
        .min(1)
        .describe('Current plan content to analyze'),
    },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Analyzing plan for improvements...',
      'openai/toolInvocation/invoked': 'Suggestions ready',
    },
  },
  {
    id: 'record_plan_edit',
    title: 'Record Plan Edit',
    description:
      'Record an edit made to a plan to learn planning patterns. USE WHEN: user modifies their plan during a session. NEXT: Continue editing or call improve_plan for more suggestions. DO NOT USE: without an active plan session.',
    inputSchema: {
      session_id: z.string().min(1).describe('Plan session ID'),
      edit_type: z
        .enum([
          'add_section',
          'remove_section',
          'modify_section',
          'add_detail',
          'change_approach',
          'add_edge_case',
          'add_constraint',
          'reorder',
          'other',
        ])
        .describe('Type of edit made'),
      before_content: z.string().optional().describe('Content before edit'),
      after_content: z.string().describe('Content after edit'),
      section_path: z
        .string()
        .optional()
        .describe('Section path like "## API Design"'),
      user_reason: z.string().optional().describe('Why this edit was made'),
    },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Recording edit...',
      'openai/toolInvocation/invoked': 'Edit recorded',
    },
  },
  {
    id: 'complete_plan',
    title: 'Complete Plan Session',
    description:
      'Mark a plan as complete and record implementation details. USE WHEN: user finishes building the planned feature. NEXT: Optionally attach to entities via attach_to. DO NOT USE: if the plan session is still in progress.',
    inputSchema: {
      session_id: z.string().min(1).describe('Plan session ID'),
      implementation_summary: z
        .string()
        .optional()
        .describe('Summary of what was built'),
      files_changed: z
        .array(z.string())
        .optional()
        .describe('List of files modified'),
      deviations: z
        .array(
          z.object({
            planned: z.string(),
            actual: z.string(),
            reason: z.string().optional(),
          })
        )
        .optional()
        .describe('Any deviations from the plan'),
      attach_to: z
        .array(
          z.object({
            entity_type: z.enum(MISSION_CONTROL_NODE_TYPES),
            entity_id: z.string().min(1),
            section: z
              .string()
              .optional()
              .describe(
                'Optional markdown section selector, e.g. "## Content Strategy"'
              ),
            label: z.string().optional(),
            relevance: z.string().optional(),
          })
        )
        .optional()
        .describe(
          'Optional: attach this plan session as context on target entities (pointers, not payloads).'
        ),
    },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Completing plan session...',
      'openai/toolInvocation/invoked': 'Plan session completed',
    },
  },
] as const;

// =============================================================================
// CHATGPT TOOL DEFINITIONS
// =============================================================================

export const CHATGPT_TOOL_DEFINITIONS = [
  {
    id: 'get_pending_decisions',
    title: 'Get Pending Decisions',
    description:
      'List OrgX decisions awaiting approval. USE WHEN: user asks what needs sign-off, review, or attention. NEXT: Present each decision with title and urgency, then ask which to approve_decision or reject_decision. DO NOT USE: for past decisions — use get_decision_history instead. Read-only.',
    inputSchema: {
      limit: z
        .number()
        .optional()
        .describe('Maximum number of decisions to return'),
      urgency_filter: z.enum(['all', 'critical', 'high']).optional(),
      initiative_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.decisions,
      'openai/toolInvocation/invoking': 'Checking your decision queue...',
      'openai/toolInvocation/invoked': 'Found your pending decisions',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'approve_decision',
    title: 'Approve Decision',
    description:
      'Approve a specific pending OrgX decision after the user confirms. USE WHEN: user says to approve a decision from get_pending_decisions. NEXT: Confirm approval to user; agent is notified automatically. DO NOT USE: without showing the decision to the user first. Requires decisions:write.',
    inputSchema: {
      decision_id: z.string().min(1),
      note: z.string().optional(),
      option_id: z
        .string()
        .optional()
        .describe(
          'Optional decision option id when the decision includes selectable options.'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.decisions,
      'openai/toolInvocation/invoking': 'Approving decision...',
      'openai/toolInvocation/invoked': 'Decision approved',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'reject_decision',
    title: 'Reject Decision',
    description:
      'Reject a pending OrgX decision with a reason. USE WHEN: user wants to reject or request revisions on a decision. NEXT: Agent will revise their approach based on the reason. DO NOT USE: without a reason — always include why. Requires decisions:write.',
    inputSchema: {
      decision_id: z.string().min(1),
      reason: z.string().min(1),
      option_id: z
        .string()
        .optional()
        .describe(
          'Optional decision option id when the decision includes selectable options.'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.decisions,
      'openai/toolInvocation/invoking': 'Rejecting decision...',
      'openai/toolInvocation/invoked': 'Decision rejected',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'get_agent_status',
    title: 'Get Agent Status',
    description:
      'Show what OrgX agents are currently doing (running/idle). USE WHEN: user asks about agent activity, progress, or what agents are working on. NEXT: If agents are stuck, suggest approve_decision or entity_action. DO NOT USE: to check initiative health — use get_initiative_pulse instead. Read-only.',
    inputSchema: {
      agent_id: z.string().optional(),
      include_idle: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.agentStatus,
      'openai/toolInvocation/invoking': 'Checking agent status...',
      'openai/toolInvocation/invoked': "Here's what your agents are doing",
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.agentStatus },
    },
  },
  {
    id: 'query_org_memory',
    title: 'Query Organizational Memory',
    description:
      'Search OrgX organizational memory (decisions, initiatives, artifacts) for a query. USE WHEN: user asks about past decisions, context, or knowledge. NEXT: Present relevant results; suggest drill-down with list_entities or get_decision_history. DO NOT USE: for listing current entities — use list_entities instead. Read-only.',
    inputSchema: {
      query: z.string().min(1),
      scope: z
        .enum(['all', 'artifacts', 'decisions', 'initiatives'])
        .optional(),
      limit: z.number().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Searching organizational memory...',
      'openai/toolInvocation/invoked': 'Found relevant information',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'get_initiative_pulse',
    title: 'Get Initiative Pulse',
    description:
      'Get health, milestones, blockers, and recent activity for a single initiative. USE WHEN: user asks how an initiative is going, or wants a status update. NEXT: If blockers exist, suggest entity_action to resolve. For deeper drill-down, use list_entities with initiative_id. DO NOT USE: for org-wide overview — use get_org_snapshot instead. Read-only.',
    inputSchema: {
      initiative_id: z
        .string()
        .optional()
        .describe('Optional: Initiative UUID to check.'),
      initiative_name: z
        .string()
        .optional()
        .describe(
          'Optional: Initiative title to resolve automatically if ID is unknown.'
        ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.initiativePulse,
      'openai/toolInvocation/invoking': 'Getting initiative health...',
      'openai/toolInvocation/invoked': "Here's the initiative status",
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.initiativePulse },
    },
  },
  {
    id: 'spawn_agent_task',
    title: 'Spawn Agent Task',
    description:
      'Assign work to a specialist OrgX agent. Automatically checks authorization, rate limits, and quality gates before spawning. Returns modelTier and run details on success, or blockedReason if spawn is denied. USE WHEN: user explicitly wants to delegate work to an agent. NEXT: Use get_agent_status to monitor progress. DO NOT USE: for creating tasks in the hierarchy — use create_entity type=task instead. Requires agents:write.',
    inputSchema: {
      agent: z.string().min(1),
      task: z.string().min(1),
      context: z.string().optional(),
      initiative_id: z.string().optional(),
      initiative_name: z
        .string()
        .optional()
        .describe(
          'Optional: Initiative title to resolve automatically if ID is unknown.'
        ),
      expected_artifacts: z
        .array(z.string())
        .optional()
        .describe(
          'Optional: Final outputs you expect (e.g., "PRD", "10 ad images").'
        ),
      deadline: z
        .string()
        .optional()
        .describe('Optional: When this is needed by (ISO date or plain text).'),
      style_guidelines: z
        .string()
        .optional()
        .describe('Optional: Voice/format/style constraints for the agent.'),
      wait_for_completion: z
        .boolean()
        .optional()
        .describe(
          'Optional: If true and safe, wait briefly for the first result before replying.'
        ),
      execution_target: z
        .enum(['auto', 'cloud', 'local', 'local_preferred'])
        .optional()
        .describe(
          'Where to execute: cloud (default), local (on your machine), local_preferred (try local first), or auto.'
        ),
      sdk_backend: z
        .enum(['auto', 'openai', 'claude'])
        .optional()
        .describe(
          'Preferred execution backend. Use openai for cloud-safe execution, claude for Claude SDK routing, or auto to let OrgX decide.'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.taskSpawned,
      'openai/toolInvocation/invoking': 'Assigning task to agent...',
      'openai/toolInvocation/invoked': 'Task assigned',
      ui: { resourceUri: WIDGET_URIS.taskSpawned },
    },
  },
  {
    id: 'handoff_task',
    title: 'Handoff Task',
    description:
      'Hand a task to another agent, updating assignment and optionally spawning a new run. USE WHEN: a task needs to be reassigned to a different specialist agent. NEXT: Use get_agent_status to confirm the new agent picked up the task. DO NOT USE: for new tasks — use spawn_agent_task instead.',
    inputSchema: {
      task_id: z.string().uuid().describe('Task UUID to hand off'),
      agent: z
        .string()
        .min(1)
        .describe(
          'Target agent (e.g., "engineering-agent", "marketing-agent")'
        ),
      note: z
        .string()
        .optional()
        .describe(
          'Handoff note: what to do, constraints, context, definition of done'
        ),
      spawn: z
        .boolean()
        .optional()
        .describe(
          'If true (default), spawn a new agent run for the target agent'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.handoffRequiresAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.taskSpawned,
      'openai/toolInvocation/invoking': 'Handing off task...',
      'openai/toolInvocation/invoked': 'Task handed off',
      ui: { resourceUri: WIDGET_URIS.taskSpawned },
    },
  },
  {
    id: 'recommend_next_action',
    title: 'Recommend Next Action',
    description:
      'Recommend the next best action based on progress gaps and templates. USE WHEN: user asks what to do next, or needs help prioritizing. NEXT: Execute the recommended action (entity_action, spawn_agent_task, etc.). DO NOT USE: when user already knows what they want to do. Read-only.',
    inputSchema: {
      entity_type: z
        .enum(['workspace', 'initiative', 'workstream', 'milestone'])
        .optional()
        .describe('Entity type to recommend for (default: workspace)'),
      entity_id: z
        .string()
        .optional()
        .describe(
          'Entity ID. For workspace, use "default" or a workspace ID.'
        ),
      workspace_id: z
        .string()
        .optional()
        .describe(
          'Optional workspace ID to scope recommendations (canonical).'
        ),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id.'),
      limit: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .describe('Max recommendations to return (default 5, max 5)'),
      cascade: z
        .boolean()
        .optional()
        .describe(
          'If true, refresh recommendations across the entity chain first'
        ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.searchResults,
      'openai/toolInvocation/invoking': 'Computing next actions...',
      'openai/toolInvocation/invoked': 'Recommended next actions',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.searchResults },
    },
  },
  {
    id: 'get_decision_history',
    title: 'Get Decision History',
    description:
      'Search past OrgX decisions related to a topic. USE WHEN: user asks about historical decisions, retrospectives, or policy questions. NEXT: Present results with context; suggest approve_decision or reject_decision if relevant pending ones exist. DO NOT USE: for pending decisions — use get_pending_decisions instead. Read-only.',
    inputSchema: {
      topic: z.string().min(1),
      initiative_id: z.string().optional(),
      limit: z.number().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/outputTemplate': WIDGET_URIS.decisionHistory,
      'openai/toolInvocation/invoking': 'Searching decision history...',
      'openai/toolInvocation/invoked': 'Found past decisions',
      'openai/readOnlyHint': true,
      ui: { resourceUri: WIDGET_URIS.decisionHistory },
    },
  },
  // =========================================================================
  // SCORING ENGINE TOOLS
  // =========================================================================
  {
    id: 'score_next_up_queue',
    title: 'Score Next Up Queue',
    description:
      'Run the composite scoring engine and return ranked queue items with factor breakdowns. USE WHEN: user asks what to work on next, or wants to see prioritized workstreams. NEXT: Execute the top-ranked item via entity_action or spawn_agent_task. DO NOT USE: for initiative health — use get_initiative_pulse instead. Read-only.',
    inputSchema: {
      initiative_id: z.string().optional().describe('Initiative UUID to score'),
      workspace_id: z
        .string()
        .optional()
        .describe('Score across all initiatives in this workspace'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id.'),
      limit: z.number().optional().describe('Max items to return (default 10)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Scoring queue items...',
      'openai/toolInvocation/invoked': 'Queue scored and ranked',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'get_scoring_signals',
    title: 'Get Scoring Signals',
    description:
      'Show raw signal data (blocking decisions, stream conflicts, health, budget, critical path, quality) for scoring. USE WHEN: user wants to understand why items are ranked the way they are in score_next_up_queue. NEXT: Adjust with set_scoring_weights if weights need tuning. Read-only.',
    inputSchema: {
      initiative_id: z
        .string()
        .min(1)
        .describe('Initiative UUID to gather signals for'),
      workstream_id: z
        .string()
        .optional()
        .describe('Optional: filter to a specific workstream'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Gathering scoring signals...',
      'openai/toolInvocation/invoked': 'Signals retrieved',
      'openai/readOnlyHint': true,
    },
  },
  // =========================================================================
  // CONSOLIDATED TOOLS
  // =========================================================================
  {
    id: 'scoring_config',
    title: 'Scoring Configuration',
    description:
      'Read or update scoring engine configuration. USE WHEN: user asks about scoring setup, wants to toggle scoring, adjust weights, or change active signals. action=get to read, action=update to modify. NEXT: Run score_next_up_queue to see effects. Read-only for get, requires initiatives:write for update.',
    inputSchema: {
      action: z.enum(['get', 'update']).describe('get=read config, update=modify settings'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z.string().optional().describe('Deprecated alias for workspace_id'),
      enabled: z.boolean().optional().describe('Enable/disable scoring_v2 (action=update only)'),
      active_signals: z.array(z.string()).optional().describe('Signal names to activate (action=update only)'),
      weights: z.record(z.number()).optional().describe('Partial weight overrides e.g. { priority: 300 } (action=update only)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Managing scoring config...',
      'openai/toolInvocation/invoked': 'Scoring config handled',
    },
  },
  {
    id: 'queue_action',
    title: 'Queue Action',
    description:
      'Pin, unpin, or skip a workstream in the Next Up queue. USE WHEN: user wants to force-prioritize or deprioritize a workstream. action=pin to force-top, action=unpin to remove pin, action=skip to temporarily deprioritize. Requires initiatives:write.',
    inputSchema: {
      action: z.enum(['pin', 'unpin', 'skip']).describe('Queue operation'),
      initiative_id: z.string().min(1).describe('Initiative UUID'),
      workstream_id: z.string().min(1).describe('Workstream UUID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z.string().optional().describe('Deprecated alias for workspace_id'),
      rank: z.number().optional().describe('Position among pinned items, 0=top (pin only)'),
      duration_minutes: z.number().optional().describe('Skip duration in minutes, default 60, max 10080 (skip only)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Updating queue...',
      'openai/toolInvocation/invoked': 'Queue updated',
    },
  },
  {
    id: 'workspace',
    title: 'Workspace',
    description:
      'List, get, or set the active workspace. USE WHEN: user wants to see their workspaces, check which is active, or switch workspaces. action=list to see all, action=get for current, action=set to switch.',
    inputSchema: {
      action: z.enum(['list', 'get', 'set']).describe('list=show all, get=current, set=switch active'),
      workspace_id: z.string().optional().describe('Workspace UUID to switch to (action=set only)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Managing workspace...',
      'openai/toolInvocation/invoked': 'Workspace handled',
    },
  },
  {
    id: 'configure_org',
    title: 'Configure Organization',
    description:
      'Check setup status, configure agents, or set org policies. USE WHEN: first connecting, onboarding, or adjusting agent/policy settings. action=status for progress, action=configure_agent to set agent preferences, action=set_policy for org-wide rules.',
    inputSchema: {
      action: z.enum(['status', 'configure_agent', 'set_policy']).describe('Configuration operation'),
      agent_type: z.enum(['product', 'engineering', 'marketing', 'sales', 'operations', 'design', 'orchestrator']).optional().describe('Agent type (configure_agent only)'),
      trust_level: z.enum(['strict', 'balanced', 'autonomous']).optional().describe('Agent autonomy level (configure_agent only)'),
      focus_areas: z.array(z.string()).optional().describe('Agent focus areas (configure_agent only)'),
      approval_required: z.array(z.string()).optional().describe('Actions requiring approval (configure_agent only)'),
      skip_approval: z.array(z.string()).optional().describe('Actions without approval (configure_agent only)'),
      policy_type: z.enum(['approvals', 'notifications', 'working_hours', 'budget']).optional().describe('Policy type (set_policy only)'),
      config: z.record(z.any()).optional().describe('Policy configuration (set_policy only)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Configuring organization...',
      'openai/toolInvocation/invoked': 'Organization configured',
    },
  },
  {
    id: 'stats',
    title: 'Stats',
    description:
      'Get productivity stats, achievements, and streaks. scope=personal for your stats, scope=session for current session diagnostics. Read-only.',
    inputSchema: {
      scope: z.enum(['personal', 'session']).default('personal').describe('personal=your stats, session=current session diagnostics'),
      timeframe: z.enum(['today', 'week', 'month', 'all_time']).optional().describe('Time period for stats (personal only)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Getting stats...',
      'openai/toolInvocation/invoked': 'Stats retrieved',
      'openai/readOnlyHint': true,
    },
  },
] as const;

// =============================================================================
// CONTENT STUDIO TOOLS (consolidated into entity tools)
// =============================================================================
// Studio operations are now handled via the generic entity tools:
// - list_entities type=studio_brand / studio_content / video_template
// - create_entity type=studio_brand (triggers brand ingest)
// - create_entity type=studio_content (triggers content generation)
// - entity_action type=studio_content action=render|validate|status|remix|vary|upscale
//
// See ENTITY_TYPES below for the full list.

// =============================================================================
// VIDEO CREATION TOOLS (consolidated into entity tools)
// =============================================================================
// Video operations are now handled via the generic entity tools:
// - list_entities type=video_template (static list, no DB)
// - create_entity type=studio_content with content_type=video + template
// - entity_action type=studio_content action=render|validate|status
//
// See ENTITY_TYPES below for the full list.

// =============================================================================
// STREAM COORDINATION TOOLS
// =============================================================================
//
// NOTE: Many stream operations use the generic entity tools for DRY:
// - List streams: list_entities type=stream initiative_id=xxx
// - Complete stream: entity_action type=stream id=xxx action=complete
// - Block stream: entity_action type=stream id=xxx action=block
// - Resume stream: entity_action type=stream id=xxx action=start
//
// The tools below provide UNIQUE functionality not covered by entity tools:

// =============================================================================
// CLIENT INTEGRATION TOOLS
// =============================================================================
// These tools power the MCP client ↔ OrgX bridge:
// - Memory sync (persistent state across sessions)
// - Guarded spawn (quality gates + model routing)
// - Quality scoring (track agent performance)

const reportingSourceClientSchema = z.enum([
  'openclaw',
  'codex',
  'claude-code',
  'api',
]);

const reportingPhaseSchema = z.enum([
  'intent',
  'execution',
  'blocked',
  'review',
  'handoff',
  'completed',
]);

const applyChangesetOperationSchema = z.union([
  z
    .object({
      op: z.literal('task.create'),
      title: z.string().min(1),
      milestone_id: z.string().uuid().optional(),
      workstream_id: z.string().uuid().optional(),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      due_date: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      if (Boolean(value.milestone_id) === Boolean(value.workstream_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'task.create requires exactly one of milestone_id or workstream_id',
        });
      }
    }),
  z
    .object({
      op: z.literal('task.update'),
      task_id: z.string().uuid(),
      status: z.enum(['todo', 'in_progress', 'done', 'blocked']).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high']).optional(),
      due_date: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      if (
        value.status === undefined &&
        value.title === undefined &&
        value.description === undefined &&
        value.priority === undefined &&
        value.due_date === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'task.update requires at least one mutable field',
        });
      }
    }),
  z
    .object({
      op: z.literal('milestone.update'),
      milestone_id: z.string().uuid(),
      status: z
        .enum(['planned', 'in_progress', 'completed', 'at_risk', 'cancelled'])
        .optional(),
      due_date: z.string().optional(),
      description: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      if (
        value.status === undefined &&
        value.due_date === undefined &&
        value.description === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'milestone.update requires at least one mutable field',
        });
      }
    }),
  z.object({
    op: z.literal('decision.create'),
    title: z.string().min(1),
    summary: z.string().optional(),
    urgency: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    options: z.array(z.string().min(1)).max(10).optional(),
    blocking: z.boolean().optional(),
  }),
]);

export const CLIENT_INTEGRATION_TOOL_DEFINITIONS = [
  {
    id: 'orgx_emit_activity',
    title: 'Emit OrgX Activity',
    description:
      'Emit append-only run telemetry for OrgX control-plane reporting. USE WHEN: agent is executing and needs to report progress. NEXT: Continue work; emit again at each phase change. DO NOT USE: for entity status changes — use entity_action instead.',
    inputSchema: {
      initiative_id: z.string().uuid().describe('Initiative UUID'),
      message: z.string().min(1).describe('Human-readable activity update'),
      run_id: z.string().uuid().optional().describe('Existing run UUID'),
      correlation_id: z
        .string()
        .optional()
        .describe('Required when run_id is not provided'),
      source_client: reportingSourceClientSchema
        .optional()
        .describe('Required when run_id is not provided'),
      phase: reportingPhaseSchema.optional(),
      progress_pct: z.number().min(0).max(100).optional(),
      level: z.enum(['info', 'warn', 'error']).optional(),
      next_step: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    securitySchemes: SECURITY_SCHEMES.authRequired,
    _meta: {
      'openai/toolInvocation/invoking': 'Emitting activity...',
      'openai/toolInvocation/invoked': 'Activity emitted',
    },
  },
  {
    id: 'orgx_apply_changeset',
    title: 'Apply OrgX Changeset',
    description:
      'Apply an idempotent transactional changeset for task/milestone/decision mutations. USE WHEN: agent needs to create/update multiple tasks, milestones, or decisions atomically. NEXT: Call orgx_emit_activity to log what was changed. DO NOT USE: for single entity updates — use entity_action or update_entity instead.',
    inputSchema: {
      initiative_id: z.string().uuid().describe('Initiative UUID'),
      idempotency_key: z
        .string()
        .min(1)
        .max(120)
        .describe('Idempotency key for safe retries'),
      operations: z.array(applyChangesetOperationSchema).min(1).max(25),
      run_id: z.string().uuid().optional().describe('Existing run UUID'),
      correlation_id: z
        .string()
        .optional()
        .describe('Required when run_id is not provided'),
      source_client: reportingSourceClientSchema
        .optional()
        .describe('Required when run_id is not provided'),
    },
    securitySchemes: SECURITY_SCHEMES.authRequired,
    _meta: {
      'openai/toolInvocation/invoking': 'Applying changeset...',
      'openai/toolInvocation/invoked': 'Changeset applied',
    },
  },
  {
    id: 'sync_client_state',
    title: 'Sync with OrgX',
    description:
      'Sync local memory with OrgX. Push decisions/logs, pull active context. USE WHEN: at session start and periodically during long sessions. NEXT: Review returned initiatives and pending decisions, ask user what to focus on. USE BEFORE: spawning agent work, to ensure latest state.',
    inputSchema: {
      memory: z.string().optional().describe('Local MEMORY.md content to push'),
      daily_log: z.string().optional().describe("Today's session log to push"),
    },
    securitySchemes: SECURITY_SCHEMES.authRequired,
    _meta: {
      'openai/toolInvocation/invoking': 'Syncing with OrgX...',
      'openai/toolInvocation/invoked': 'Org context synced',
    },
  },
  {
    id: 'check_spawn_guard',
    title: 'Check Spawn Authorization',
    description:
      'Check whether an agent spawn is allowed before executing. Returns model tier, rate limit status, quality gate, and task verification. USE WHEN: before any spawn_agent_task call. NEXT: If allowed, proceed with spawn_agent_task using the returned model tier. If blocked, inform user of the reason.',
    inputSchema: {
      domain: z
        .string()
        .min(1)
        .describe(
          'Agent domain: engineering, marketing, product, design, ops, sales, orchestration'
        ),
      task_id: z.string().optional().describe('OrgX task ID this spawn is for'),
      task_title: z
        .string()
        .optional()
        .describe('Task title (for model routing if task_id not provided)'),
      task_description: z.string().optional().describe('Task description'),
    },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Checking spawn authorization...',
      'openai/toolInvocation/invoked': 'Spawn check complete',
    },
  },
  {
    id: 'record_quality_score',
    title: 'Score Completed Task',
    description:
      'Record a quality score (1-5) for a completed agent task. Scores feed into the quality gate — low-scoring domains get throttled. USE WHEN: after reviewing agent output. NEXT: Scores affect future check_spawn_guard decisions. DO NOT USE: for in-progress tasks — wait until completion.',
    inputSchema: {
      task_id: z.string().min(1).describe('OrgX task ID'),
      agent_domain: z
        .string()
        .min(1)
        .describe('Agent domain that completed the task'),
      score: z
        .number()
        .min(1)
        .max(5)
        .describe('Quality score: 1=poor, 3=acceptable, 5=excellent'),
      scored_by: z
        .enum(['human', 'auto', 'peer'])
        .optional()
        .describe('Who scored this'),
      notes: z.string().optional().describe('Notes on the score'),
    },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Recording quality score...',
      'openai/toolInvocation/invoked': 'Score recorded',
    },
  },
  {
    id: 'classify_task_model',
    title: 'Route Task to Model Tier',
    description:
      'Classify a task and get the recommended model tier (opus for planning/architecture, sonnet for execution, local for routine). USE WHEN: deciding which model to use for agent work. NEXT: Use the returned tier when spawning via spawn_agent_task. Read-only.',
    inputSchema: {
      title: z.string().min(1).describe('Task title'),
      description: z.string().optional().describe('Task description'),
      entity_type: z
        .string()
        .optional()
        .describe('Entity type: task, decision, initiative'),
      domain: z.string().optional().describe('Agent domain'),
    },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Classifying task complexity...',
      'openai/toolInvocation/invoked': 'Model tier determined',
      'openai/readOnlyHint': true,
    },
  },
];

export const STREAM_TOOL_DEFINITIONS = [
  {
    id: 'update_stream_progress',
    title: 'Update Stream Progress',
    description:
      'Report progress and confidence on a stream with velocity tracking. USE WHEN: agent is actively working a stream and needs to report progress. NEXT: Continue work; call again at each meaningful progress change. DO NOT USE: for general entity status changes — use entity_action instead.',
    inputSchema: {
      stream_id: z.string().min(1).describe('The stream ID to update'),
      progress_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Progress percentage (0-100)'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Confidence level (0-1) - separate from progress'),
      status_note: z
        .string()
        .optional()
        .describe('Brief note about current status'),
      expected_version: z
        .number()
        .optional()
        .describe('For optimistic locking'),
    },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Updating stream progress...',
      'openai/toolInvocation/invoked': 'Progress updated',
    },
  },
  {
    id: 'get_initiative_stream_state',
    title: 'Get Initiative Stream State',
    description:
      'Get aggregate stream state for an initiative including overall progress, blockers, and computed metrics. USE WHEN: checking stream execution status for an initiative. NEXT: If streams are blocked, use entity_action to unblock. DO NOT USE: for raw stream records — use list_entities type=stream instead. Read-only.',
    inputSchema: {
      initiative_id: z.string().min(1).describe('The initiative ID'),
    },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Getting initiative stream state...',
      'openai/toolInvocation/invoked': 'Retrieved stream state',
      'openai/readOnlyHint': true,
    },
  },
] as const;

/**
 * Generate human-readable summaries for stream tool results.
 *
 * NOTE: Only handles unique stream tools. Generic stream operations
 * (list, complete, block, resume) use entity tools and their summarizers.
 */
export function summarizeStreamToolResult(
  toolId: string,
  data: Record<string, unknown>
): string {
  switch (toolId) {
    case 'update_stream_progress': {
      const progress = data.progress_pct as number | undefined;
      const confidence = data.confidence as number | undefined;
      let msg = 'Progress updated';
      if (progress !== undefined) msg += ` (${progress}%)`;
      if (confidence !== undefined)
        msg += ` - confidence: ${Math.round(confidence * 100)}%`;
      return msg;
    }

    case 'get_initiative_stream_state': {
      const total = data.total_streams as number | undefined;
      const progress = data.overall_progress as number | undefined;
      const blocked = data.blocked_count as number | undefined;
      let msg = `${total || 0} streams, ${progress ?? 0}% overall progress`;
      if (blocked && blocked > 0) {
        msg += `, ${blocked} blocked`;
      }
      return msg;
    }

    default:
      return JSON.stringify(data, null, 2);
  }
}

// =============================================================================
// ENTITY TYPES
// =============================================================================

export const ENTITY_TYPES = SHARED_ENTITY_TYPES;

export const entityTypeEnum = z.enum(ENTITY_TYPES);

// Entity types that support lifecycle actions (launch, pause, complete)
// Excludes: agent, skill (configuration objects, not workflow entities)
export const LIFECYCLE_ENTITY_TYPES = SHARED_LIFECYCLE_ENTITY_TYPES;

export const lifecycleEntityTypeEnum = z.enum(LIFECYCLE_ENTITY_TYPES);

// =============================================================================
// LIFECYCLE ACTION MAPS
// =============================================================================

export const LAUNCH_ACTION_MAP: Record<string, string> = {
  command_center: 'activate',
  project: 'launch',
  initiative: 'launch',
  milestone: 'start',
  workstream: 'start',
  task: 'start',
  playbook: 'activate',
  objective: 'resume',
  decision: 'approve',
  artifact: 'submit_for_review',
  run: 'start',
  blocker: 'resolve',
  workflow: 'activate',
  skill: 'activate',
  plan_session: 'start',
  stream: 'start',
};

export const PAUSE_ACTION_MAP: Record<string, string> = {
  command_center: 'deactivate',
  project: 'archive',
  initiative: 'pause',
  milestone: 'flag_risk',
  workstream: 'pause',
  task: 'block',
  playbook: 'archive',
  objective: 'pause',
  decision: 'cancel',
  artifact: 'request_changes',
  run: 'pause',
  blocker: 'dismiss',
  workflow: 'pause',
  skill: 'archive',
  plan_session: 'abandon',
  stream: 'block',
};

// =============================================================================
// TOOL RESULT SUMMARIZERS
// =============================================================================

/**
 * Generate human-readable summaries for ChatGPT tool results.
 */
export function summarizeChatGPTToolResult(
  toolId: string,
  data: Record<string, unknown>
): string {
  switch (toolId) {
    case 'get_pending_decisions': {
      const decisions = Array.isArray(data.decisions) ? data.decisions : [];
      return decisions.length === 0
        ? 'All clear! No decisions need your attention.'
        : `You have ${decisions.length} decision${
            decisions.length === 1 ? '' : 's'
          } pending.`;
    }

    case 'approve_decision':
      return 'Decision approved. The agent has been notified.';

    case 'reject_decision':
      return 'Decision rejected. The agent will revise their approach.';

    case 'get_agent_status': {
      const agents = Array.isArray(data.agents) ? data.agents : [];
      const running = agents.filter(
        (a: Record<string, unknown>) => a.status === 'running'
      ).length;
      return running === 0
        ? 'No agents currently running.'
        : `${running} agent${running === 1 ? '' : 's'} currently active.`;
    }

    case 'query_org_memory': {
      const results = Array.isArray(data.results) ? data.results : [];
      return results.length === 0
        ? 'No matching results found.'
        : `Found ${results.length} relevant item${
            results.length === 1 ? '' : 's'
          }.`;
    }

    case 'get_initiative_pulse': {
      const name = data.name as string | undefined;
      const healthScore = data.health_score as number | undefined;
      return name
        ? `${name}: Health score ${healthScore ?? 'N/A'}%`
        : 'Initiative status retrieved.';
    }

    case 'spawn_agent_task': {
      const agentName = data.agent_name as string | undefined;
      return agentName
        ? `Task assigned to ${agentName}.`
        : 'Task has been assigned to the agent.';
    }

    case 'handoff_task': {
      const agentName = data.agent_name as string | undefined;
      return agentName
        ? `Task handed off to ${agentName}.`
        : 'Task handed off.';
    }

    case 'recommend_next_action': {
      const recs = Array.isArray(data.recommendations)
        ? data.recommendations
        : Array.isArray(data.items)
        ? data.items
        : [];
      return recs.length === 0
        ? 'No recommendations available.'
        : `Recommended ${recs.length} next action${
            recs.length === 1 ? '' : 's'
          }.`;
    }

    case 'get_decision_history': {
      const history = Array.isArray(data.decisions) ? data.decisions : [];
      return history.length === 0
        ? 'No past decisions found on this topic.'
        : `Found ${history.length} historical decision${
            history.length === 1 ? '' : 's'
          }.`;
    }

    case 'score_next_up_queue': {
      const items = Array.isArray(data.items) ? data.items : [];
      const total = (data.total as number) ?? items.length;
      return items.length === 0
        ? 'No queue items to score.'
        : `Scored ${total} item${total === 1 ? '' : 's'}. Top: ${(items[0] as any)?.workstreamTitle ?? 'unknown'} (${(items[0] as any)?.compositeScore ?? 0}).`;
    }

    case 'get_scoring_signals':
      return (data.message as string) ?? 'Scoring signals retrieved.';

    case 'scoring_config': {
      const action = data._action as string | undefined;
      if (action === 'get') return (data.message as string) ?? 'Scoring config retrieved.';
      return (data.message as string) ?? 'Scoring config updated.';
    }

    case 'queue_action':
      return (data.message as string) ?? 'Queue updated.';

    case 'workspace': {
      const action = data._action as string | undefined;
      if (action === 'list') {
        const ws = Array.isArray(data.workspaces) ? data.workspaces : [];
        return ws.length === 0 ? 'No workspaces found.' : `Found ${ws.length} workspace${ws.length === 1 ? '' : 's'}.`;
      }
      if (action === 'set') return (data.message as string) ?? 'Workspace set.';
      return (data.message as string) ?? 'Current workspace retrieved.';
    }

    case 'configure_org': {
      const action = data._action as string | undefined;
      if (action === 'status') return (data.message as string) ?? 'Setup status retrieved.';
      if (action === 'configure_agent') return (data.message as string) ?? 'Agent configured.';
      return (data.message as string) ?? 'Policy set.';
    }

    case 'stats':
      return (data.message as string) ?? 'Stats retrieved.';

    // Legacy tool IDs still returned by backend
    case 'get_scoring_config':
      return (data.message as string) ?? 'Scoring config retrieved.';

    case 'set_scoring_config':
      return (data.message as string) ?? 'Scoring config updated.';

    case 'set_scoring_weights':
      return (data.message as string) ?? 'Scoring weights updated.';

    case 'pin_queue_item':
      return (data.message as string) ?? 'Queue item pinned.';

    case 'unpin_queue_item':
      return (data.message as string) ?? 'Queue item unpinned.';

    case 'skip_workstream':
      return (data.message as string) ?? 'Workstream skipped.';

    default:
      return JSON.stringify(data, null, 2);
  }
}

/**
 * Generate human-readable summaries for plan session tool results.
 */
export function summarizePlanSessionResult(
  toolId: string,
  data: Record<string, unknown>
): string {
  switch (toolId) {
    case 'start_plan_session': {
      const id = data.id as string | undefined;
      const title = data.title as string | undefined;
      return `📋 Started plan session "${title || 'Untitled'}" (ID: ${id?.slice(
        0,
        8
      )}...)\n\nI'll track your edits and learn from your planning patterns. Use improve_plan to get suggestions, and complete_plan when you're done building.`;
    }

    case 'get_active_sessions': {
      const sessions = (data.sessions ?? data) as Array<{
        id: string;
        title: string;
        feature_name?: string;
      }>;
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return 'No active planning sessions. Use start_plan_session to begin planning a feature.';
      }
      const list = sessions
        .map(
          (s) => `- "${s.title || s.feature_name}" (ID: ${s.id})`
        )
        .join('\n');
      return `📋 Active planning sessions:\n${list}\n\nContinue an existing session or start a new one.`;
    }

    case 'improve_plan': {
      const suggestions = data.suggestions as
        | Array<{ type: string; suggestion: string; source?: string }>
        | undefined;
      const domains = data.domains_detected as string[] | undefined;
      const learned = data.learned_from_past as number | undefined;

      if (!suggestions || suggestions.length === 0) {
        return '✅ Your plan looks good! No specific improvements suggested.';
      }

      let response = `💡 Suggestions for your plan:\n\n`;
      for (const s of suggestions.slice(0, 5)) {
        const icon = s.type === 'missing' ? '⚠️' : '💡';
        response += `${icon} ${s.suggestion}`;
        if (s.source) response += ` _(${s.source})_`;
        response += '\n';
      }
      if (domains && domains.length > 0) {
        response += `\n📂 Detected domains: ${domains.join(', ')}`;
      }
      if (learned && learned > 0) {
        response += `\n🧠 ${learned} suggestion${
          learned > 1 ? 's' : ''
        } based on your past patterns`;
      }
      return response;
    }

    case 'record_plan_edit': {
      const editType = data.edit_type as string | undefined;
      return `📝 Recorded ${
        editType?.replace('_', ' ') || 'edit'
      }. I'm learning from your planning style.`;
    }

    case 'complete_plan': {
      const suggestions = data.skill_suggestions as
        | Array<{ pattern: string }>
        | undefined;
      const message = data.message as string | undefined;
      let response = `✅ ${message || 'Plan session completed!'}`;

      const contextAttachments = data.context_attachments as
        | {
            attached_count?: number;
            skipped_count?: number;
            errors?: unknown[];
          }
        | null
        | undefined;
      if (contextAttachments) {
        const attached = Number(contextAttachments.attached_count ?? 0);
        const skipped = Number(contextAttachments.skipped_count ?? 0);
        const errors = Array.isArray(contextAttachments.errors)
          ? contextAttachments.errors.length
          : 0;
        response += `\n🔗 Attached to ${attached} entit${
          attached === 1 ? 'y' : 'ies'
        }${skipped > 0 ? ` (${skipped} already attached)` : ''}${
          errors > 0 ? ` (${errors} errors)` : ''
        }`;
      }

      if (suggestions && suggestions.length > 0) {
        response += `\n\n🧠 Potential skills to create from this session:\n`;
        for (const s of suggestions.slice(0, 3)) {
          response += `- ${s.pattern}\n`;
        }
        response += `\nUse create_plan_skill to save these patterns for future use.`;
      }
      return response;
    }

    default:
      return JSON.stringify(data, null, 2);
  }
}

// =============================================================================
// CONSOLIDATED TOOL EXPANSION
// =============================================================================

/**
 * Expand consolidated tool IDs into their legacy backend tool_id + args.
 *
 * Consolidated tools (scoring_config, queue_action, stats) map to existing
 * backend handlers via the /api/tools/execute dispatcher. This function
 * translates the new tool_id + action param into the legacy tool_id that
 * the backend expects.
 *
 * For tools handled inline in index.ts (workspace, configure_org), this
 * function is not used — those tools dispatch directly in their handlers.
 */
export function expandConsolidatedTool(
  toolId: string,
  args: Record<string, unknown>
): { resolvedToolId: string; resolvedArgs: Record<string, unknown> } {
  switch (toolId) {
    case 'scoring_config': {
      const action = args.action as string;
      const resolvedArgs = { ...args };
      delete resolvedArgs.action;
      if (action === 'get') {
        return { resolvedToolId: 'get_scoring_config', resolvedArgs };
      }
      // action === 'update': handle weights + config in one call
      if (args.weights) {
        return { resolvedToolId: 'set_scoring_config', resolvedArgs };
      }
      return { resolvedToolId: 'set_scoring_config', resolvedArgs };
    }

    case 'queue_action': {
      const action = args.action as string;
      const resolvedArgs = { ...args };
      delete resolvedArgs.action;
      const map: Record<string, string> = {
        pin: 'pin_queue_item',
        unpin: 'unpin_queue_item',
        skip: 'skip_workstream',
      };
      return { resolvedToolId: map[action] ?? 'pin_queue_item', resolvedArgs };
    }

    case 'stats': {
      const scope = (args.scope as string) ?? 'personal';
      const resolvedArgs = { ...args };
      delete resolvedArgs.scope;
      return {
        resolvedToolId: scope === 'session' ? 'get_session_stats' : 'get_my_stats',
        resolvedArgs,
      };
    }

    default:
      return { resolvedToolId: toolId, resolvedArgs: args };
  }
}
