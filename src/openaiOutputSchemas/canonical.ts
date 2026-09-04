import { z } from 'zod';

import {
  artifactSchema,
  budgetPreflightSchema,
  capabilityGapSchema,
  contextPackSchema,
  decisionSchema,
  estimateSchema,
  lifecycleAffectedSchema,
  loopValidationSchema,
  normalizationWarningSchema,
  nullableString,
  paginationSchema,
  planSessionSchema,
  recommendationSchema,
  resourceSchema,
  toolCallSchema,
} from './shared';
import { chronicleSchema } from './presentation';

export const CANONICAL_OUTPUT_SCHEMAS = {
  orgx_bootstrap: z
    .object({
      server_version: z.string(),
      profile: z.string(),
      requested_profile: z.string().optional(),
      profile_fallback: z.boolean(),
      manifest: z.object({
        version: z.string(),
        public_profile: z.string(),
        public_tools_count: z.number(),
        negotiated_profile: z.string(),
        visible_tools_count: z.number(),
      }),
      safe_first_calls: z.array(toolCallSchema),
      recommended_workflows: z.object({
        plan_feature: z.array(z.string()),
        scaffold_hierarchy: z.array(z.string()),
        execute_task: z.array(z.string()),
      }),
      visible_tools_count: z.number(),
      visible_tools: z.array(z.string()),
      workspace: z
        .object({ id: z.string(), name: nullableString })
        .nullable(),
      initiative: z.object({ id: z.string() }).nullable(),
      granted_scopes: z.array(z.string()),
      accepted_id_forms: z.object({
        plan_session: z.array(z.string()),
        initiative: z.array(z.string()),
        task: z.array(z.string()),
      }),
      context_pack: contextPackSchema.nullable(),
      context_capsule: contextPackSchema.nullable(),
    })
    .strict(),

  orgx_search: z
    .object({
      _v2_tool: z.literal('orgx_search'),
      type: z.string(),
      search_mode: z.enum(['mixed_relevance', 'typed_collection']),
      query: nullableString,
      count: z.number(),
      results: z.array(resourceSchema),
      pagination: paginationSchema,
      next_call: toolCallSchema.nullable(),
    })
    .strict(),

  orgx_inspect: z
    .object({
      _v2_tool: z.literal('orgx_inspect').optional(),
      type: z.string().optional(),
      id: z.string().optional(),
      entity: resourceSchema.optional(),
      context_pack: contextPackSchema.nullable().optional(),
      session_id: z.string().optional(),
      uuid: z.string().optional(),
      uri: z.string().optional(),
      status: z.string().optional(),
      plan_content: z.string().optional(),
      current_plan: z.string().optional(),
      original_plan: z.string().optional(),
      improved_plan: z.string().optional(),
      domains_detected: z.array(z.string()).optional(),
      accepted_id_forms: z.array(z.string()).optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      plan_session: planSessionSchema.optional(),
      sessions: z.array(planSessionSchema).optional(),
      selected_session: planSessionSchema.optional(),
      message: z.string().optional(),
    })
    .strict(),

  orgx_recommend: z
    .object({
      _v2_tool: z.literal('orgx_recommend').optional(),
      mode: z.literal('morning_brief').optional(),
      source_tool: z.literal('get_operator_chronicle').optional(),
      ok: z.boolean().optional(),
      data: z
        .object({
          chronicle: chronicleSchema.optional(),
          headline: z.string().optional(),
          reportingNarrative: z
            .object({
              briefMarkdown: z.string().optional(),
              headline: z.string().optional(),
              whatChanged: z.array(z.string()).optional(),
              proof: z.array(z.string()).optional(),
              risks: z.array(z.string()).optional(),
              nextAction: nullableString.optional(),
            })
            .optional(),
        })
        .optional(),
      chronicle: chronicleSchema.optional(),
      entity_type: z.string().optional(),
      entity_id: nullableString.optional(),
      workspace_id: z.string().optional(),
      command_center_id: z.string().optional(),
      requested_agent_id: nullableString.optional(),
      canonical_only: z.boolean().optional(),
      canonical_projection: z.boolean().optional(),
      recommendations: z.array(recommendationSchema).optional(),
      next_action: recommendationSchema.nullable().optional(),
      active_streams: z.array(resourceSchema).optional(),
      capability_gap_detector: z
        .object({
          reason: nullableString.optional(),
          suggestions: z.array(capabilityGapSchema),
        })
        .optional(),
      capability_gaps: z.array(capabilityGapSchema).optional(),
      scoring_enabled: z.boolean().optional(),
      message: z.string().optional(),
    })
    .strict(),

  orgx_write: z
    .object({
      _v2_tool: z.literal('orgx_write'),
      operation: z.enum(['create', 'update']),
      ok: z.boolean().optional(),
      success: z.boolean().optional(),
      type: z.string().optional(),
      id: z.string().optional(),
      entity_id: z.string().optional(),
      data: resourceSchema.optional(),
      entity: resourceSchema.optional(),
      existing: resourceSchema.optional(),
      workspace: resourceSchema.optional(),
      active_workspace_id: nullableString.optional(),
      idempotent_replay: z.boolean().optional(),
      idempotency_key: nullableString.optional(),
      normalization_warnings: z.array(normalizationWarningSchema).optional(),
      replay_source: z.string().optional(),
      message: z.string().optional(),
      created: z.boolean().optional(),
      updated: z.boolean().optional(),
    })
    .strict(),

  orgx_attach: z
    .object({
      _v2_tool: z.literal('orgx_attach'),
      _action: z.literal('attach'),
      ok: z.boolean().optional(),
      success: z.boolean().optional(),
      data: resourceSchema.optional(),
      artifact: artifactSchema.optional(),
      id: z.string().optional(),
      artifact_id: z.string().optional(),
      entity_id: z.string().optional(),
      entity_type: z.string().optional(),
      status: z.string().optional(),
      message: z.string().optional(),
    })
    .strict(),

  orgx_act: z
    .object({
      _v2_tool: z.enum(['orgx_act', 'orgx_write', 'orgx_attach']).optional(),
      _action: z.string().optional(),
      operation: z.enum(['create', 'update']).optional(),
      ok: z.boolean().optional(),
      success: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      type: z.string().optional(),
      action: z.string().optional(),
      id: z.string().optional(),
      entity_id: z.string().optional(),
      entity_type: z.string().optional(),
      status: z.string().optional(),
      previous_status: z.string().optional(),
      new_status: z.string().optional(),
      data: resourceSchema.optional(),
      entity: resourceSchema.optional(),
      existing: resourceSchema.optional(),
      workspace: resourceSchema.optional(),
      artifact: artifactSchema.optional(),
      artifact_id: z.string().optional(),
      active_workspace_id: nullableString.optional(),
      idempotent_replay: z.boolean().optional(),
      idempotency_key: nullableString.optional(),
      normalization_warnings: z.array(normalizationWarningSchema).optional(),
      replay_source: z.string().optional(),
      deleted: z.boolean().optional(),
      updated: z.boolean().optional(),
      fields: resourceSchema.optional(),
      updated_fields: z.array(z.string()).optional(),
      spec: resourceSchema.optional(),
      quality_score: z.number().optional(),
      valid: z.boolean().optional(),
      errors: z.array(z.string()).optional(),
      transition: z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          previous_status: z.string().optional(),
          new_status: z.string().optional(),
        })
        .optional(),
      stream_dispatch: resourceSchema.optional(),
      initiative_activation: resourceSchema.optional(),
      initiative_conductor_event: resourceSchema.optional(),
      forced_completion: z.union([z.boolean(), resourceSchema]).optional(),
      proof_verification: resourceSchema.optional(),
      forced_proof_completion: z
        .union([z.boolean(), resourceSchema])
        .optional(),
      stream_reassignment: resourceSchema.optional(),
      proof_attached: z.boolean().optional(),
      attach_result: z
        .object({
          ok: z.boolean().optional(),
          success: z.boolean().optional(),
          data: resourceSchema.optional(),
          artifact: artifactSchema.optional(),
          id: z.string().optional(),
          message: z.string().optional(),
        })
        .nullable()
        .optional(),
      verification: z
        .object({
          ready: z.boolean().optional(),
          verified: z.boolean().optional(),
          blockers: z.array(z.string()).optional(),
          warnings: z.array(z.string()).optional(),
        })
        .nullable()
        .optional(),
      diagnostic: z
        .object({
          code: z.string().optional(),
          reason: z.string().optional(),
          safe_to_retry: z.boolean().optional(),
          corrected_payload: resourceSchema.optional(),
          valid_values: z.array(z.string()).optional(),
          suggested_next_calls: z.array(toolCallSchema).optional(),
          security_note: z.string().optional(),
        })
        .optional(),
      message: z.string().optional(),
    })
    .strict(),

  manage_lifecycle: z
    .object({
      ok: z.boolean(),
      action: z.enum(['pause', 'resume', 'retry', 'cancel']),
      level: z.enum(['initiative', 'workstream', 'milestone', 'task', 'run']),
      id: z.string(),
      affected: lifecycleAffectedSchema,
      message: z.string(),
      error: z.string().optional(),
      blockReasons: z.array(z.string()).optional(),
    })
    .strict(),

  orgx_plan: z
    .object({
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
      last_edit_at: nullableString.optional(),
      edits: z.array(resourceSchema).optional(),
      edit_type: z.string().optional(),
      edit_summary: z.string().optional(),
      section_path: nullableString.optional(),
      before_content: nullableString.optional(),
      after_content: z.string().optional(),
      user_reason: nullableString.optional(),
      pattern_key: nullableString.optional(),
      ai_suggestion: z.boolean().nullable().optional(),
      learning_extracted: z.boolean().nullable().optional(),
      suggestions: z.array(resourceSchema).optional(),
      skills_applied: z
        .array(
          z
            .object({
              id: z.string(),
              name: z.string(),
            })
            .strict()
        )
        .optional(),
      learned_from_past: z.number().optional(),
      analysis_summary: z.string().optional(),
      generation: resourceSchema.optional(),
      domains_detected: z.array(z.string()).nullable().optional(),
      accepted_id_forms: z.array(z.string()).optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      completed_at: nullableString.optional(),
      plan_session: planSessionSchema.optional(),
      sessions: z.array(planSessionSchema).optional(),
      selected_session: planSessionSchema.optional(),
      data: z
        .object({
          sessions: z.array(planSessionSchema).optional(),
          selected_session: planSessionSchema.optional(),
        })
        .strict()
        .optional(),
      completion: resourceSchema.optional(),
      skill_suggestions: z.array(resourceSchema).optional(),
      context_attachments: z
        .object({
          attached_count: z.number().optional(),
          skipped_count: z.number().optional(),
          errors: z
            .array(z.union([z.string(), resourceSchema]))
            .optional(),
        })
        .strict()
        .nullable()
        .optional(),
      message: z.string().optional(),
    })
    .strict(),

  orgx_spawn: z
    .object({
      _v2_tool: z.literal('orgx_spawn'),
      _action: z.enum(['guard', 'classify', 'estimate', 'spawn', 'handoff']),
      routed_tool: z.enum([
        'check_spawn_guard',
        'classify_task_model',
        'spawn_agent_task',
        'handoff_task',
      ]),
      ok: z.boolean().optional(),
      allowed: z.boolean().optional(),
      blockedReason: nullableString.optional(),
      complexity: z.string().optional(),
      tier: z.string().optional(),
      model_tier: z.string().optional(),
      model_id: z.string().optional(),
      model: z.string().optional(),
      provider: z.string().optional(),
      estimated_tokens: z.number().optional(),
      estimated_cost_usd: z.number().optional(),
      max_cost_usd: z.number().optional(),
      candidate_routes: z.array(resourceSchema).optional(),
      cost_frontier: z.array(resourceSchema).optional(),
      estimate_only: z.boolean().optional(),
      estimate: estimateSchema.optional(),
      budget_preflight: budgetPreflightSchema.optional(),
      task_id: z.string().optional(),
      task_short_id: z.string().optional(),
      task_title: z.string().optional(),
      task_summary: z.string().optional(),
      run_id: z.string().optional(),
      run_short_id: z.string().optional(),
      spawned_run_id: z.string().optional(),
      delegation_contract: z
        .literal('durable_delegation_v2')
        .optional(),
      job_id: z.string().optional(),
      dispatch_receipt: z
        .object({
          dispatch: z.enum([
            'inline_claimed',
            'cloud_claimed',
            'session_orchestrator',
          ]),
          jobStatus: z.literal('running'),
          acceptedAt: z.string().optional(),
          publishId: z.string().optional(),
        })
        .strict()
        .optional(),
      agent_id: z.string().optional(),
      agent_profile_id: z.string().optional(),
      agent_name: z.string().optional(),
      domain: z.string().optional(),
      status: z.string().optional(),
      execution_target: z.string().optional(),
      sdk_backend: z.string().optional(),
      requested_model_tier: z.string().optional(),
      resolved_model: z.string().optional(),
      route_reason: z.string().optional(),
      budget_mode: z.string().optional(),
      workspace_id: z.string().optional(),
      command_center_id: z.string().optional(),
      workspace_name: z.string().optional(),
      initiative_id: z.string().optional(),
      initiative_name: z.string().optional(),
      live_url: z.string().optional(),
      message: z.string().optional(),
      next_steps: z.array(z.string()).optional(),
    })
    .strict(),

  orgx_decide: z
    .object({
      id: z.string().optional(),
      entity_id: z.string().optional(),
      type: z.string().optional(),
      title: z.string().optional(),
      initiative_id: nullableString.optional(),
      data: resourceSchema.optional(),
      normalization_warnings: z.array(normalizationWarningSchema).optional(),
      decisions: z.array(decisionSchema).optional(),
      total_pending: z.number().optional(),
      summary: z
        .object({
          critical: z.number(),
          high: z.number(),
          medium: z.number(),
          low: z.number(),
        })
        .optional(),
      message: z.string().optional(),
    })
    .strict(),

  orgx_submit_receipt: z
    .object({
      _v2_tool: z.literal('orgx_submit_receipt'),
      path: z.enum(['v1', 'legacy']),
      ok: z.boolean().optional(),
      success: z.boolean().optional(),
      data: resourceSchema.optional(),
      receipt: resourceSchema.optional(),
      id: z.string().optional(),
      receipt_id: z.string().optional(),
      hash: z.string().optional(),
      previous_hash: nullableString.optional(),
      workspace_id: z.string().optional(),
      created_at: z.string().optional(),
      summary: z.string().optional(),
      verification_status: z.string().optional(),
      fallback_reason: z.string().optional(),
      message: z.string().optional(),
      loop_validation: loopValidationSchema,
      contract_warnings: z.array(z.string()).optional(),
    })
    .strict(),

} as const;
