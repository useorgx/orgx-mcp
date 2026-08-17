/**
 * generate-tool-catalog.ts
 *
 * Reads all MCP tool definitions from source-of-truth modules and writes
 * a unified tool-catalog.json used by the MDX generator and CI drift checks.
 *
 * Run: pnpm catalog:generate
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Source imports
// ---------------------------------------------------------------------------

import {
  CHATGPT_TOOL_DEFINITIONS,
  PLAN_SESSION_TOOLS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
  STREAM_TOOL_DEFINITIONS,
  ENTITY_TYPES,
  LIFECYCLE_ENTITY_TYPES,
} from '../src/toolDefinitions';

import { FLYWHEEL_TOOL_DEFINITIONS } from '../src/flywheelTools';
import { TOOL_PROFILES } from '../src/toolProfiles';
import { AUTHORIZATION_POLICY } from '../src/authorizationPolicy';
import {
  CONTRACT_TOOL_DEFINITIONS,
  INLINE_TOOL_CONTRACTS,
  V2_ORGX_TOOL_ID_SET,
} from '../src/contractTools';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogTool {
  id: string;
  title: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  responseExample?: Record<string, unknown>;
  securityScopes: string[];
  readOnly: boolean;
  source:
    | 'chatgpt'
    | 'plan_session'
    | 'client_integration'
    | 'stream'
    | 'flywheel'
    | 'contract'
    | 'inline';
  profiles: string[];
  deprecated?: { replacement: string; note: string };
}

interface ToolCatalog {
  generatedAt: string;
  sourceHash: string;
  version: string;
  totalTools: number;
  categories: string[];
  tools: CatalogTool[];
  deprecated: Array<{ id: string; replacement: string; note: string }>;
}

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

const TOOL_CATEGORY_MAP: Record<string, string> = {
  // MCP v2 public surface
  orgx_bootstrap: 'MCP v2 Public Surface',
  orgx_inspect: 'MCP v2 Public Surface',
  orgx_search: 'MCP v2 Public Surface',
  orgx_recommend: 'MCP v2 Public Surface',
  orgx_write: 'MCP v2 Public Surface',
  orgx_attach: 'MCP v2 Public Surface',
  orgx_act: 'MCP v2 Public Surface',
  orgx_emit_activity: 'MCP v2 Public Surface',
  orgx_plan: 'MCP v2 Public Surface',
  orgx_spawn: 'MCP v2 Public Surface',
  orgx_decide: 'MCP v2 Public Surface',
  orgx_submit_receipt: 'MCP v2 Public Surface',

  // High-recall wrapper tools for natural-language tool routing
  remember_decision: 'Recommended Entry Points',
  recall_memory: 'Recommended Entry Points',
  approve_agent_work: 'Recommended Entry Points',
  delegate_agent_task: 'Recommended Entry Points',
  track_project_progress: 'Recommended Entry Points',

  // Decision tools
  get_pending_decisions: 'Decisions',
  approve_decision: 'Decisions',
  reject_decision: 'Decisions',
  get_decision_history: 'Decisions',

  // Agent tools
  get_agent_status: 'Agents',
  spawn_agent_task: 'Agents',
  handoff_task: 'Agents',
  recommend_next_action: 'Agents',

  // Memory
  query_org_memory: 'Memory',

  // Initiative monitoring
  get_initiative_pulse: 'Initiative Monitoring',

  // Scoring & Queue
  score_next_up_queue: 'Scoring & Queue',
  get_scoring_signals: 'Scoring & Queue',
  get_scoring_config: 'Scoring & Queue',
  set_scoring_config: 'Scoring & Queue',
  set_scoring_weights: 'Scoring & Queue',
  pin_queue_item: 'Scoring & Queue',
  unpin_queue_item: 'Scoring & Queue',
  skip_workstream: 'Scoring & Queue',

  // Planning
  start_plan_session: 'Planning',
  get_active_sessions: 'Planning',
  improve_plan: 'Planning',
  record_plan_edit: 'Planning',
  complete_plan: 'Planning',

  // Client integration
  orgx_emit_activity: 'Client Integration',
  orgx_apply_changeset: 'Client Integration',
  consolidate_pr: 'Client Integration',
  sync_client_state: 'Client Integration',
  check_spawn_guard: 'Client Integration',
  record_quality_score: 'Client Integration',
  classify_task_model: 'Client Integration',
  review_artifact: 'Client Integration',

  // Streams
  update_stream_progress: 'Streams',
  get_initiative_stream_state: 'Streams',

  // Entity management
  list_entities: 'Entity Management',
  create_entity: 'Entity Management',
  entity_action: 'Entity Management',
  update_entity: 'Entity Management',
  verify_entity_completion: 'Entity Management',
  scaffold_initiative: 'Entity Management',
  batch_create_entities: 'Entity Management',
  batch_delete_entities: 'Entity Management',
  get_task_with_context: 'Entity Management',
  comment_on_entity: 'Entity Management',
  list_entity_comments: 'Entity Management',

  // Organization
  get_org_snapshot: 'Organization',

  // Workspace
  workspace: 'Workspace',

  // Onboarding
  configure_org: 'Onboarding',

  // Stats
  stats: 'Stats',

  // Billing
  account_status: 'Billing',
  account_upgrade: 'Billing',
  account_usage_report: 'Billing',

  // Intelligence Flywheel
  get_outcome_attribution: 'Intelligence Flywheel',
  record_outcome: 'Intelligence Flywheel',
  get_my_trust_context: 'Intelligence Flywheel',
  start_autonomous_session: 'Intelligence Flywheel',
  get_morning_brief: 'Intelligence Flywheel',
  get_relevant_learnings: 'Intelligence Flywheel',
  submit_learning: 'Intelligence Flywheel',
};

// ---------------------------------------------------------------------------
// Deprecated tool alias map
// ---------------------------------------------------------------------------

const DEPRECATED_TOOLS: Array<{
  id: string;
  replacement: string;
  note: string;
}> = [
  {
    id: 'create_initiative',
    replacement:
      'create_entity type=initiative (or scaffold_initiative for full hierarchy)',
    note: 'The create_initiative tool has been replaced by the generic entity system.',
  },
  {
    id: 'list_initiatives',
    replacement: 'list_entities type=initiative',
    note: 'The list_initiatives tool has been replaced by the generic entity system.',
  },
  {
    id: 'create_milestone',
    replacement: 'create_entity type=milestone',
    note: 'The create_milestone tool has been replaced by the generic entity system.',
  },
  {
    id: 'create_task',
    replacement: 'create_entity type=task',
    note: 'The create_task tool has been replaced by the generic entity system.',
  },
  {
    id: 'launch_entity',
    replacement: 'entity_action action=launch',
    note: 'The launch_entity tool has been replaced by the unified entity_action tool.',
  },
  {
    id: 'pause_entity',
    replacement: 'entity_action action=pause',
    note: 'The pause_entity tool has been replaced by the unified entity_action tool.',
  },
  {
    id: 'complete_entity',
    replacement: 'entity_action action=complete',
    note: 'The complete_entity tool has been replaced by the unified entity_action tool.',
  },
];

// ---------------------------------------------------------------------------
// Inline-registered tool metadata (tools in index.ts, not in arrays)
// ---------------------------------------------------------------------------

const entityTypeEnum = z.enum(ENTITY_TYPES as unknown as [string, ...string[]]);
const lifecycleTypeEnum = z.enum(
  LIFECYCLE_ENTITY_TYPES as unknown as [string, ...string[]]
);

function extractScopes(securitySchemes: unknown): string[] {
  if (!Array.isArray(securitySchemes)) return [];
  const scopes = new Set<string>();
  for (const scheme of securitySchemes) {
    if (
      scheme &&
      typeof scheme === 'object' &&
      'scopes' in scheme &&
      Array.isArray(scheme.scopes)
    ) {
      for (const scope of scheme.scopes) {
        if (typeof scope === 'string') scopes.add(scope);
      }
    }
  }
  return [...scopes];
}

const INLINE_TOOL_METADATA: Array<{
  id: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  securityScopes: string[];
  readOnly: boolean;
  profiles?: string[];
}> = [
  {
    id: 'remember_decision',
    title: 'Remember Decision',
    description:
      'Use when the user says "remember this decision" or a judgment call must not be relitigated next session. Saves the decision to organizational memory so agents and teammates can recall it later. Also known as: decision log, team memory, agent memory, record decision, remember what we decided.',
    inputSchema: z.object({
      decision: z
        .string()
        .min(1)
        .describe('Decision text or short decision title to remember'),
      context: z
        .string()
        .optional()
        .describe('Optional background, rationale, or source context'),
      title: z.string().optional().describe('Optional explicit decision title'),
      initiative_id: z.string().optional().describe('Optional parent initiative UUID'),
      workspace_id: z.string().optional().describe('Workspace UUID'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .optional()
        .describe('Priority / urgency'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
    profiles: ['memory'],
  },
  {
    id: 'recall_memory',
    title: 'Recall Memory',
    description:
      'Use when the user asks "what did we decide about X" or prior context must be recovered from team memory. Searches organizational memory for prior decisions, artifacts, project context, and team knowledge. Also known as: search memory, recall decisions, find context, retrieve artifacts, what did we decide.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search query for organizational memory'),
      scope: z
        .enum(['all', 'artifacts', 'decisions', 'initiatives'])
        .optional()
        .describe('Optional scope filter for the memory search'),
      limit: z.number().optional().describe('Maximum number of results to return'),
    }),
    securityScopes: ['memory:read'],
    readOnly: true,
    profiles: ['memory'],
  },
  {
    id: 'approve_agent_work',
    title: 'Approve Agent Work',
    description:
      'Use when agent work is paused waiting for a human yes — review pending decisions, then approve or reject them. Also known as: pending approvals, agent blocked, sign off, review decisions, approve AI work.',
    inputSchema: z.object({
      decision_id: z
        .string()
        .optional()
        .describe('Decision ID to approve or reject after user confirmation'),
      action: z
        .enum(['list', 'approve', 'reject'])
        .optional()
        .describe('Use list to review pending approvals, or approve/reject a specific decision_id'),
      note: z.string().optional().describe('Optional approval note'),
      reason: z.string().optional().describe('Required rejection reason'),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of pending decisions to return when listing'),
      urgency_filter: z
        .enum(['all', 'critical', 'high'])
        .optional()
        .describe('Optional urgency filter for the pending decision list'),
      initiative_id: z
        .string()
        .optional()
        .describe('Optional initiative UUID to scope pending decisions'),
    }),
    securityScopes: ['decisions:read', 'decisions:write'],
    readOnly: false,
    profiles: ['memory'],
  },
  {
    id: 'delegate_agent_task',
    title: 'Delegate Agent Task',
    description:
      'Use when the user says "delegate this and tell me when it\'s done" — assign work to a specialist AI agent that owns the task and reports back with results. Also known as: hand this off, spawn agent, assign task, delegate to agent, have an AI agent do it.',
    inputSchema: z.object({
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
        .describe('Optional initiative title to resolve automatically if ID is unknown'),
      expected_artifacts: z.array(z.string()).optional().describe('Optional final outputs you expect'),
      deadline: z.string().optional().describe('Optional due date or plain-text deadline'),
      style_guidelines: z
        .string()
        .optional()
        .describe('Optional voice, format, or style constraints'),
    }),
    securityScopes: ['agents:write'],
    readOnly: false,
    profiles: ['commander', 'executor', 'full'],
  },
  {
    id: 'track_project_progress',
    title: 'Track Project Progress',
    description:
      'Use when the user asks how a project is going, what is blocked, or whether an initiative is on track. Returns health, blockers, milestones, owners, and recent activity. Also known as: project status, initiative pulse, blockers, roadmap progress, execution health.',
    inputSchema: z.object({
      initiative_id: z.string().optional().describe('Optional initiative UUID to check'),
      initiative_name: z
        .string()
        .optional()
        .describe('Optional initiative title to resolve automatically if ID is unknown'),
    }),
    securityScopes: ['initiatives:read'],
    readOnly: true,
    profiles: ['memory'],
  },
  {
    id: 'get_org_snapshot',
    title: 'Fetch organization snapshot',
    description:
      'Fetch a compact organization snapshot. Returns org-wide overview of initiatives, progress, and health.',
    inputSchema: z.object({
      view: z
        .enum(['summary', 'detailed'])
        .optional()
        .describe('Response view mode (default: summary).'),
      initiative_status: z
        .enum(['active', 'paused', 'all'])
        .optional()
        .describe('Filter initiatives by status.'),
      include: z
        .array(z.enum(['initiatives', 'milestones', 'tasks']))
        .optional()
        .describe('Detailed mode payload sections.'),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Max initiatives to return (default: 20, max: 100).'),
      cursor: z
        .string()
        .optional()
        .describe('Pagination cursor from a previous result.'),
    }),
    securityScopes: ['initiatives:read'],
    readOnly: true,
  },
  {
    id: INLINE_TOOL_CONTRACTS.review_artifact.id,
    title: INLINE_TOOL_CONTRACTS.review_artifact.title,
    description: INLINE_TOOL_CONTRACTS.review_artifact.description,
    inputSchema: z.object(INLINE_TOOL_CONTRACTS.review_artifact.inputSchema),
    securityScopes: extractScopes(
      INLINE_TOOL_CONTRACTS.review_artifact.securitySchemes
    ),
    readOnly:
      INLINE_TOOL_CONTRACTS.review_artifact.annotations.readOnlyHint,
  },
  {
    id: 'account_status',
    title: 'Get current account tier and usage',
    description:
      'Returns account tier, usage, and current edge rate-limit allowance.',
    inputSchema: z.object({
      user_id: z.string().optional().describe('Optional user ID override.'),
    }),
    securityScopes: [],
    readOnly: true,
  },
  {
    id: 'account_upgrade',
    title: 'Upgrade account tier',
    description:
      'Starts an account upgrade flow and returns checkout/contact URL.',
    inputSchema: z.object({
      target_plan: z
        .enum(['pro', 'enterprise'])
        .optional()
        .describe('Target plan to upgrade to.'),
      billing_cycle: z
        .enum(['monthly', 'annual'])
        .optional()
        .describe('Billing cycle preference.'),
      user_id: z.string().optional().describe('Optional user ID override.'),
    }),
    securityScopes: [],
    readOnly: false,
  },
  {
    id: 'account_usage_report',
    title: 'Get detailed account usage report',
    description:
      'Returns billing usage details with current edge rate-limit usage.',
    inputSchema: z.object({
      user_id: z.string().optional().describe('Optional user ID override.'),
    }),
    securityScopes: [],
    readOnly: true,
  },
  {
    id: 'list_entities',
    title: 'List entities',
    description: `List entities of any type with filters and pagination. Supported types: ${ENTITY_TYPES.join(
      ', '
    )}.`,
    inputSchema: z.object({
      type: entityTypeEnum.describe('Entity type to list'),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Max results (default: 20, max: 100).'),
      cursor: z.string().optional().describe('Pagination cursor.'),
      status: z.string().optional().describe('Filter by status.'),
      parent_id: z.string().optional().describe('Filter by parent entity ID.'),
      id: z
        .string()
        .optional()
        .describe(
          'Fetch a single entity by ID (with hydrated context when hydrate_context=true).'
        ),
      hydrate_context: z
        .boolean()
        .optional()
        .describe('Include relationships and rich context.'),
      include_relationships: z
        .boolean()
        .optional()
        .describe('Include related entities.'),
    }),
    securityScopes: ['initiatives:read'],
    readOnly: true,
  },
  {
    id: 'create_entity',
    title: 'Create entity',
    description:
      'Create a new entity of any type. For full initiative hierarchies, use scaffold_initiative instead.',
    inputSchema: z.object({
      type: entityTypeEnum.describe('Entity type to create'),
      title: z.string().describe('Entity title'),
      description: z.string().optional().describe('Entity description'),
      parent_id: z.string().optional().describe('Parent entity ID'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Additional metadata'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
  },
  {
    id: 'entity_action',
    title: 'Entity lifecycle action',
    description:
      'Perform lifecycle actions on any entity (launch, pause, complete, etc.). Use action=list_actions to discover available actions.',
    inputSchema: z.object({
      type: lifecycleTypeEnum.describe('Entity type'),
      id: z.string().describe('Entity ID'),
      action: z
        .string()
        .optional()
        .describe(
          'Action to perform (launch, pause, complete, etc.). Omit to list available actions.'
        ),
      force: z
        .boolean()
        .optional()
        .describe('Force the action even if preconditions are not met.'),
      note: z
        .string()
        .optional()
        .describe('Optional note attached to the action.'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
  },
  {
    id: 'update_entity',
    title: 'Update entity',
    description:
      'Update entity fields (title, description, metadata). For status changes, use entity_action.',
    inputSchema: z.object({
      type: entityTypeEnum.describe('Entity type'),
      id: z.string().describe('Entity ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe('Metadata fields to merge'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
  },
  {
    id: 'verify_entity_completion',
    title: 'Verify entity completion',
    description:
      'Run pre-completion verification to confirm all child work is done before completing an entity.',
    inputSchema: z.object({
      type: lifecycleTypeEnum.describe('Entity type'),
      id: z.string().describe('Entity ID'),
    }),
    securityScopes: ['initiatives:read'],
    readOnly: true,
  },
  {
    id: 'scaffold_initiative',
    title: 'Scaffold initiative',
    description:
      'Create a complete initiative with workstreams, milestones, and tasks in one call.',
    inputSchema: z.object({
      title: z.string().describe('Initiative title'),
      summary: z.string().optional().describe('Initiative summary'),
      workstreams: z
        .array(
          z.object({
            title: z.string(),
            tasks: z
              .array(
                z.object({
                  title: z.string(),
                  description: z.string().optional(),
                })
              )
              .optional(),
          })
        )
        .optional()
        .describe('Workstream definitions with nested tasks'),
      milestones: z
        .array(
          z.object({
            title: z.string(),
            due_date: z.string().optional(),
          })
        )
        .optional()
        .describe('Milestone definitions'),
      auto_launch: z
        .boolean()
        .optional()
        .describe('Auto-launch initiative after creation (default: true)'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
  },
  {
    id: 'batch_create_entities',
    title: 'Batch create entities',
    description:
      'Create multiple entities in one call with ref-based dependency resolution.',
    inputSchema: z.object({
      entities: z
        .array(
          z.object({
            ref: z
              .string()
              .optional()
              .describe('Reference key for dependency resolution'),
            type: entityTypeEnum,
            title: z.string(),
            description: z.string().optional(),
            parent_id: z.string().optional(),
            parent_ref: z
              .string()
              .optional()
              .describe('Reference to a parent in this batch'),
            metadata: z.record(z.unknown()).optional(),
          })
        )
        .describe('Array of entities to create'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
  },
  {
    id: 'batch_delete_entities',
    title: 'Batch delete entities',
    description:
      'Delete multiple entities in one call. Supports cascade and force options.',
    inputSchema: z.object({
      ids: z.array(z.string()).describe('Entity IDs to delete'),
      cascade: z.boolean().optional().describe('Also delete child entities'),
      force: z
        .boolean()
        .optional()
        .describe('Force delete even if entity has active children'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
  },
  {
    id: 'get_task_with_context',
    title: 'Get task with context',
    description:
      'Fetch a task with hydrated context attachments (entities, artifacts, plan sessions).',
    inputSchema: z.object({
      task_id: z.string().describe('Task ID'),
    }),
    securityScopes: ['initiatives:read'],
    readOnly: true,
  },
  {
    id: 'comment_on_entity',
    title: 'Comment on entity',
    description:
      'Leave a threaded comment on an entity for annotations, concerns, or progress notes.',
    inputSchema: z.object({
      entity_id: z.string().describe('Entity ID to comment on'),
      body: z.string().describe('Comment body (markdown supported)'),
      parent_comment_id: z
        .string()
        .optional()
        .describe('Reply to a specific comment'),
    }),
    securityScopes: ['initiatives:write'],
    readOnly: false,
  },
  {
    id: 'list_entity_comments',
    title: 'List entity comments',
    description: 'List comments for an entity. Returns threaded discussion.',
    inputSchema: z.object({
      entity_id: z.string().describe('Entity ID'),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Max comments to return'),
    }),
    securityScopes: ['initiatives:read'],
    readOnly: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isReadOnly(meta: unknown, annotations?: unknown): boolean {
  if (
    annotations &&
    typeof annotations === 'object' &&
    'readOnlyHint' in annotations
  ) {
    return (annotations as Record<string, unknown>).readOnlyHint === true;
  }
  if (meta && typeof meta === 'object' && 'openai/readOnlyHint' in meta) {
    return (meta as Record<string, unknown>)['openai/readOnlyHint'] === true;
  }
  return false;
}

function safeZodToJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    if (schema instanceof z.ZodType) {
      if (typeof z.toJSONSchema === 'function') {
        return z.toJSONSchema(schema) as Record<string, unknown>;
      }
      return zodToJsonSchema(schema) as Record<string, unknown>;
    }
    // For object-style schemas (e.g. { param: z.string() })
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      const wrapped = z.object(schema as Record<string, z.ZodType>);
      if (typeof z.toJSONSchema === 'function') {
        return z.toJSONSchema(wrapped) as Record<string, unknown>;
      }
      return zodToJsonSchema(wrapped) as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function profilesForTool(toolId: string): string[] {
  const profiles: string[] = [];
  for (const [name, profile] of Object.entries(TOOL_PROFILES)) {
    if (name === 'full') continue;
    if (profile.tools === null || profile.tools.includes(toolId)) {
      profiles.push(name);
    }
  }
  return profiles;
}

function processToolDef(
  def: {
    id: string;
    title: string;
    description: string;
    inputSchema: unknown;
    securitySchemes?: unknown;
    _meta?: unknown;
    annotations?: unknown;
  },
  source: CatalogTool['source']
): CatalogTool {
  const id = def.id;
  return {
    id,
    title: def.title,
    description: def.description,
    category: TOOL_CATEGORY_MAP[id] || 'Other',
    inputSchema: safeZodToJsonSchema(def.inputSchema),
    responseExample: TOOL_RESPONSE_EXAMPLES[id],
    securityScopes: extractScopes(def.securitySchemes),
    readOnly: isReadOnly(def._meta, def.annotations),
    source,
    profiles: profilesForTool(id),
  };
}

// ---------------------------------------------------------------------------
// Source hash computation
// ---------------------------------------------------------------------------

function computeSourceHash(): string {
  const rootDir = path.resolve(__dirname, '..');
  const files = [
    path.join(rootDir, 'src/toolDefinitions.ts'),
    path.join(rootDir, 'src/flywheelTools.ts'),
    path.join(rootDir, 'src/toolProfiles.ts'),
    path.join(rootDir, 'src/authorizationPolicy.ts'),
    path.join(rootDir, 'src/contractTools.ts'),
    path.join(rootDir, 'scripts/generate-tool-catalog.ts'),
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(readFileSync(file, 'utf-8'));
  }
  return hash.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Response examples — representative JSON shapes for each tool
// ---------------------------------------------------------------------------

const TOOL_RESPONSE_EXAMPLES: Record<string, Record<string, unknown>> = {
  // Decisions
  get_pending_decisions: {
    decisions: [
      {
        id: 'dec_abc123',
        type: 'approval',
        title: 'Campaign brief ready for Q1 launch',
        urgency: 'high',
        agent: 'marketing-agent',
        artifact_id: 'art_xyz789',
        created_at: '2026-02-26T10:00:00Z',
      },
    ],
    total: 4,
    cursor: null,
  },
  approve_decision: {
    decision_id: 'dec_abc123',
    status: 'approved',
    artifact_id: 'art_xyz789',
    resolved_at: '2026-02-26T10:05:00Z',
  },
  reject_decision: {
    decision_id: 'dec_abc123',
    status: 'rejected',
    resolved_at: '2026-02-26T10:05:00Z',
  },
  get_decision_history: {
    decisions: [
      {
        id: 'dec_abc123',
        type: 'approval',
        status: 'approved',
        resolved_by: 'user_123',
        resolved_at: '2026-02-26T10:05:00Z',
      },
    ],
    total: 42,
    cursor: 'cur_next',
  },

  // Agents
  get_agent_status: {
    agent_type: 'engineering-agent',
    status: 'idle',
    current_task_id: null,
    completed_tasks: 12,
    trust_level: 'act_with_approval',
  },
  spawn_agent_task: {
    task_id: 'tsk_new123',
    agent_type: 'engineering-agent',
    status: 'queued',
    estimated_start: '2026-02-26T10:10:00Z',
  },
  handoff_task: {
    task_id: 'tsk_abc123',
    from_agent: 'product-agent',
    to_agent: 'engineering-agent',
    status: 'handed_off',
  },
  recommend_next_action: {
    recommendation: {
      action: 'approve_decision',
      target_id: 'dec_abc123',
      reasoning: 'Campaign brief matches brand guidelines and has strong CTAs.',
      confidence: 0.92,
    },
  },

  // Memory
  query_org_memory: {
    results: [
      {
        type: 'artifact',
        id: 'art_xyz789',
        title: 'Q1 Campaign Brief',
        relevance: 0.95,
        snippet: 'Launch messaging for the Q1 product update...',
      },
    ],
    total: 3,
  },

  // Initiative Monitoring
  get_initiative_pulse: {
    initiative_id: 'init_abc123',
    health: 'on_track',
    progress: 0.65,
    active_workstreams: 3,
    blocked_tasks: 0,
    pending_decisions: 1,
    last_activity: '2026-02-26T09:30:00Z',
  },

  // Entity Management
  list_entities: {
    entities: [
      {
        id: 'init_abc123',
        type: 'initiative',
        title: 'Q1 Product Launch',
        status: 'active',
        created_at: '2026-01-15T00:00:00Z',
      },
    ],
    total: 3,
    cursor: null,
  },
  create_entity: {
    id: 'tsk_new456',
    type: 'task',
    title: 'Design hero section',
    status: 'pending',
    parent_id: 'ws_abc123',
    created_at: '2026-02-26T10:00:00Z',
  },
  entity_action: {
    id: 'init_abc123',
    type: 'initiative',
    action: 'launch',
    previous_status: 'pending',
    new_status: 'active',
    timestamp: '2026-02-26T10:00:00Z',
  },
  update_entity: {
    id: 'tsk_abc123',
    type: 'task',
    title: 'Updated title',
    updated_at: '2026-02-26T10:00:00Z',
  },
  verify_entity_completion: {
    id: 'init_abc123',
    can_complete: false,
    blockers: [
      {
        type: 'task',
        id: 'tsk_xyz',
        title: 'Pending review',
        status: 'in_progress',
      },
    ],
  },
  scaffold_initiative: {
    initiative: {
      id: 'init_new789',
      title: 'Q1 Product Launch',
      status: 'active',
    },
    workstreams: [{ id: 'ws_001', title: 'Frontend' }],
    milestones: [{ id: 'ms_001', title: 'Beta launch' }],
    tasks: [{ id: 'tsk_001', title: 'Build hero section' }],
    total_entities_created: 5,
  },
  batch_create_entities: {
    created: [
      { ref: 'task1', id: 'tsk_aaa', type: 'task' },
      { ref: 'task2', id: 'tsk_bbb', type: 'task' },
    ],
    total: 2,
  },
  batch_delete_entities: { deleted: ['tsk_aaa', 'tsk_bbb'], total: 2 },
  get_task_with_context: {
    task: {
      id: 'tsk_abc123',
      title: 'Build hero section',
      status: 'in_progress',
    },
    parent: { id: 'ws_001', type: 'workstream', title: 'Frontend' },
    initiative: { id: 'init_abc123', title: 'Q1 Product Launch' },
    artifacts: [],
    comments: [],
  },
  comment_on_entity: {
    comment_id: 'cmt_abc123',
    entity_id: 'tsk_abc123',
    body: 'Looking good so far!',
    created_at: '2026-02-26T10:00:00Z',
  },
  list_entity_comments: {
    comments: [
      {
        id: 'cmt_abc123',
        body: 'Looking good!',
        author: 'user_123',
        created_at: '2026-02-26T10:00:00Z',
      },
    ],
    total: 1,
  },

  // Organization
  get_org_snapshot: {
    workspace: 'My Startup',
    initiatives: { total: 3, active: 2, completed: 1 },
    pending_decisions: 4,
    active_agents: 2,
    recent_artifacts: 7,
  },

  // Planning
  start_plan_session: {
    session_id: 'ps_abc123',
    initiative_id: 'init_abc123',
    status: 'active',
    created_at: '2026-02-26T10:00:00Z',
  },
  get_active_sessions: {
    sessions: [
      {
        id: 'ps_abc123',
        initiative_id: 'init_abc123',
        status: 'active',
        created_at: '2026-02-26T10:00:00Z',
      },
    ],
  },
  improve_plan: {
    session_id: 'ps_abc123',
    suggestions: [
      {
        type: 'add_task',
        workstream: 'Frontend',
        title: 'Add responsive breakpoints',
        reasoning: 'Mobile traffic accounts for 60% of visits.',
      },
    ],
  },
  record_plan_edit: {
    session_id: 'ps_abc123',
    edit_id: 'ed_001',
    recorded_at: '2026-02-26T10:05:00Z',
  },
  complete_plan: {
    session_id: 'ps_abc123',
    status: 'completed',
    entities_created: 8,
    completed_at: '2026-02-26T10:10:00Z',
  },

  // Scoring & Queue
  score_next_up_queue: {
    queue: [
      {
        entity_id: 'tsk_abc123',
        score: 92,
        signals: { urgency: 30, impact: 25, recency: 20, dependency: 17 },
      },
    ],
    scored_at: '2026-02-26T10:00:00Z',
  },
  get_scoring_signals: {
    signals: [
      {
        name: 'urgency',
        weight: 0.3,
        description: 'Time sensitivity based on deadlines',
      },
      { name: 'impact', weight: 0.25, description: 'Business value' },
    ],
  },
  get_scoring_config: {
    config: {
      weights: {
        urgency: 0.3,
        impact: 0.25,
        recency: 0.2,
        dependency: 0.15,
        pinned: 0.1,
      },
      auto_refresh_interval_minutes: 15,
    },
  },
  set_scoring_config: {
    updated: true,
    config: { weights: { urgency: 0.3, impact: 0.25 } },
  },
  set_scoring_weights: {
    updated: true,
    weights: { urgency: 0.4, impact: 0.3 },
  },
  pin_queue_item: {
    entity_id: 'tsk_abc123',
    pinned: true,
    pinned_at: '2026-02-26T10:00:00Z',
  },
  unpin_queue_item: { entity_id: 'tsk_abc123', pinned: false },
  skip_workstream: {
    workstream_id: 'ws_abc123',
    skipped: true,
    reason: 'Blocked by external dependency',
  },

  // Client Integration
  orgx_emit_activity: { emitted: true, activity_id: 'act_abc123' },
  orgx_apply_changeset: {
    applied: true,
    changeset_id: 'cs_abc123',
    entities_affected: 3,
  },
  sync_client_state: {
    synced: true,
    last_sync: '2026-02-26T10:00:00Z',
    pending_changes: 0,
  },
  check_spawn_guard: {
    allowed: true,
    trust_level: 'act_with_approval',
    budget_remaining_usd: 4.5,
  },
  record_quality_score: {
    recorded: true,
    entity_id: 'tsk_abc123',
    score: 0.88,
  },
  classify_task_model: {
    task_id: 'tsk_abc123',
    recommended_model: 'claude-sonnet-4-6',
    reasoning: 'Standard complexity task with clear requirements.',
  },

  // Streams
  update_stream_progress: {
    stream_id: 'str_abc123',
    progress: 0.75,
    updated_at: '2026-02-26T10:00:00Z',
  },
  get_initiative_stream_state: {
    initiative_id: 'init_abc123',
    streams: [
      {
        id: 'str_abc123',
        workstream: 'Frontend',
        progress: 0.75,
        status: 'active',
      },
    ],
  },

  // Workspace
  workspace: {
    workspace_id: 'ws_abc123',
    name: 'My Startup',
    plan: 'team',
    created_at: '2025-10-01T00:00:00Z',
  },

  // Onboarding
  configure_org: {
    workspace_id: 'ws_abc123',
    steps: {
      linear_connected: true,
      github_connected: false,
      first_initiative: true,
      first_decision: false,
    },
    completion: 0.5,
  },

  // Stats
  stats: {
    period: '30d',
    decisions_resolved: 42,
    artifacts_shipped: 18,
    agents_spawned: 7,
    avg_decision_time_hours: 2.3,
  },

  // Billing
  account_status: {
    user_id: 'usr_abc123',
    plan: 'free',
    tier: 'free',
    rate_limit_status: { window: '1h', limit_per_hour: 100, remaining: 92 },
  },
  account_upgrade: {
    target_plan: 'pro',
    billing_cycle: 'monthly',
    checkout_url: 'https://checkout.stripe.com/c/pay/cs_abc123',
  },
  account_usage_report: {
    user_id: 'usr_abc123',
    plan: 'free',
    usage: { creditsUsed: 15, creditsIncluded: 100 },
    edge_rate_limit: { window: '1h', limit_per_hour: 100, remaining: 92 },
  },

  // Intelligence Flywheel
  get_outcome_attribution: {
    outcomes: [
      {
        entity_id: 'tsk_abc123',
        cost_usd: 0.12,
        value_attributed: 'high',
        receipt_id: 'rcp_abc123',
      },
    ],
    total_cost_usd: 3.45,
    period: '30d',
  },
  record_outcome: {
    outcome_id: 'out_abc123',
    entity_id: 'tsk_abc123',
    recorded_at: '2026-02-26T10:00:00Z',
  },
  get_my_trust_context: {
    agent_type: 'engineering-agent',
    trust_level: 'act_with_approval',
    capabilities: {
      read_code: 'autonomous',
      create_pr: 'act_with_approval',
      merge_pr: 'draft',
    },
    promotion_progress: 0.7,
  },
  start_autonomous_session: {
    session_id: 'auto_abc123',
    max_cost_usd: 5.0,
    max_receipts: 50,
    started_at: '2026-02-26T22:00:00Z',
  },
  get_morning_brief: {
    session_id: 'auto_abc123',
    summary: '7 tasks completed, 2 decisions pending review',
    tasks_completed: 7,
    decisions_created: 2,
    total_cost_usd: 2.15,
    artifacts: ['art_001', 'art_002'],
  },
  get_relevant_learnings: {
    learnings: [
      {
        id: 'lrn_abc123',
        pattern: 'Auth bugs often stem from token refresh race conditions',
        source_task: 'tsk_xyz',
        confidence: 0.85,
      },
    ],
  },
  submit_learning: {
    learning_id: 'lrn_new123',
    submitted_at: '2026-02-26T10:00:00Z',
    status: 'accepted',
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const tools: CatalogTool[] = [];
  const seen = new Set<string>();

  function addTool(tool: CatalogTool) {
    if (seen.has(tool.id)) {
      console.warn(
        `[generate-tool-catalog] Duplicate tool ID: ${tool.id} — skipping`
      );
      return;
    }
    seen.add(tool.id);
    tools.push(tool);
  }

  // Static array tools
  for (const def of CHATGPT_TOOL_DEFINITIONS as any[]) {
    addTool(processToolDef(def, 'chatgpt'));
  }
  for (const def of PLAN_SESSION_TOOLS as any[]) {
    addTool(processToolDef(def, 'plan_session'));
  }
  for (const def of CLIENT_INTEGRATION_TOOL_DEFINITIONS as any[]) {
    addTool(processToolDef(def, 'client_integration'));
  }
  for (const def of STREAM_TOOL_DEFINITIONS as any[]) {
    addTool(processToolDef(def, 'stream'));
  }
  for (const def of FLYWHEEL_TOOL_DEFINITIONS as any[]) {
    addTool(processToolDef(def, 'flywheel'));
  }
  for (const def of CONTRACT_TOOL_DEFINITIONS as any[]) {
    if (V2_ORGX_TOOL_ID_SET.has(def.id)) {
      addTool(processToolDef(def, 'contract'));
    }
  }

  // Inline-registered tools
  for (const meta of INLINE_TOOL_METADATA) {
    addTool({
      id: meta.id,
      title: meta.title,
      description: meta.description,
      category: TOOL_CATEGORY_MAP[meta.id] || 'Other',
      inputSchema: safeZodToJsonSchema(meta.inputSchema),
      responseExample: TOOL_RESPONSE_EXAMPLES[meta.id],
      securityScopes: meta.securityScopes,
      readOnly: meta.readOnly,
      source: 'inline',
      profiles: meta.profiles ?? profilesForTool(meta.id),
    });
  }

  // Validate: every tool from TOOL_PROFILES should be in the catalog
  const allProfileTools = new Set<string>();
  for (const [name, profile] of Object.entries(TOOL_PROFILES)) {
    if (name === 'full' || !profile.tools) continue;
    for (const toolId of profile.tools) {
      allProfileTools.add(toolId);
    }
  }

  const missingFromCatalog = [...allProfileTools].filter((id) => !seen.has(id));
  if (missingFromCatalog.length > 0) {
    console.warn(
      `[generate-tool-catalog] WARNING: ${missingFromCatalog.length} tools from TOOL_PROFILES missing in catalog:\n` +
        missingFromCatalog.map((id) => `  - ${id}`).join('\n')
    );
  }

  // Sort tools by category then ID
  tools.sort(
    (a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id)
  );

  const categories = [...new Set(tools.map((t) => t.category))].sort();

  const catalog: ToolCatalog = {
    generatedAt: new Date().toISOString(),
    sourceHash: computeSourceHash(),
    version: '1.0.0',
    totalTools: tools.length,
    categories,
    tools,
    deprecated: DEPRECATED_TOOLS,
  };

  const outPath = path.resolve(
    __dirname,
    '../docs/generated/tool-catalog.json'
  );
  const serialized = JSON.stringify(catalog, null, 2) + '\n';
  writeFileSync(outPath, serialized);

  const authorizationPolicyPath = path.resolve(
    __dirname,
    '../docs/generated/authorization-policy.json'
  );
  const serializedAuthorizationPolicy =
    JSON.stringify(AUTHORIZATION_POLICY, null, 2) + '\n';
  writeFileSync(authorizationPolicyPath, serializedAuthorizationPolicy);

  // Optional second output — used by catalog:sync:monorepo to refresh the
  // vendored copy the orgx web repo consumes (docs + cross-repo contract
  // tests read it). This replaced the old whole-tree sync of the worker
  // source into orgx/workers/orgx-mcp.
  const extraOut = process.env.TOOL_CATALOG_EXTRA_OUT;
  if (extraOut) {
    writeFileSync(path.resolve(extraOut), serialized);
    console.log(`[generate-tool-catalog] Also wrote: ${extraOut}`);
  }

  const authorizationPolicyExtraOut =
    process.env.AUTHORIZATION_POLICY_EXTRA_OUT;
  if (authorizationPolicyExtraOut) {
    writeFileSync(
      path.resolve(authorizationPolicyExtraOut),
      serializedAuthorizationPolicy
    );
    console.log(
      `[generate-tool-catalog] Also wrote authorization policy: ${authorizationPolicyExtraOut}`
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[generate-tool-catalog] OK — ${tools.length} tools, ${categories.length} categories`
  );
  console.log(`[generate-tool-catalog] Output: ${outPath}`);
  console.log(
    `[generate-tool-catalog] Authorization policy: ${authorizationPolicyPath}`
  );

  if (missingFromCatalog.length > 0) {
    process.exitCode = 1;
  }
}

main();
