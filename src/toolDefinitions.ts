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
import { CONFIGURE_ORG_POLICY_TYPES } from './configureOrgPolicy';
import {
  compatibilityAliasDescription,
  preferredToolCallout,
} from './preferredToolGuidance';
import { WIDGET_BUILD_VERSION } from './generated/widgetBuildInfo';
import {
  toSkybridgeResourceUri,
  withWidgetResourceVersion,
} from './widgetConfig';
import { OAUTH_SCOPE, OAUTH_SCOPES_SUPPORTED } from './authorizationPolicy';

// =============================================================================
// WIDGET URIs
// =============================================================================

export const WIDGET_URIS = {
  decisions: withWidgetResourceVersion(
    'ui://widget/decisions.html',
    WIDGET_BUILD_VERSION
  ),
  agentStatus: withWidgetResourceVersion(
    'ui://widget/agent-status.html',
    WIDGET_BUILD_VERSION
  ),
  searchResults: withWidgetResourceVersion(
    'ui://widget/search-results.html',
    WIDGET_BUILD_VERSION
  ),
  scaffoldedInitiative: withWidgetResourceVersion(
    'ui://widget/scaffolded-initiative.html',
    WIDGET_BUILD_VERSION
  ),
  initiativePulse: withWidgetResourceVersion(
    'ui://widget/initiative-pulse.html',
    WIDGET_BUILD_VERSION
  ),
  taskSpawned: withWidgetResourceVersion(
    'ui://widget/task-spawned.html',
    WIDGET_BUILD_VERSION
  ),
  decisionHistory: withWidgetResourceVersion(
    'ui://widget/search-results.html',
    WIDGET_BUILD_VERSION
  ), // Reuse search results widget
  morningBrief: withWidgetResourceVersion(
    'ui://widget/morning-brief.html',
    WIDGET_BUILD_VERSION
  ), // Intelligence Flywheel: curated receipts + exceptions + ROI delta
  artifactReview: withWidgetResourceVersion(
    'ui://widget/artifact-review.html',
    WIDGET_BUILD_VERSION
  ), // Action widget for approving/rejecting production artifacts
  planSessionLive: withWidgetResourceVersion(
    'ui://widget/plan-session-live.html',
    WIDGET_BUILD_VERSION
  ), // Creation-mode widget for co-authored agent reasoning
  dailyBrief: withWidgetResourceVersion(
    'ui://widget/daily-brief.html',
    WIDGET_BUILD_VERSION
  ), // Daily Brief + Trust Loop: skill/agent ascension surface
} as const;

export const OUTPUT_TEMPLATE_URIS = {
  decisions: toSkybridgeResourceUri(WIDGET_URIS.decisions),
  agentStatus: toSkybridgeResourceUri(WIDGET_URIS.agentStatus),
  searchResults: toSkybridgeResourceUri(WIDGET_URIS.searchResults),
  scaffoldedInitiative: toSkybridgeResourceUri(WIDGET_URIS.scaffoldedInitiative),
  initiativePulse: toSkybridgeResourceUri(WIDGET_URIS.initiativePulse),
  taskSpawned: toSkybridgeResourceUri(WIDGET_URIS.taskSpawned),
  decisionHistory: toSkybridgeResourceUri(WIDGET_URIS.decisionHistory),
  morningBrief: toSkybridgeResourceUri(WIDGET_URIS.morningBrief),
  artifactReview: toSkybridgeResourceUri(WIDGET_URIS.artifactReview),
  planSessionLive: toSkybridgeResourceUri(WIDGET_URIS.planSessionLive),
  dailyBrief: toSkybridgeResourceUri(WIDGET_URIS.dailyBrief),
} as const;

export const WIDGET_RESOURCES = [
  {
    name: 'decisions-widget',
    uri: WIDGET_URIS.decisions,
    title: 'Pending Decisions Widget',
  },
  {
    name: 'agent-status-widget',
    uri: WIDGET_URIS.agentStatus,
    title: 'Agent Status Widget',
  },
  {
    name: 'search-results-widget',
    uri: WIDGET_URIS.searchResults,
    title: 'Search Results Widget',
  },
  {
    name: 'scaffolded-initiative-widget',
    uri: WIDGET_URIS.scaffoldedInitiative,
    title: 'Scaffolded Initiative Widget',
  },
  {
    name: 'initiative-pulse-widget',
    uri: WIDGET_URIS.initiativePulse,
    title: 'Initiative Pulse Widget',
  },
  {
    name: 'task-spawned-widget',
    uri: WIDGET_URIS.taskSpawned,
    title: 'Task Spawned Widget',
  },
  {
    name: 'morning-brief-widget',
    uri: WIDGET_URIS.morningBrief,
    title: 'Morning Brief Widget',
  },
  {
    name: 'artifact-review-widget',
    uri: WIDGET_URIS.artifactReview,
    title: 'Artifact Review Widget',
  },
  {
    name: 'plan-session-live-widget',
    uri: WIDGET_URIS.planSessionLive,
    title: 'Plan Session Live Widget',
  },
  {
    name: 'daily-brief-widget',
    uri: WIDGET_URIS.dailyBrief,
    title: 'Daily Brief + Trust Loop Widget',
  },
] as const;

export const SCAFFOLD_INITIATIVE_WIDGET_META = {
  'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.scaffoldedInitiative,
  'openai/toolInvocation/invoking': 'Scaffolding initiative hierarchy...',
  'openai/toolInvocation/invoked': 'Initiative scaffolded',
  // ui.visibility is the current Apps SDK visibility contract. Keep the
  // legacy openai/visibility field on the registered descriptor as a
  // compatibility alias, but do not rely on it: the plugin scanner treats a
  // template-linked tool without model visibility as hidden.
  ui: {
    resourceUri: WIDGET_URIS.scaffoldedInitiative,
    visibility: ['model', 'app'],
  },
} as const;


// =============================================================================
// OAUTH POLICY — single source of truth for discovery, consent, and enforcement
// =============================================================================

export {
  AUTHORIZATION_POLICY,
  AUTHORIZATION_POLICY_VERSION,
  AUTHORIZATION_PRESETS,
  AUTHORIZATION_RESOURCE_ACTION_CATALOG,
  AUTHORIZATION_SESSION_CAPABILITIES,
  OAUTH_SCOPE,
  OAUTH_SCOPES_SUPPORTED,
  isSupportedOAuthScope,
  type AuthorizationAccessLevel,
  type AuthorizationAction,
  type AuthorizationResource,
  type OAuthScope,
} from './authorizationPolicy';

// =============================================================================
// SECURITY SCHEMES
// =============================================================================

const oauthScopeAlternative = (scope: string) =>
  ({ type: 'oauth2' as const, scopes: [scope] as const });

export const SECURITY_SCHEMES = {
  /**
   * Compatibility name retained for older definition modules. Private OrgX
   * reads are never anonymous: each entry is an OAuth alternative, so one
   * relevant read grant is enough for discovery while invocation-time policy
   * can enforce the exact resource selected by polymorphic tools.
   */
  readOptionalAuth: [
    oauthScopeAlternative(OAUTH_SCOPE.decisionsRead),
    oauthScopeAlternative(OAUTH_SCOPE.agentsRead),
    oauthScopeAlternative(OAUTH_SCOPE.initiativesRead),
    oauthScopeAlternative(OAUTH_SCOPE.memoryRead),
  ],
  anyReadRequiresAuth: [
    oauthScopeAlternative(OAUTH_SCOPE.decisionsRead),
    oauthScopeAlternative(OAUTH_SCOPE.agentsRead),
    oauthScopeAlternative(OAUTH_SCOPE.initiativesRead),
    oauthScopeAlternative(OAUTH_SCOPE.memoryRead),
  ],
  allReadRequiresAuth: [
    {
      type: 'oauth2' as const,
      scopes: [
        OAUTH_SCOPE.decisionsRead,
        OAUTH_SCOPE.agentsRead,
        OAUTH_SCOPE.initiativesRead,
        OAUTH_SCOPE.memoryRead,
      ],
    },
  ],
  decisionReadRequiresAuth: [
    { type: 'oauth2' as const, scopes: [OAUTH_SCOPE.decisionsRead] },
  ],
  agentReadRequiresAuth: [
    { type: 'oauth2' as const, scopes: [OAUTH_SCOPE.agentsRead] },
  ],
  agentAccessRequiresAuth: [
    oauthScopeAlternative(OAUTH_SCOPE.agentsRead),
    oauthScopeAlternative(OAUTH_SCOPE.agentsWrite),
  ],
  decisionAccessRequiresAuth: [
    oauthScopeAlternative(OAUTH_SCOPE.decisionsRead),
    oauthScopeAlternative(OAUTH_SCOPE.decisionsWrite),
  ],
  entityAccessRequiresAuth: [
    oauthScopeAlternative(OAUTH_SCOPE.initiativesRead),
    oauthScopeAlternative(OAUTH_SCOPE.initiativesWrite),
  ],
  memoryReadRequiresAuth: [
    { type: 'oauth2' as const, scopes: [OAUTH_SCOPE.memoryRead] },
  ],
  // Decision operations require authentication and their existing wire scope.
  writeRequiresAuth: [
    { type: 'oauth2' as const, scopes: [OAUTH_SCOPE.decisionsWrite] },
  ],
  // Agent operations require auth.
  agentRequiresAuth: [
    { type: 'oauth2' as const, scopes: [OAUTH_SCOPE.agentsWrite] },
  ],
  // Task handoffs require both agent spawning and entity writes
  handoffRequiresAuth: [
    {
      type: 'oauth2' as const,
      scopes: [OAUTH_SCOPE.agentsWrite, OAUTH_SCOPE.initiativesWrite],
    },
  ],
  // Entity write tools require initiatives:write (entities are part of the initiative system)
  entityWriteRequiresAuth: [
    { type: 'oauth2' as const, scopes: [OAUTH_SCOPE.initiativesWrite] },
  ],
  // Entity read tools require initiatives:read (avoid leaking data via service-key routes)
  entityReadRequiresAuth: [
    { type: 'oauth2' as const, scopes: [OAUTH_SCOPE.initiativesRead] },
  ],
  // Polymorphic writes are discoverable with any write grant; invocation
  // resolves the selected entity domain and enforces its exact scope.
  anyWriteRequiresAuth: [
    oauthScopeAlternative(OAUTH_SCOPE.decisionsWrite),
    oauthScopeAlternative(OAUTH_SCOPE.agentsWrite),
    oauthScopeAlternative(OAUTH_SCOPE.initiativesWrite),
  ],
  allWriteRequiresAuth: [
    {
      type: 'oauth2' as const,
      scopes: [
        OAUTH_SCOPE.decisionsWrite,
        OAUTH_SCOPE.agentsWrite,
        OAUTH_SCOPE.initiativesWrite,
      ],
    },
  ],
  changesetRequiresAuth: [
    {
      type: 'oauth2' as const,
      scopes: [OAUTH_SCOPE.agentsWrite, OAUTH_SCOPE.initiativesWrite],
    },
  ],
  memorySyncRequiresAuth: [
    {
      type: 'oauth2' as const,
      scopes: [
        OAUTH_SCOPE.decisionsWrite,
        OAUTH_SCOPE.initiativesWrite,
        OAUTH_SCOPE.memoryRead,
      ],
    },
  ],
  /**
   * Legacy/internal fallback for inline tools that have not yet been assigned
   * a narrower domain. It is deliberately scoped and high privilege so an
   * explicit OAuth grant can never satisfy it merely by being authenticated.
   */
  authRequired: [
    {
      type: 'oauth2' as const,
      scopes: [
        OAUTH_SCOPE.decisionsWrite,
        OAUTH_SCOPE.agentsWrite,
        OAUTH_SCOPE.initiativesWrite,
      ],
    },
  ],
} as const;

const agentModelTierSchema = z.enum([
  'standard',
  'balanced',
  'precision',
  'local',
  'sonnet',
  'opus',
]);

const agentProviderPreferenceSchema = z.enum([
  'auto',
  'openai',
  'anthropic',
  'openrouter',
  'groq',
  'local',
]);

const agentBudgetModeSchema = z.enum([
  'cheapest_valid',
  'balanced',
  'highest_quality',
]);

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
          .optional()
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
      'Start a multi-agent planning session that breaks a goal into projects, tasks, owners, and agent assignments. Also known as: feature planning, roadmap planning, planning workflow. USE WHEN: user begins planning a new feature or initiative. NEXT: Use improve_plan for suggestions, record_plan_edit to track changes, complete_plan when done. DO NOT USE: for creating initiative hierarchies — use scaffold_initiative instead.',
    inputSchema: {
      feature_name: z
        .string()
        .min(1)
        .describe('Name of the feature being planned'),
      initial_plan: z
        .string()
        .optional()
        .describe('Initial plan content if any'),
      workspace_id: z
        .string()
        .optional()
        .describe('Workspace UUID to scope the planning session. Defaults to current session workspace when omitted.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Starting plan session...',
      'openai/toolInvocation/invoked': 'Plan session started',
    },
  },
  {
    id: 'get_active_sessions',
    title: 'Get Active Plan Sessions',
    description: 'Find active planning sessions so agents can continue prior planning context. Also known as: resume planning, active plans, planning memory. USE WHEN: resuming a conversation or checking if a plan session exists. NEXT: Continue with improve_plan or complete_plan. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.agentReadRequiresAuth,
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
      'Improve a plan with AI suggestions based on prior patterns and best practices. Also known as: plan critique, planning feedback, refine roadmap. USE WHEN: user wants feedback on a plan draft. NEXT: Apply suggestions via record_plan_edit. DO NOT USE: without an active plan session — call start_plan_session first.',
    inputSchema: {
      session_id: z.string().min(1).describe('Plan session ID'),
      plan_content: z
        .string()
        .min(1)
        .describe('Current plan content to analyze'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Analyzing plan for improvements...',
      'openai/toolInvocation/invoked': 'Suggestions ready',
    },
  },
  {
    id: 'record_plan_edit',
    title: 'Record Plan Edit',
    description:
      'Record a plan edit so OrgX can preserve planning context and learn patterns. Also known as: save plan change, plan memory, planning history. USE WHEN: user modifies their plan during a session. NEXT: Continue editing or call improve_plan for more suggestions. DO NOT USE: without an active plan session.',
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Recording edit...',
      'openai/toolInvocation/invoked': 'Edit recorded',
    },
  },
  {
    id: 'complete_plan',
    title: 'Complete Plan Session',
    description:
      'Complete a planning session and attach implementation details to durable work context. Also known as: finish plan, implementation record, planning handoff. USE WHEN: user finishes building the planned feature. NEXT: Optionally attach to entities via attach_to. DO NOT USE: if the plan session is still in progress.',
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
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
      compatibilityAliasDescription(
        'pendingDecisions',
        'List agent decisions and work items awaiting human approval. Also known as: pending approvals, agent blocked, sign off, review decisions, approve AI work. USE WHEN: older clients still call this tool directly. NEXT: Present each decision with title and urgency, then ask which to approve_decision or reject_decision. DO NOT USE: for new prompts or skills. Read-only.'
      ),
    inputSchema: {
      limit: z
        .number()
        .optional()
        .describe('Maximum number of decisions to return'),
      urgency_filter: z
        .enum(['all', 'critical', 'high'])
        .optional()
        .describe('Optional urgency filter for the pending decision list'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to scope pending decisions'),
      workspace_id: z
        .string()
        .optional()
        .describe('Optional workspace UUID to scope pending decisions'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.decisionReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
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
      'Use when the user has reviewed a pending decision that is blocking agent work and gives explicit confirmation to approve it. Also known as: sign off, approve AI work, unblock agent, accept decision. USE WHEN: user says to approve a decision returned from list_entities with type=decision and status=pending (or the legacy get_pending_decisions alias). Approval can resume or continue connected agent execution. NEXT: Confirm approval to user; agent is notified automatically. DO NOT USE: without showing the decision to the user first. Requires decisions:write.',
    inputSchema: {
      decision_id: z.string().min(1).describe('Decision ID to approve'),
      note: z.string().optional().describe('Optional note recorded with the approval'),
      option_id: z
        .string()
        .optional()
        .describe(
          'Optional decision option id when the decision includes selectable options.'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
      'openai/toolInvocation/invoking': 'Approving decision...',
      'openai/toolInvocation/invoked': 'Decision approved',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'reject_decision',
    title: 'Reject Decision',
    description:
      'Use when the user has reviewed a pending decision and wants to reject it or send the agent back with revisions. Also known as: request revisions, send feedback, decline decision. USE WHEN: user wants to reject or request revisions on a decision. NEXT: Agent will revise their approach based on the reason. DO NOT USE: without a reason — always include why. Requires decisions:write.',
    inputSchema: {
      decision_id: z.string().min(1).describe('Decision ID to reject'),
      reason: z.string().min(1).describe('Reason for rejecting the decision'),
      option_id: z
        .string()
        .optional()
        .describe(
          'Optional decision option id when the decision includes selectable options.'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisions,
      'openai/toolInvocation/invoking': 'Rejecting decision...',
      'openai/toolInvocation/invoked': 'Decision rejected',
      ui: { resourceUri: WIDGET_URIS.decisions },
    },
  },
  {
    id: 'get_agent_status',
    title: 'Get Agent Status',
    description:
      'Use when the user asks what agents are working on right now, whether delegated work is still running, or why nothing has landed yet. Successful calls record metered MCP allowance usage but do not change business records. Also known as: agent status, what agents are doing, active runs. USE WHEN: user asks about agent activity, progress, or what agents are working on. NEXT: If agents are stuck, use orgx_search or orgx_inspect to read the related blocker context. DO NOT USE: to check initiative health — use get_initiative_pulse instead.',
    inputSchema: {
      agent_id: z.string().optional().describe('Optional agent ID to inspect'),
      workspace_id: z.string().uuid().optional().describe('Optional workspace UUID to scope agent status'),
      command_center_id: z.string().uuid().optional().describe('Deprecated alias for workspace_id'),
      initiative_id: z.string().uuid().optional().describe('Optional initiative UUID to scope agent status'),
      include_idle: z
        .boolean()
        .optional()
        .describe('Include idle agents in the response'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.agentReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.agentStatus,
      'openai/toolInvocation/invoking': 'Checking agent status...',
      'openai/toolInvocation/invoked': "Here's what your agents are doing",
      'openai/readOnlyHint': false,
      ui: { resourceUri: WIDGET_URIS.agentStatus },
    },
  },
  {
    id: 'query_org_memory',
    title: 'Query Organizational Memory',
    description:
      `Use when context was lost between sessions, another agent's work must be continued, or the answer may already exist in team memory. Also known as: search memory, recall decisions, find context, retrieve artifacts, project memory. USE WHEN: user asks about past decisions, context, or knowledge. NEXT: Present relevant results; suggest drill-down with list_entities. ${preferredToolCallout(
        'decisionHistory'
      )} DO NOT USE: for listing current entities — use list_entities instead. Read-only.`,
    inputSchema: {
      query: z.string().min(1).describe('Search query for OrgX memory'),
      scope: z
        .enum(['all', 'artifacts', 'decisions', 'initiatives'])
        .optional()
        .describe('Optional scope filter for the memory search'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of results to return'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.memoryReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
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
      'Use when the user asks how a project is going, what is blocked, or whether an initiative is on track. Successful calls record metered MCP allowance usage but do not change business records. Also known as: project status, roadmap progress, execution health, blockers. USE WHEN: user asks how an initiative is going, or wants a status update. NEXT: If blockers exist, use orgx_inspect for one blocker or orgx_search for related records. DO NOT USE: for an org-wide brief — use orgx_recommend with mode=morning_brief instead.',
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.initiativePulse,
      'openai/toolInvocation/invoking': 'Getting initiative health...',
      'openai/toolInvocation/invoked': "Here's the initiative status",
      'openai/readOnlyHint': false,
      ui: { resourceUri: WIDGET_URIS.initiativePulse },
    },
  },
  {
    id: 'spawn_agent_task',
    title: 'Spawn Agent Task',
    description:
      'Use when the user says "delegate this and tell me when it\'s done" — assign work to a specialist AI agent that owns the task and reports back with results. Also known as: hand this off, assign task, spawn agent, have an agent do it, autonomous work. Automatically checks authorization, rate limits, quality gates, model routing, and budget policy before spawning. Omit model_tier/provider/model to let OrgX auto-route from task complexity; provide them only when the user or verification plan intentionally constrains routing. Returns modelTier, budget, and run details on success, or blockedReason if spawn is denied. USE WHEN: user explicitly wants to delegate work to an agent. NEXT: Use get_agent_status to monitor progress and record_quality_score after reviewing output. DO NOT USE: for creating tasks in the hierarchy — use create_entity type=task instead. Requires agents:write.',
    inputSchema: {
      agent: z.string().min(1).describe('Target agent identifier or alias'),
      task: z.string().min(1).describe('Task instructions for the target agent'),
      context: z
        .string()
        .optional()
        .describe('Optional supporting context or background for the task'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to associate with the spawned task'),
      initiative_name: z
        .string()
        .optional()
        .describe(
          'Optional: Initiative title to resolve automatically if ID is unknown.'
        ),
      workstream_id: z
        .string()
        .optional()
        .describe(
          'Optional workstream UUID. Bind the spawned run to an existing IWMT workstream so progress rolls up into the scaffolded hierarchy and the agent inherits workstream context (preferred over relying on domain resolution). Initiative is inferred from the workstream if initiative_id is omitted.'
        ),
      milestone_id: z
        .string()
        .optional()
        .describe(
          'Optional milestone UUID under the workstream to bind the spawned run to.'
        ),
      task_id: z
        .string()
        .optional()
        .describe(
          'Optional task UUID to bind the spawned run to a specific scaffolded task, enabling direct task-level progress rollup. Use create_entity type=task first if the task does not exist yet.'
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
      model_tier: agentModelTierSchema
        .optional()
        .describe(
          'Optional model tier override. Omit to let OrgX auto-route according to task complexity. Use standard for controlled verification runs; use balanced or precision when explicitly selected by the user, policy, or routing decision. Legacy tiers local/sonnet/opus are accepted for older clients.'
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Optional exact model identifier when the user explicitly chooses one. Omit to let OrgX resolve the model from task, tier, provider, policy, and budget.'
        ),
      provider: agentProviderPreferenceSchema
        .optional()
        .describe(
          'Optional provider preference. Use auto unless the user requests a specific provider or the budget/capability comparison has selected one.'
        ),
      budget_mode: agentBudgetModeSchema
        .optional()
        .describe(
          'Optional budget posture override. Omit to let OrgX apply workspace policy. Use cheapest_valid for controlled reliability/validation runs where cost must be pinned while the loop is being proven.'
        ),
      max_cost_usd: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          'Optional per-task hard cost ceiling in USD. If the estimate exceeds this, OrgX should block, downgrade, or ask for approval before dispatch.'
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.agentRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.taskSpawned,
      'openai/toolInvocation/invoking': 'Assigning task to agent...',
      'openai/toolInvocation/invoked': 'Task assigned',
      ui: { resourceUri: WIDGET_URIS.taskSpawned },
    },
  },
  {
    id: 'handoff_task',
    title: 'Handoff Task',
    description:
      'Use when in-flight work must move to a different specialist agent without losing its context or execution state. Also known as: handoff task, transfer work, change assignee. USE WHEN: a task needs to be reassigned to a different specialist agent. NEXT: Use get_agent_status to confirm the new agent picked up the task. DO NOT USE: for new tasks — use spawn_agent_task instead.',
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.handoffRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.taskSpawned,
      'openai/toolInvocation/invoking': 'Handing off task...',
      'openai/toolInvocation/invoked': 'Task handed off',
      ui: { resourceUri: WIDGET_URIS.taskSpawned },
    },
  },
  {
    id: 'recommend_next_action',
    title: 'Recommend Next Action',
    description:
      'Use this tool to recommend what should happen next after time away or when priority is unclear. It ranks progress gaps, blockers, and execution templates. Pass agent_id or domain for an agent-owned runnable queue instead of the workspace-wide operator queue. Also known as: next best action, prioritize work, unblock project. USE WHEN: the user asks what to do next or needs help prioritizing. NEXT: Execute the recommended action (entity_action, spawn_agent_task, etc.). DO NOT USE: when the user already knows what they want to do. Read-only.',
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
      agent_id: z
        .string()
        .optional()
        .describe(
          'Optional canonical agent ID. When present, only return work assigned to that agent.'
        ),
      domain: z
        .enum([
          'engineering',
          'product',
          'design',
          'marketing',
          'sales',
          'operations',
          'orchestration',
        ])
        .optional()
        .describe(
          'Optional agent domain used to derive the canonical agent ID when agent_id is omitted.'
        ),
      canonical_only: z
        .boolean()
        .optional()
        .describe(
          'When true, return only the canonical next task linked to the active goal spine.'
        ),
      limit: z
        .number()
        .min(1)
        .max(25)
        .optional()
        .describe('Max recommendations to return (default 5, max 25)'),
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
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.searchResults,
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
      compatibilityAliasDescription(
        'decisionHistory',
        'Recall past decisions about a topic, project, customer, feature, or artifact. Also known as: decision log, what did we decide, prior approvals. USE WHEN: older clients still call this tool directly. NEXT: Present results with context; suggest approve_decision or reject_decision if relevant pending ones exist. DO NOT USE: for new prompts or skills. Read-only.'
      ),
    inputSchema: {
      topic: z.string().min(1).describe('Topic or theme to search decision history for'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to scope decision history'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of historical decisions to return'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.decisionReadRequiresAuth,
    _meta: {
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.decisionHistory,
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
      compatibilityAliasDescription(
        'nextUpQueue',
        'Run the composite scoring engine and return ranked queue items with factor breakdowns. USE WHEN: older clients explicitly need raw queue scoring output. NEXT: Execute the top-ranked item via entity_action or spawn_agent_task. DO NOT USE: for new prompts or skills. Read-only.'
      ),
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
      'Read or update scoring engine configuration. USE WHEN: user asks about scoring setup, wants to toggle scoring, adjust weights, or change active signals. action=get to read, action=update to modify. NEXT: Run recommend_next_action to see effects in the preferred workflow, or score_next_up_queue if you need raw queue scoring. Read-only for get, requires initiatives:write for update.',
    inputSchema: {
      action: z.enum(['get', 'update']).describe('get=read config, update=modify settings'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      command_center_id: z.string().optional().describe('Deprecated alias for workspace_id'),
      enabled: z.boolean().optional().describe('Enable/disable scoring_v2 (action=update only)'),
      active_signals: z.array(z.string()).optional().describe('Signal names to activate (action=update only)'),
      weights: z.record(z.number()).optional().describe('Partial weight overrides e.g. { priority: 300 } (action=update only)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
      'Create, list, inspect, or switch the active OrgX workspace for shared memory and project context. Also known as: create workspace, workspace context, team scope, organization scope. USE WHEN: user wants to create a workspace, see workspaces, check which is active, or switch workspaces. action=create creates a workspace and sets it active by default; action=list to see all; action=get for current; action=set to switch.',
    inputSchema: {
      action: z
        .enum(['list', 'get', 'set', 'create'])
        .describe(
          'list=show all, get=current, set=switch active, create=new workspace'
        ),
      workspace_id: z.string().optional().describe('Workspace UUID to switch to (action=set only)'),
      name: z.string().optional().describe('Workspace name (action=create)'),
      title: z.string().optional().describe('Alias for name (action=create)'),
      description: z
        .string()
        .optional()
        .describe('Workspace narrative/description (action=create)'),
      tagline: z.string().optional().describe('Short workspace tagline (action=create)'),
      narrative: z
        .string()
        .optional()
        .describe('Workspace identity narrative (action=create)'),
      key_metrics: z
        .array(z.string())
        .optional()
        .describe('Workspace identity metrics (action=create)'),
      roadmap_url: z.string().optional().describe('Roadmap URL (action=create)'),
      source_links: z
        .array(z.string())
        .optional()
        .describe('Source links for workspace identity (action=create)'),
      set_active: z
        .boolean()
        .optional()
        .describe('Whether to make the new workspace active. Defaults true.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
      'Check organizational setup, configure agents, or set AI operating policies. Also known as: onboarding, agent policy, organization setup. USE WHEN: first connecting, onboarding, or adjusting agent/policy settings. action=status for progress, action=configure_agent to set agent preferences, action=set_policy for org-wide rules.',
    inputSchema: {
      action: z.enum(['status', 'configure_agent', 'set_policy']).describe('Configuration operation'),
      agent_type: z.enum(['product', 'engineering', 'marketing', 'sales', 'operations', 'design', 'orchestrator']).optional().describe('Agent type (configure_agent only)'),
      trust_level: z.enum(['strict', 'balanced', 'autonomous']).optional().describe('Agent autonomy level (configure_agent only)'),
      focus_areas: z.array(z.string()).optional().describe('Agent focus areas (configure_agent only)'),
      approval_required: z.array(z.string()).optional().describe('Actions requiring approval (configure_agent only)'),
      skip_approval: z.array(z.string()).optional().describe('Actions without approval (configure_agent only)'),
      policy_type: z.enum(CONFIGURE_ORG_POLICY_TYPES).optional().describe('Policy type (set_policy only)'),
      config: z.record(z.any()).optional().describe('Policy configuration (set_policy only)'),
      workspace_id: z.string().optional().describe('Workspace UUID to scope policy overrides (set_policy only)'),
      command_center_id: z.string().optional().describe('Deprecated alias for workspace_id (set_policy only)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
      'Get execution statistics, achievements, and session diagnostics. Also known as: usage stats, productivity report, session status. scope=personal for your stats, scope=session for current session diagnostics. Read-only.',
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
  'chatgpt',
  'cursor',
  'copilot',
  'gemini',
  'opencode',
  'cline',
  'goose',
  'qwen',
  'kiro',
  'web-ui',
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

const reportingRuntimeSourceSchema = z.enum([
  'codex_cloud',
  'codex_local',
  'anthropic',
  'orgx_managed',
  'local_openclaw',
  'managed_agent',
  'unknown',
]);

const reportingRuntimeContextSchema = z.object({
  source_runtime: reportingRuntimeSourceSchema
    .optional()
    .describe('Canonical runtime bucket that produced this activity'),
  source_system: z
    .string()
    .optional()
    .describe('Provider or system name, e.g. codex, anthropic, openai-managed'),
  provider: z.string().optional().describe('Model/provider identifier'),
  execution_target: z
    .string()
    .optional()
    .describe('Execution target such as cloud, local, local-openclaw'),
  adapter: z.string().optional().describe('Runtime adapter or bridge name'),
  job_id: z.string().optional().describe('Runtime job id for correlation'),
});

const reportingChokepointSchema = z.object({
  kind: z
    .enum(['blocker', 'approval', 'stall', 'error'])
    .default('blocker')
    .describe('Kind of runtime chokepoint being reported'),
  tier: z
    .enum(['critical', 'blocking', 'attention', 'advisory'])
    .optional()
    .describe('User-facing urgency tier for /live'),
  title: z.string().min(1).describe('Short visible chokepoint title'),
  reason: z.string().min(1).describe('Specific reason execution cannot proceed'),
  suggested_actions: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .describe('Concrete recovery actions to show in /live'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('Additional runtime evidence, never secrets'),
});

const externalQuestionOptionSchema = z.union([
  z.string().min(1).max(500),
  z.object({
    id: z.string().min(1).max(120).optional(),
    label: z.string().min(1).max(500),
    description: z.string().max(2000).optional(),
  }),
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

// Execution-graph (WEG) emission — the deterministic graph + trust ledger any
// client posts to /api/client/live/execution-graph. The backend re-validates
// strictly (run-context, dangling edges, unique ids) and DERIVES trust signals;
// these schemas keep the tool surface aligned without owning the strict rules.
const executionGraphNodeSchema = z.object({
  id: z.string().min(1).max(200).describe('Stable node id within this graph'),
  type: z.enum(['initiative', 'workstream', 'milestone', 'task', 'step']),
  title: z.string().min(1).max(500),
  status: z
    .enum(['pending', 'running', 'blocked', 'completed', 'failed', 'skipped'])
    .describe('Claimed lifecycle status — reconciled against verification'),
  requires_evidence: z
    .boolean()
    .optional()
    .describe('Completing without passing verification is a hallucinated-receipt risk'),
  verification: z
    .object({
      state: z.enum(['unverified', 'passed', 'failed']),
      evidence_ref: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('Checkable artifact / diff / test run behind the claim'),
      method: z.string().min(1).max(120).optional(),
      detail: z.string().max(2000).optional(),
    })
    .optional(),
  economy: z
    .object({
      model: z.string().min(1).max(160).optional(),
      cost_usd: z.number().min(0).optional(),
      tokens: z.number().int().min(0).optional(),
      duration_ms: z.number().int().min(0).optional(),
    })
    .optional()
    .describe('Per-step economy: which model ran this and what it cost'),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const executionGraphEdgeSchema = z.object({
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
  kind: z
    .literal('depends_on')
    .default('depends_on')
    .describe('to must not start before from is verified-complete'),
});

const executionTrustEventSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  kind: z.enum(['claim', 'reconcile', 'violation']),
  node_id: z.string().min(1).max(200).optional(),
  violation_type: z
    .enum([
      'false_completion',
      'hallucinated_receipt',
      'authority_exceeded',
      'dependency_violation',
    ])
    .optional(),
  claimed: z.string().max(500).optional(),
  actual: z.string().max(500).optional(),
  evidence_ref: z.string().min(1).max(500).optional(),
  detail: z.string().max(2000).optional(),
});

export const CLIENT_INTEGRATION_TOOL_DEFINITIONS = [
  {
    id: 'get_operator_chronicle',
    title: 'Get Operator Chronicle',
    description:
      'Use when the user asks what happened, wants to catch up after time away, or needs a reporting window summarized with decisions and proof. Read the operator chronicle: decision chronology, yesterday/week/30-day rollups, reportingNarrative.briefMarkdown, artifacts, PR receipts, active initiatives, goals, top priorities, velocity, and reporting gaps for a workspace. USE WHEN: user asks what changed yesterday, this week, or this month; asks for decision chronology, top priorities, PR velocity, artifacts, goals, or what OrgX is missing. NEXT: present reportingNarrative.briefMarkdown first, then use reportingNarrative.nextAction and topPriorities for drill-down. Read-only.',
    inputSchema: {
      workspace_id: z
        .string()
        .optional()
        .describe('Workspace UUID to scope the chronicle.'),
      command_center_id: z
        .string()
        .optional()
        .describe('Deprecated alias for workspace_id.'),
      period: z
        .enum(['day', 'week', '30d'])
        .optional()
        .describe('Reporting window. day=24h, week=7d, 30d=30 days.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Loading operator chronicle...',
      'openai/toolInvocation/invoked': 'Operator chronicle ready',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'check_execution_readiness',
    title: 'Check Execution Readiness',
    description:
      'Check whether the workspace has the credentials needed to dispatch agent work, BEFORE spawning. USE WHEN: about to call orgx_spawn / spawn_agent_task and you want to confirm execution credentials exist — avoids dispatching a run that fails on missing keys. NEXT: if not ready, surface what is missing and resolve it; if ready, proceed to orgx_spawn. Read-only; dispatches nothing.',
    inputSchema: {
      workspace_id: z
        .string()
        .optional()
        .describe('Workspace UUID to check. Defaults to the MCP session workspace.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Checking execution readiness...',
      'openai/toolInvocation/invoked': 'Execution readiness checked',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_emit_activity',
    title: 'Emit OrgX Activity',
    description:
      'Use when an agent is mid-execution and its progress must stay visible to operators and to the next agent that resumes the run. Emit append-only run telemetry for OrgX control-plane reporting. USE WHEN: agent is executing and needs to report progress. NEXT: Continue work; emit again at each phase change. DO NOT USE: for entity status changes — use entity_action instead. Setting phase="completed" records telemetry only and does not mark tasks, workstreams, or initiatives complete.',
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
      phase: reportingPhaseSchema
        .optional()
        .describe('Optional reporting phase for the activity event'),
      progress_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Optional progress percentage associated with this activity'),
      level: z
        .enum(['info', 'warn', 'error'])
        .optional()
        .describe('Optional severity level for the activity event'),
      next_step: z
        .string()
        .optional()
        .describe('Optional next step to surface after this activity event'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Optional structured metadata to attach to the activity event'),
      runtime: reportingRuntimeContextSchema
        .optional()
        .describe(
          'Runtime provenance used by /live to bucket cloud, local, Anthropic, managed, and OpenClaw chokepoints'
        ),
      chokepoint: reportingChokepointSchema
        .optional()
        .describe(
          'Durable blocker/stall/error/approval to surface in /live when execution cannot proceed'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Emitting activity...',
      'openai/toolInvocation/invoked': 'Activity emitted',
    },
  },
  {
    id: 'orgx_request_attention',
    title: 'Request OrgX Attention',
    description:
      'Forward a typed human-interruption request while preserving the originating run and session. Use kind=question for missing context, permission for a scoped tool or file action, approval for owner sign-off, and recovery only when automatic retry cannot safely continue. USE WHEN: a native client reaches a genuine human decision that prevents the preserved session from continuing safely. NEXT: poll orgx_poll_attention; resume only after the answer is applied, then call orgx_ack_attention so Live can show that work actually restarted. DO NOT USE: for internal turn boundaries or retryable runtime events.',
    inputSchema: {
      initiative_id: z.string().uuid().describe('Initiative UUID'),
      attention_kind: z
        .enum(['question', 'permission', 'approval', 'recovery'])
        .describe('Why human attention is required'),
      idempotency_key: z
        .string()
        .min(1)
        .max(120)
        .describe('Stable key for safe retries of this request'),
      question: z
        .string()
        .min(1)
        .max(500)
        .describe('The concrete request the owner must answer'),
      context: z
        .string()
        .max(5000)
        .optional()
        .describe('What led here, what is preserved, and what the answer changes'),
      impact_if_delayed: z
        .string()
        .max(1000)
        .optional()
        .describe('What remains paused or at risk until the owner responds'),
      options: z
        .array(externalQuestionOptionSchema)
        .max(10)
        .optional()
        .describe('Pre-allocated valid responses'),
      response_mode: z
        .enum(['single_select', 'multi_select', 'free_text', 'confirmation'])
        .optional()
        .describe('Answer control; inferred from options when omitted'),
      recommended_option_id: z
        .string()
        .max(120)
        .optional()
        .describe('Recommended option when the agent can justify one'),
      recommended_action: z
        .string()
        .max(1000)
        .optional()
        .describe('Concise recommendation and why it is safest or highest leverage'),
      blocking: z.boolean().optional().describe('Whether linked work is gated; default true'),
      urgency: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Owner attention urgency; default medium'),
      workstream_id: z
        .string()
        .uuid()
        .optional()
        .describe('Affected workstream UUID'),
      run_id: z.string().uuid().optional().describe('Existing OrgX run UUID'),
      correlation_id: z
        .string()
        .max(120)
        .optional()
        .describe('Stable client correlation when run_id is unavailable'),
      source_client: reportingSourceClientSchema
        .optional()
        .describe('Originating native client'),
      runtime: reportingRuntimeContextSchema
        .optional()
        .describe('Runtime and provider provenance for the preserved execution'),
      source_session_id: z
        .string()
        .max(255)
        .optional()
        .describe('Originating client session identifier'),
      source_tool: z
        .string()
        .min(1)
        .max(120)
        .describe('Native hook or tool that requested attention'),
      source_event_id: z
        .string()
        .max(255)
        .optional()
        .describe('Originating hook or tool-call event identifier'),
      source_ref: z
        .record(z.unknown())
        .optional()
        .describe('Additional non-secret source and continuation references'),
      continuation: z
        .object({
          strategy: z
            .enum([
              'reply_in_place',
              'resume_session',
              'followup_from_checkpoint',
              'poll',
              'none',
            ])
            .optional(),
          session_handle: z.string().max(500).optional(),
          thread_id: z.string().max(500).optional(),
          turn_id: z.string().max(500).optional(),
          tool_call_id: z.string().max(500).optional(),
          checkpoint_id: z.string().uuid().optional(),
          peer_id: z.string().uuid().optional(),
          capability_version: z.string().max(64).optional(),
        })
        .optional()
        .describe('How OrgX should return the answer to the preserved client session'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Additional non-secret request context'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Forwarding attention request...',
      'openai/toolInvocation/invoked': 'Attention request is waiting',
    },
  },
  {
    id: 'orgx_poll_attention',
    title: 'Poll OrgX Attention',
    description:
      'Read the durable owner response and continuation state for orgx_request_attention. USE WHEN: the client has a preserved attention_id and must determine whether the owner answered without creating another request. When resolved=true, apply the answer to the preserved session. NEXT: call orgx_ack_attention with state=resuming, then state=resumed only after native execution actually restarts. Read-only.',
    inputSchema: {
      attention_id: z.string().uuid().describe('Attention/decision UUID'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Checking owner response...',
      'openai/toolInvocation/invoked': 'Attention status checked',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_ack_attention',
    title: 'Acknowledge OrgX Continuation',
    description:
      'Report what happened after an owner answered an attention request. Use answer_received when stored locally, resuming when native continuation begins, resumed only after work emits again, resume_failed with an actionable detail when it cannot restart, or cancelled when intentionally stopped. USE WHEN: the source client has objective evidence for a continuation state transition. NEXT: keep the same attention_id and idempotency key through terminal resumed, resume_failed, or cancelled state. DO NOT USE: to infer that work resumed merely because the decision was resolved; wait for native execution evidence. This receipt prevents Live from claiming work is moving before the source client confirms it.',
    inputSchema: {
      attention_id: z.string().uuid().describe('Attention/decision UUID'),
      state: z
        .enum([
          'answer_received',
          'resuming',
          'resumed',
          'resume_failed',
          'cancelled',
        ])
        .describe('Native continuation state proven by this receipt'),
      idempotency_key: z
        .string()
        .min(1)
        .max(180)
        .describe('Stable key for retrying the same receipt'),
      session_handle: z
        .string()
        .max(500)
        .optional()
        .describe('Native session handle that processed the answer'),
      client_event_id: z
        .string()
        .max(500)
        .optional()
        .describe('Client event proving the continuation transition'),
      detail: z
        .string()
        .max(2000)
        .optional()
        .describe('Actionable continuation result or failure detail'),
      occurred_at: z
        .string()
        .datetime()
        .optional()
        .describe('ISO timestamp when this state was observed'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Additional non-secret receipt metadata'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Recording continuation receipt...',
      'openai/toolInvocation/invoked': 'Continuation receipt recorded',
    },
  },
  {
    id: 'orgx_request_question',
    title: 'Request OrgX Question',
    description:
      'Pause at a safe checkpoint and forward a contextual question to the initiative owner. OrgX renders the right single-select, multi-select, free-text, or confirmation control and preserves the source run/session so work can resume with the exact answer. USE WHEN: Claude Code AskUserQuestion, Codex request_user_input, Cursor, OpenClaw, or another client needs human judgment to continue. NEXT: poll orgx_poll_question with the returned question_id; continue only when continuation.should_resume is true. DO NOT USE: for runtime failures with an automatic retry path — report a chokepoint instead.',
    inputSchema: {
      initiative_id: z.string().uuid().describe('Initiative UUID'),
      idempotency_key: z
        .string()
        .min(1)
        .max(120)
        .describe('Stable key for safe retries of the same question'),
      question: z
        .string()
        .min(1)
        .max(500)
        .describe('The concrete question the owner must answer'),
      context: z
        .string()
        .max(5000)
        .optional()
        .describe('What led here, what is preserved, and what the answer changes'),
      options: z
        .array(externalQuestionOptionSchema)
        .max(10)
        .optional()
        .describe('Pre-allocated answers for single-select or multi-select questions'),
      response_mode: z
        .enum(['single_select', 'multi_select', 'free_text', 'confirmation'])
        .optional()
        .describe('Answer control; inferred from options when omitted'),
      blocking: z
        .boolean()
        .optional()
        .describe('Whether this answer gates the linked work; default true'),
      urgency: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Owner attention urgency; default medium'),
      workstream_id: z
        .string()
        .uuid()
        .optional()
        .describe('Affected workstream UUID'),
      run_id: z.string().uuid().optional().describe('Existing run UUID'),
      correlation_id: z
        .string()
        .max(120)
        .optional()
        .describe('Required with source_client when run_id is absent'),
      source_client: reportingSourceClientSchema
        .optional()
        .describe('Originating client; required when run_id is absent'),
      runtime: reportingRuntimeContextSchema
        .optional()
        .describe('Runtime/provider provenance for the paused execution'),
      source_session_id: z
        .string()
        .max(255)
        .optional()
        .describe('Claude, Codex, Cursor, or other client session identifier'),
      source_tool: z
        .string()
        .min(1)
        .max(120)
        .describe('Originating tool, e.g. AskUserQuestion or request_user_input'),
      source_event_id: z
        .string()
        .max(255)
        .optional()
        .describe('Originating question/tool-call event identifier'),
      source_ref: z
        .record(z.unknown())
        .optional()
        .describe('Additional non-secret client continuation references'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Additional non-secret structured context'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Forwarding question to owner...',
      'openai/toolInvocation/invoked': 'Question is waiting for an answer',
    },
  },
  {
    id: 'orgx_poll_question',
    title: 'Poll OrgX Question',
    description:
      'Read the durable answer receipt for a question previously forwarded with orgx_request_question. USE WHEN: an external client is paused for human input. NEXT: when resolved=true and continuation.should_resume=true, resume the preserved source session with answer and resolution_context; when false, remain paused without creating another question. Read-only.',
    inputSchema: {
      question_id: z
        .string()
        .uuid()
        .describe('Question/decision UUID returned by orgx_request_question'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    securitySchemes: SECURITY_SCHEMES.entityReadRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Checking for an owner answer...',
      'openai/toolInvocation/invoked': 'Question status checked',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'orgx_emit_execution_graph',
    title: 'Emit OrgX Execution Graph',
    description:
      'Emit the deterministic execution graph + trust ledger for the active run: nodes (claimed status + verification evidence), depends_on edges, and trust events. OrgX derives false-completion, hallucinated-receipt, and dependency-violation signals from this and surfaces them on /live. USE WHEN: reporting the structured shape of multi-step work — NOT a single progress line (use orgx_emit_activity for that). NEXT: continue work; re-emit as the graph advances (idempotent per run + graph fingerprint). DO NOT USE to mark entities complete — telemetry only.',
    inputSchema: {
      initiative_id: z.string().uuid().describe('Initiative UUID'),
      run_id: z.string().uuid().optional().describe('Existing run UUID'),
      correlation_id: z
        .string()
        .optional()
        .describe('Required when run_id is not provided'),
      source_client: reportingSourceClientSchema
        .optional()
        .describe('Required when run_id is not provided'),
      runtime: reportingRuntimeContextSchema
        .optional()
        .describe('Runtime provenance used by /live to bucket chokepoints'),
      summary: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('Optional human-readable rollup of the graph state'),
      nodes: z
        .array(executionGraphNodeSchema)
        .min(1)
        .max(2000)
        .describe('Execution graph nodes; each carries claimed status + optional verification'),
      edges: z
        .array(executionGraphEdgeSchema)
        .max(8000)
        .optional()
        .describe('depends_on edges between node ids'),
      trust_events: z
        .array(executionTrustEventSchema)
        .max(2000)
        .optional()
        .describe('Explicit trust-ledger events such as authority_exceeded that OrgX cannot infer from graph shape'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Optional structured metadata to attach to the execution-graph emission'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Emitting execution graph...',
      'openai/toolInvocation/invoked': 'Execution graph emitted',
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
      operations: z
        .array(applyChangesetOperationSchema)
        .min(1)
        .max(25)
        .describe('Ordered task, milestone, and decision mutations to apply atomically'),
      run_id: z.string().uuid().optional().describe('Existing run UUID'),
      correlation_id: z
        .string()
        .optional()
        .describe('Required when run_id is not provided'),
      source_client: reportingSourceClientSchema
        .optional()
        .describe('Required when run_id is not provided'),
      runtime: reportingRuntimeContextSchema
        .optional()
        .describe(
          'Runtime provenance used by /live to bucket cloud, local, Anthropic, managed, and OpenClaw changeset decisions'
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.changesetRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Applying changeset...',
      'openai/toolInvocation/invoked': 'Changeset applied',
    },
  },
  {
    id: 'consolidate_pr',
    title: 'Consolidate Pull Request',
    description:
      'Use when the user or an engineering agent must show a pull request actually shipped and needs durable review proof, not a status glance. Generate and persist an orchestration.consolidation_pass receipt for a GitHub pull request. Requires OrgX server-side GitHub credentials; if the GitHub token is unavailable, use GitHub tools for PR facts and return a structured blocker instead of retrying. USE WHEN: Eli or another engineering agent needs a durable PR review receipt with reading order, existence evidence, deduped findings, verdict, and server-derived AQ score. NEXT: inspect the returned artifact_id or attach it to task completion proof. DO NOT USE WHEN: only asking for PR status; use GitHub tools instead.',
    inputSchema: {
      pr_url: z
        .string()
        .url()
        .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?(?:[?#].*)?$/)
        .describe(
          'GitHub pull request URL, e.g. https://github.com/org/repo/pull/123. OrgX must have server-side GitHub credentials to inspect it.'
        ),
      workspace_id: z.string().uuid().optional().describe('OrgX workspace UUID'),
      initiative_id: z
        .string()
        .uuid()
        .optional()
        .describe('Initiative to attach the consolidation_pass artifact to'),
      task_id: z
        .string()
        .uuid()
        .optional()
        .describe('Task to attach the consolidation_pass artifact to'),
      decision_id: z
        .string()
        .uuid()
        .optional()
        .describe('Decision to attach the consolidation_pass artifact to'),
      commit_sha: z
        .string()
        .min(7)
        .optional()
        .describe(
          'Override commit SHA for idempotency; defaults to merge commit or PR head SHA'
        ),
      verdict: z
        .enum(['ship', 'simplify_first', 'escalate'])
        .optional()
        .describe('Optional verdict override; defaults from PR state'),
      reviewer_note: z
        .string()
        .max(2000)
        .optional()
        .describe('Optional reviewer note to include in critic evidence'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    securitySchemes: SECURITY_SCHEMES.entityWriteRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Consolidating pull request...',
      'openai/toolInvocation/invoked': 'Pull request consolidated',
    },
  },
  {
    id: 'sync_client_state',
    title: 'Sync with OrgX',
    description:
      'Sync local agent context with OrgX organizational memory. Also known as: push session memory, pull project context, cross-tool continuity. Push decisions/logs, pull active context. USE WHEN: at session start and periodically during long sessions. NEXT: Review returned initiatives and pending decisions, ask user what to focus on. USE BEFORE: spawning agent work, to ensure latest state.',
    inputSchema: {
      memory: z.string().optional().describe('Local MEMORY.md content to push'),
      daily_log: z.string().optional().describe("Today's session log to push"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.memorySyncRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Syncing with OrgX...',
      'openai/toolInvocation/invoked': 'Org context synced',
    },
  },
  {
    id: 'check_spawn_guard',
    title: 'Check Spawn Authorization',
    description:
      'Check whether agent delegation is allowed before assigning work. Also known as: spawn guard, delegation authorization, agent rate limit. Returns model tier, rate limit status, quality gate, and task verification. USE WHEN: before any spawn_agent_task call. NEXT: If allowed, proceed with spawn_agent_task using the returned model tier. If blocked, inform user of the reason.',
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
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    securitySchemes: SECURITY_SCHEMES.agentReadRequiresAuth,
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
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe('OrgX task ID (snake_case alias; taskId also accepted)'),
      taskId: z
        .string()
        .min(1)
        .optional()
        .describe('OrgX task ID (backend/camelCase alias)'),
      agent_domain: z
        .string()
        .min(1)
        .optional()
        .describe('Agent domain that completed the task (agentDomain/domain also accepted)'),
      agentDomain: z
        .string()
        .min(1)
        .optional()
        .describe('Agent domain that completed the task (backend/camelCase alias)'),
      domain: z
        .string()
        .min(1)
        .optional()
        .describe('Short alias for agentDomain'),
      score: z
        .number()
        .min(1)
        .max(5)
        .describe('Quality score: 1=poor, 3=acceptable, 5=excellent'),
      scored_by: z
        .enum(['human', 'auto', 'peer'])
        .optional()
        .describe('Who scored this (snake_case alias; scoredBy also accepted)'),
      scoredBy: z
        .enum(['human', 'auto', 'peer'])
        .optional()
        .describe('Who scored this (backend/camelCase alias)'),
      notes: z.string().optional().describe('Notes on the score'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.writeRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Recording quality score...',
      'openai/toolInvocation/invoked': 'Score recorded',
    },
  },
  {
    id: 'classify_task_model',
    title: 'Estimate Task Routing',
    description:
      'Classify a task and get pre-spawn model routing context. Also known as: estimate task cost, model routing estimate, cost frontier, route task. USE WHEN: deciding which model/budget posture to use before agent work. Returns the recommended tier and, when the backend can compute it, estimated tokens/cost and candidate route comparisons. NEXT: Use the returned tier or cost frontier when spawning via spawn_agent_task. Read-only.',
    inputSchema: {
      title: z.string().min(1).describe('Task title'),
      description: z.string().optional().describe('Task description'),
      entity_type: z
        .string()
        .optional()
        .describe('Entity type: task, decision, initiative'),
      domain: z.string().optional().describe('Agent domain'),
      model_tier: agentModelTierSchema
        .optional()
        .describe('Optional tier to estimate. Omit to let OrgX auto-route.'),
      provider: agentProviderPreferenceSchema
        .optional()
        .describe('Optional provider preference for the estimate. Use auto unless explicitly selected.'),
      budget_mode: agentBudgetModeSchema
        .optional()
        .describe('Optional budget posture for the estimate. Use cheapest_valid for controlled validation runs only.'),
      max_cost_usd: z
        .number()
        .nonnegative()
        .optional()
        .describe('Optional per-task hard cost ceiling to compare against the estimate.'),
      estimate_only: z
        .boolean()
        .optional()
        .describe('When true, return pre-spawn estimate context without dispatching work.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.agentReadRequiresAuth,
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
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
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
      'Get execution stream progress, blockers, and computed metrics for an initiative. Also known as: project stream state, execution health, workstream progress. USE WHEN: checking stream execution status for an initiative. NEXT: If streams are blocked, use entity_action to unblock. DO NOT USE: for raw stream records — use list_entities type=stream instead. Read-only.',
    inputSchema: {
      initiative_id: z.string().min(1).describe('The initiative ID'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: SECURITY_SCHEMES.readOptionalAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Getting initiative stream state...',
      'openai/toolInvocation/invoked': 'Retrieved stream state',
      'openai/readOnlyHint': true,
    },
  },
  {
    id: 'manage_lifecycle',
    title: 'Manage Lifecycle (pause/resume/retry/cancel)',
    description:
      'Pause, resume, retry, or cancel any node in the work hierarchy — an initiative, workstream, milestone, task, or run. Propagates to descendant tasks + active runs. USE WHEN: the user wants to halt, restart, or re-run part of an initiative. resume/retry re-dispatch the work; pause/cancel stop active runs. NEXT: get_initiative_pulse to confirm. DO NOT USE: to mark a task done — use entity_action instead.',
    inputSchema: {
      level: z
        .enum(['initiative', 'workstream', 'milestone', 'task', 'run'])
        .describe('Which hierarchy node to act on'),
      id: z.string().min(1).describe('UUID of the node'),
      action: z
        .enum(['pause', 'resume', 'retry', 'cancel'])
        .describe('Lifecycle action to apply'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    securitySchemes: SECURITY_SCHEMES.handoffRequiresAuth,
    _meta: {
      'openai/toolInvocation/invoking': 'Applying lifecycle action...',
      'openai/toolInvocation/invoked': 'Lifecycle action applied',
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

/**
 * Resolve the canonical payload returned by a stream coordination endpoint.
 *
 * Most legacy stream endpoints wrap their payload in `data`. The lifecycle
 * endpoint intentionally returns its receipt fields (`action`, `level`,
 * `affected`, and `message`) at the top level. Keeping that distinction here
 * prevents a successful lifecycle call from being flattened to an empty `{}`.
 */
export function resolveStreamToolPayload(
  toolId: string,
  result: Record<string, unknown>
): Record<string, unknown> {
  if (toolId === 'manage_lifecycle') return result;
  const data = result.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
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

export function resolveLifecycleActionAlias(
  type: string,
  action: string | undefined
): string | undefined {
  if (!action) return action;
  if (action === 'launch') {
    return LAUNCH_ACTION_MAP[type] || action;
  }
  if (action === 'pause') {
    return PAUSE_ACTION_MAP[type] || action;
  }
  return action;
}

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
      return 'Decision approved. The assigned agent can continue, and you can track follow-through in agent status or the live view.';

    case 'reject_decision':
      return 'Decision rejected with guidance. The assigned agent will revise their approach before attempting the work again.';

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
      if (action === 'create') return (data.message as string) ?? 'Workspace created.';
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
      const id =
        (data.session_id as string | undefined) ??
        (data.id as string | undefined);
      const title = data.title as string | undefined;
      const uri = data.uri as string | undefined;
      const refLine = id
        ? `Session ID: ${id}${uri ? `\nSession URI: ${uri}` : ''}`
        : 'Session created.';
      return `📋 Started plan session "${title || 'Untitled'}"\n${refLine}\n\nI'll track your edits and learn from your planning patterns. Use improve_plan to get suggestions, and complete_plan when you're done building.`;
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
          (s) => {
            const sessionId =
              (s as Record<string, unknown>).session_id ??
              (s as Record<string, unknown>).id;
            return `- "${s.title || s.feature_name}" (session_id: ${sessionId})`;
          }
        )
        .join('\n');
      return `📋 Active planning sessions:\n${list}\n\nContinue an existing session or start a new one.`;
    }

    case 'improve_plan': {
      const suggestions = data.suggestions as
        | Array<{
            type: string;
            section?: string;
            suggestion: string;
            rationale?: string;
            evidence?: string;
            confidence?: number;
            source?: string;
          }>
        | undefined;
      const domains = data.domains_detected as string[] | undefined;
      const learned = data.learned_from_past as number | undefined;
      const analysisSummary =
        typeof data.analysis_summary === 'string'
          ? data.analysis_summary.trim()
          : '';
      const generation =
        data.generation &&
        typeof data.generation === 'object' &&
        !Array.isArray(data.generation)
          ? (data.generation as Record<string, unknown>)
          : null;
      const modelReceipt =
        generation?.source === 'model' &&
        typeof generation.model === 'string' &&
        typeof generation.provider === 'string'
          ? {
              model: generation.model,
              provider: generation.provider,
              responseId:
                typeof generation.response_id === 'string'
                  ? generation.response_id
                  : null,
              requestedModel:
                typeof generation.requested_model === 'string'
                  ? generation.requested_model
                  : null,
              failoverUsed: generation.failover_used === true,
              inputTokens:
                typeof generation.input_tokens === 'number'
                  ? generation.input_tokens
                  : null,
              outputTokens:
                typeof generation.output_tokens === 'number'
                  ? generation.output_tokens
                  : null,
            }
          : null;

      let response = modelReceipt
        ? `🤖 LLM receipt: ${modelReceipt.provider}/${modelReceipt.model}`
        : '';
      if (
        modelReceipt &&
        modelReceipt.inputTokens !== null &&
        modelReceipt.outputTokens !== null
      ) {
        response += ` (${modelReceipt.inputTokens.toLocaleString()} input / ${modelReceipt.outputTokens.toLocaleString()} output tokens)`;
      }
      if (modelReceipt?.responseId) {
        response += ` · response ${modelReceipt.responseId}`;
      }
      if (
        modelReceipt?.failoverUsed &&
        modelReceipt.requestedModel &&
        modelReceipt.requestedModel !== modelReceipt.model
      ) {
        response += ` · failover from ${modelReceipt.requestedModel}`;
      }
      if (analysisSummary) {
        response += `${response ? '\n\n' : ''}🧭 ${analysisSummary}`;
      }

      if (!suggestions || suggestions.length === 0) {
        const noSuggestionsMessage = modelReceipt
          ? '✅ The model found no material improvements to suggest.'
          : '✅ No material improvements were returned.';
        return `${response ? `${response}\n\n` : ''}${noSuggestionsMessage}`;
      }

      response += `${response ? '\n\n' : ''}💡 Suggestions for your plan:\n\n`;
      for (const s of suggestions.slice(0, 5)) {
        const icon = s.type === 'missing' ? '⚠️' : '💡';
        const section = s.section?.trim() ? `**${s.section.trim()}** — ` : '';
        response += `${icon} ${section}${s.suggestion}`;
        if (s.rationale) response += `\n   Why: ${s.rationale}`;
        if (s.evidence) response += `\n   Evidence: ${s.evidence}`;
        const provenance = [
          s.source,
          typeof s.confidence === 'number'
            ? `${Math.round(s.confidence * 100)}% confidence`
            : undefined,
        ].filter((value): value is string => Boolean(value));
        if (provenance.length > 0) {
          response += `\n   _${provenance.join(' · ')}_`;
        }
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
