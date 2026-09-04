import { z } from 'zod';


export type OutputSchema = z.AnyZodObject;

export const nullableString = z.string().nullable();
export const nullableNumber = z.number().nullable();
export const nullableBoolean = z.boolean().nullable();

/**
 * Only the outer result envelope is strict. Nested resource projections are
 * intentionally forward-compatible because their full shape is owned by the
 * OrgX API, while the MCP tool owns (and closes) the top-level contract.
 */
export const resourceSchema = z.object({
  id: z.string().optional(),
  uuid: z.string().optional(),
  short_id: z.string().optional(),
  uri: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  summary: nullableString.optional(),
  description: nullableString.optional(),
  status: z.string().optional(),
  ok: z.boolean().optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  reason: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  ref: z.string().optional(),
  index: z.number().optional(),
  depends_on: z.array(z.string()).optional(),
  updated: z.boolean().optional(),
  deleted: z.boolean().optional(),
  would_update: z.boolean().optional(),
  would_delete: z.boolean().optional(),
  ready: z.boolean().optional(),
  verified: z.boolean().optional(),
  safe_to_retry: z.boolean().optional(),
  priority: z.union([z.string(), z.number()]).nullable().optional(),
  progress: nullableNumber.optional(),
  progress_pct: nullableNumber.optional(),
  workspace_id: nullableString.optional(),
  command_center_id: nullableString.optional(),
  initiative_id: nullableString.optional(),
  workstream_id: nullableString.optional(),
  milestone_id: nullableString.optional(),
  task_id: nullableString.optional(),
  run_id: nullableString.optional(),
  artifact_id: nullableString.optional(),
  agent_id: nullableString.optional(),
  created_at: nullableString.optional(),
  updated_at: nullableString.optional(),
  completed_at: nullableString.optional(),
  due_date: nullableString.optional(),
  live_url: nullableString.optional(),
  url: nullableString.optional(),
  artifact_url: nullableString.optional(),
  external_url: nullableString.optional(),
  content: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  metadata: z
    .object({
      idempotency_key: z.string().optional(),
      source_client: z.string().optional(),
      created_by_type: z.string().optional(),
      created_by_id: z.string().optional(),
      assigned_agent_ids: z.array(z.string()).optional(),
      assigned_agent_names: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
});

export const toolCallSchema = z.object({
  tool: z.string(),
  args: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
      query: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().optional(),
      initiative_id: z.string().optional(),
      decision_id: z.string().optional(),
      requested_action: z.string().optional(),
      review_url: z.string().optional(),
      authority_kind: z.string().optional(),
      reason: z.string().optional(),
      workspace_id: z.string().optional(),
      hydrate_context: z.boolean().optional(),
    })
    .optional(),
  arguments: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
      query: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().optional(),
      initiative_id: z.string().optional(),
      workspace_id: z.string().optional(),
      hydrate_context: z.boolean().optional(),
    })
    .optional(),
  purpose: z.string().optional(),
});

export const normalizationWarningSchema = z.object({
  path: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
});

export const scaffoldContractWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const toolErrorEnvelopeSchema = z.object({
  code: z.string(),
  status: z.number().optional(),
  message: z.string(),
  details: z
    .object({
      field: z.string().optional(),
      fields: z.array(z.string()).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      entity_type: z.string().optional(),
      entity_id: z.string().optional(),
      workspace_id: z.string().optional(),
      initiative_id: z.string().optional(),
      pagination_mode: z.string().optional(),
      path: z.string().optional(),
      required_scopes: z.array(z.string()).optional(),
      required_scope_alternatives: z.array(z.array(z.string())).optional(),
      missing_scope_alternatives: z.array(z.array(z.string())).optional(),
      granted_scopes: z.array(z.string()).optional(),
      grant_source_known: z.boolean().optional(),
      retryable: z.boolean().optional(),
      deterministic_fallback_used: z.boolean().optional(),
      accepted_id_forms: z.array(z.string()).optional(),
      contract_warnings: z.array(scaffoldContractWarningSchema).optional(),
      suggested_next_calls: z.array(toolCallSchema).optional(),
    })
    .optional(),
});

export function makeErrorCompatibleSchema(
  schema: OutputSchema
): OutputSchema {
  return schema
    .partial()
    .extend({
      ok: z.boolean().optional(),
      error: z.union([z.string(), toolErrorEnvelopeSchema]).optional(),
      tool_id: z.string().optional(),
      error_type: z.string().optional(),
    })
    .strict();
}

/**
 * Keep the complete per-property Zod validators while advertising a compact,
 * closed, named top-level projection. Scalar properties can retain their
 * model-facing JSON Schema type while bulky nested properties use the output
 * side of a pipe. Tool calls still traverse every full input validator first,
 * so malformed nested structuredContent remains a hard failure.
 */
export function makeCompactAdvertisedSchema(
  schema: OutputSchema,
  typedScalarProperties: ReadonlySet<string> = new Set()
): OutputSchema {
  const projectedShape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, propertySchema]) => [
      key,
      typedScalarProperties.has(key)
        ? propertySchema
        : (propertySchema as z.ZodTypeAny).pipe(z.unknown()),
    ])
  ) as z.ZodRawShape;
  return z.object(projectedShape).strict();
}

export const paginationSchema = z.object({
  mode: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  next_offset: nullableNumber.optional(),
  cursor: nullableString.optional(),
  next_cursor: nullableString.optional(),
  previous_cursor: nullableString.optional(),
  has_more: z.boolean().optional(),
  total: nullableNumber.optional(),
  returned: z.number().optional(),
  exhaustive: z.boolean().optional(),
});

export const contextPackSchema = z.object({
  schema_version: z.string().optional(),
  anchor: z
    .object({ type: z.string().optional(), id: z.string().optional() })
    .optional(),
  entity: resourceSchema.optional(),
  initiative: resourceSchema.optional(),
  workstream: resourceSchema.optional(),
  milestone: resourceSchema.optional(),
  task: resourceSchema.optional(),
  goals: z.array(resourceSchema).optional(),
  decisions: z.array(resourceSchema).optional(),
  artifacts: z.array(resourceSchema).optional(),
  blockers: z.array(resourceSchema).optional(),
  related: z.array(resourceSchema).optional(),
  summary: z.string().optional(),
});

export const planSessionSchema = z.object({
  id: z.string().optional(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
  uri: z.string().optional(),
  title: z.string().optional(),
  owner_id: z.string().optional(),
  feature_name: nullableString.optional(),
  status: z.string().optional(),
  plan_content: z.string().optional(),
  current_plan: nullableString.optional(),
  original_plan: z.string().optional(),
  improved_plan: z.string().optional(),
  workspace_id: nullableString.optional(),
  plan_version: z.number().optional(),
  patterns_applied: z.array(z.string()).nullable().optional(),
  started_at: z.string().optional(),
  edit_type: z.string().optional(),
  edit_summary: z.string().optional(),
  domains_detected: z.array(z.string()).nullable().optional(),
  accepted_id_forms: z.array(z.string()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  completed_at: nullableString.optional(),
  last_edit_at: nullableString.optional(),
});

export const recommendationSchema = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  label: z.string().optional(),
  title: z.string().optional(),
  summary: nullableString.optional(),
  reason: nullableString.optional(),
  score: nullableNumber.optional(),
  action: z.string().optional(),
  tool: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: nullableString.optional(),
  task_id: nullableString.optional(),
  initiative_id: nullableString.optional(),
  runnerAgentId: nullableString.optional(),
  nextTaskId: nullableString.optional(),
});

export const capabilityGapSchema = z.object({
  key: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  reason: z.string().optional(),
  domain: z.string().optional(),
  capability: z.string().optional(),
  recommended_agent_id: nullableString.optional(),
});

export const artifactSchema = resourceSchema.extend({
  artifact_type: nullableString.optional(),
  eval_score: nullableNumber.optional(),
  quality_score: nullableNumber.optional(),
  preview_markdown: nullableString.optional(),
  created_by_type: nullableString.optional(),
  created_by_id: nullableString.optional(),
  created_by_name: nullableString.optional(),
  entity_id: nullableString.optional(),
  entity_type: nullableString.optional(),
  primary_url: nullableString.optional(),
  primary_label: nullableString.optional(),
  task_url: nullableString.optional(),
  needs_review: z.boolean().optional(),
});

export const proofHandoffSchema = z.object({
  source: z.literal('orgx-mcp-widget-proof-cards'),
  preserve_tool_results: z.literal(true),
  live_url: nullableString,
  proof_count: z.number(),
  visible_proof_count: z.number(),
  review_count: z.number(),
  visible_review_count: z.number(),
  primary_prompt: z.string(),
  surface_prompts: z.array(
    z.object({ surface: z.string(), prompt: z.string() })
  ),
  quiet_cta: z.string(),
});

export const artifactSummarySchema = z
  .object({
    total: z.number(),
    approved: z.number().optional(),
    in_review: z.number().optional(),
    needs_review: z.number().optional(),
    draft: z.number().optional(),
    changes_requested: z.number().optional(),
  });

export const decisionSchema = z.object({
  id: z.string(),
  short_id: z.string().optional(),
  packet_id: z.string().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  summary: nullableString.optional(),
  status: z.string().optional(),
  urgency: z.string().optional(),
  priority: nullableString.optional(),
  agent_id: nullableString.optional(),
  agent_name: z.string().optional(),
  created_at: z.string().optional(),
  occurredAt: z.string().optional(),
  sourceLabel: z.string().optional(),
  initiativeId: nullableString.optional(),
  sourceRunId: nullableString.optional(),
  context: z
    .object({
      run_id: z.string().optional(),
      initiative_id: z.string().optional(),
      policy_key: z.string().optional(),
    })
    .optional(),
  options: z.array(resourceSchema).optional(),
  review_packet: resourceSchema.optional(),
});

export const agentTaskSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  status: nullableString,
  priority: nullableString,
  initiative_id: nullableString,
  workstream_id: nullableString,
  milestone_id: nullableString,
  updated_at: nullableString,
  blocker: nullableString,
});

export const agentSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  current_task: nullableString,
  status: z.string(),
  progress: nullableNumber,
  blockers: z.array(z.string()),
  started_at: nullableString,
  last_heartbeat_at: nullableString.optional(),
  stalled_minutes: nullableNumber.optional(),
  run_id: nullableString,
  job_id: nullableString.optional(),
  initiative_id: nullableString,
  execution_target: z.string(),
  tasks: z.array(agentTaskSchema).optional(),
  current_tasks: z.array(agentTaskSchema).optional(),
  active_tasks: z.array(agentTaskSchema).optional(),
  pending_task_count: z.number().optional(),
  blocked_task_count: z.number().optional(),
  activity_state: z.string().optional(),
  observability_state: z.string().optional(),
  status_source: z.string().optional(),
  stale_reason: nullableString.optional(),
  reconciliation_required: z.boolean().optional(),
  task_id: nullableString.optional(),
  run_id_state: z.string().optional(),
  job_id_state: z.string().optional(),
  artifact_attribution_state: z.string().optional(),
  completed_tasks: z.array(agentTaskSchema).optional(),
  completed_count: z.number().optional(),
  latest_artifact: artifactSchema.nullable().optional(),
  artifacts: z.array(artifactSchema).optional(),
  proof_cards: z.array(artifactSchema).optional(),
  artifact_count: z.number().optional(),
  proof_handoff: proofHandoffSchema.optional(),
  workload: z
    .object({
      tasks_in_progress: z.number(),
      blocked_count: z.number(),
      stream_count: z.number(),
    })
    .optional(),
});

export const lifecycleAffectedSchema = z.object({
  nodes: z.number(),
  runsPaused: z.number(),
  runsCancelled: z.number(),
  redispatched: z.number(),
});

export const estimateSchema = z.object({
  recommended_tier: nullableString,
  recommended_model: nullableString,
  provider: nullableString,
  estimated_tokens: nullableNumber,
  estimated_cost_usd: nullableNumber,
  budget_check: z.object({
    max_cost_usd: nullableNumber,
    estimated_cost_usd: nullableNumber,
    within_cap: nullableBoolean,
  }),
  candidate_count: z.number(),
  candidate_routes: z.array(resourceSchema),
});

export const budgetPreflightSchema = z.object({
  estimate: estimateSchema,
  route_task: z.object({
    recommended_tier: z.string().optional(),
    recommended_model: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    estimated_tokens: z.number().optional(),
    estimated_cost_usd: z.number().optional(),
    max_cost_usd: z.number().optional(),
    workspace_id: z.string().optional(),
  }),
});

export const loopValidationSchema = z.object({
  rung: nullableString,
  applies: z.boolean(),
  promotable: z.boolean(),
  missing: z.array(z.string()),
  warnings: z.array(z.string()),
  next_required_action: nullableString,
});
