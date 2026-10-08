import { z } from 'zod';
import { z as z4 } from 'zod/v4';

export type SourceOutputSchema = z.AnyZodObject;
export type PortableOutputSchema = ReturnType<typeof z4.object>;
export type OutputSchema = SourceOutputSchema | PortableOutputSchema;

/**
 * Any JSON value, described without a bare `{}`. Used as the `catchall` of an
 * open object, so extra fields are allowed but still typed: the advertised
 * schema says `additionalProperties: <a JSON value>` rather than `true`,
 * which several MCP clients warn on or reject.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ])
);

export const nullableString = z.string().nullable();
export const nullableNumber = z.number().nullable();
export const nullableBoolean = z.boolean().nullable();

// Worker-owned transport fields must be declared alongside API-owned data.
// Keep this shape aligned with StreamGrant in live/streamGrant.ts.
export const streamGrantSchema = z.object({
  feedType: z.string(),
  feedId: z.string(),
  streamUrl: z.string(),
  expiresAt: z.number(),
  refreshTool: z.string(),
  refreshArgs: z.record(z.string()),
  label: z.string(),
}).strict();

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
      created_from: z.string().optional(),
      created_to: z.string().optional(),
      cursor: z.string().optional(),
      offset: z.number().optional(),
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
      created_from: z.string().optional(),
      created_to: z.string().optional(),
      cursor: z.string().optional(),
      offset: z.number().optional(),
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

/** "Done means": the bar a person agrees to before work starts (src/expectations.ts). */
export const expectationCheckSchema = z
  .object({
    id: z.string().nullable(),
    scope: z.enum(['initiative', 'workstream', 'task']),
    scope_id: z.string().nullable(),
    scope_label: z.string().nullable(),
    statement: z.string(),
    verify: z.enum(['command', 'http', 'artifact', 'manual']),
    required: z.boolean(),
    source: z.enum(['rule', 'artifact_type', 'learned', 'suggested', 'drafted']),
    source_ref: z.string().nullable(),
    source_label: z.string().nullable(),
    owner_agent: z.string().nullable(),
    new_since_last: z.boolean(),
  })
  .strict();

export const expectationSetSchema = z
  .object({
    id: z.string().nullable(),
    status: z.enum(['drafted', 'agreed', 'sent_back', 'superseded']),
    version: z.string().nullable(),
    initiative_id: z.string().nullable(),
    decision_id: z.string().nullable(),
    agreed_at: z.string().nullable(),
    agreed_by: z.string().nullable(),
    checks: z.array(expectationCheckSchema),
    omitted_count: z.number(),
    origin: z.enum(['app', 'suggested']),
  })
  .strict();

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
    // Open, not closed. `details` is diagnostic context and the worker adds
    // keys the list above does not name — `review_url` and `authority_kind`
    // on a decision that needs a human, `corrected_payload` and `diagnostic`
    // on a failed client-integration call, `gaps` on a rejected execution
    // graph, the spawn budget preflight. As a closed object it advertised
    // `additionalProperties: false`, and the MCP SDK client validates
    // structuredContent even on error results, so those errors were rejected
    // with a schema mismatch and the caller never saw the message or the URL
    // it needed. The named keys stay typed; unnamed ones must be JSON values.
    .catchall(jsonValueSchema)
    .optional(),
});

export function makeErrorCompatibleSchema(
  schema: SourceOutputSchema
): SourceOutputSchema {
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
 * An honest contract for a payload the worker does not own.
 *
 * Most tools outside the reviewed ChatGPT surface return the OrgX API's
 * response body unmodified, and that body evolves independently of this
 * worker. A closed schema would reject a valid response the first time the
 * API added a field, and the SDK client enforces outputSchema on every call.
 *
 * So this states what is verified and no more: each named field is typed
 * exactly as its producer emits it, and any other field may be any JSON value.
 * Every named field is optional because error results share the object,
 * carrying only `error`. Pass the full z.object — the SDK closes the schema if
 * it is handed a raw shape, silently dropping the catchall.
 */
export function makeOpenErrorCompatibleSchema(
  shape: z.ZodRawShape
): SourceOutputSchema {
  return z
    .object(shape)
    .partial()
    .extend({
      ok: z.boolean().optional(),
      error: z.union([z.string(), toolErrorEnvelopeSchema]).optional(),
      tool_id: z.string().optional(),
      error_type: z.string().optional(),
    })
    .catchall(jsonValueSchema);
}

/**
 * Keep the complete per-property Zod validators while advertising a compact,
 * closed, named top-level projection. Scalar properties can retain their
 * model-facing JSON Schema type while bulky nested properties use the output
 * side of a pipe. Tool calls still traverse every full input validator first,
 * so malformed nested structuredContent remains a hard failure.
 */
export function makeCompactAdvertisedSchema(
  schema: SourceOutputSchema,
  typedScalarProperties: ReadonlySet<string> = new Set()
): SourceOutputSchema {
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

/**
 * Advertise a closed, named, JSON-only top-level schema without using bare
 * `{}` subschemas. The latter are legal but several MCP clients warn on or
 * reject unconstrained schema positions. The original Zod 3 schema remains
 * the runtime validator, so this portability projection does not weaken the
 * server-side contract or discard API-owned nested fields.
 */
export function makePortableJsonAdvertisedSchema(
  schema: SourceOutputSchema
): PortableOutputSchema {
  const jsonValue = z4.json();
  const projectedShape = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, jsonValue.optional()])
  ) as Record<string, ReturnType<typeof jsonValue.optional>>;

  return z4
    .object(projectedShape)
    .strict()
    .superRefine((value, context) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) return;

      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
      }
    });
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

/**
 * Acceptance-ledger proof the app adds to a pending-decision list on the
 * widget read channel (orgx_decide list_pending, approve_agent_work list,
 * get_pending_decisions). Failed reads and bounded counts are nullable.
 */
export const approvalListProofSchema = z
  .object({
    last_accepted: z
      .object({
        artifact_id: z.string(),
        title: z.string(),
        accepted_at: z.string(),
        accepted_by: z.enum(['you', 'workspace_member']),
        url: z.string(),
      })
      .strict()
      .nullable(),
    completed_unaccepted: z.number().nullable(),
  })
  .strict()
  .nullable();

/**
 * What a pending-decision count covers. Mirrors PendingDecisionScope in the
 * app (lib/server/decisions/pendingDecisionScope.ts): every count of
 * "decisions waiting on you" (get_pending_decisions, orgx_decide list_pending,
 * approve_agent_work list, the morning brief, the initiative pulse) carries
 * the scope it counted, so the same scope always gives the same number.
 * `total` is the whole scope, never the page; `kinds` gains `action` when the
 * widget channel adds Action Gateway items to the list.
 */
// Known values are described, not enumerated: an output schema must never fail
// a whole response because the app added a value.
export const pendingDecisionsScopeSchema = z.object({
  level: z.string().describe('Scope level. Known values: workspace, initiative.'),
  workspace_id: nullableString,
  initiative_id: nullableString,
  kinds: z.array(
    z.string().describe('Counted kind. Known values: decision, approval, action.')
  ),
  urgency: z.string().describe('Urgency filter. Known values: all, critical, high.'),
  includes_system: z.boolean(),
  unit: z.string().describe('What one unit of total is. Known value: review_packet.'),
  total: z.number(),
  capped: z.boolean(),
});

/**
 * A morning-brief source that failed to load (lib/server/briefSourceHealth.ts
 * in the app). The brief sets `degraded` only when one of these exists.
 */
export const briefSourceGapSchema = z.object({
  source: z.string(),
  label: z.string(),
  reason: z
    .string()
    .describe('Why it failed. Known values: query_failed, timeout, unavailable.'),
});

/**
 * A model's approve/reject request answered as a normal result: a person
 * must decide, here is where (src/directHumanDecisionAction.ts).
 */
export const humanDecisionReviewShape = {
  status: z.literal('needs_human').optional(),
  decision_id: z.string().optional(),
  requested_action: z.enum(['approve', 'reject']).optional(),
  review_url: z.string().optional(),
  authority_kind: z.literal('human_session').optional(),
};

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
  // The app reports a live task as `stalled` or `blocked` while its agent's
  // run is, and keeps the value workstream_tasks holds here
  // (lib/agents/tools/agentStatusTaskState.ts). Absent when not reconciled.
  stored_status: nullableString.optional(),
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
  artifact_preview_count: z.number().optional(),
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
