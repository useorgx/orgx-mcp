import { z } from 'zod';

import {
  agentSchema,
  agentTaskSchema,
  artifactSchema,
  artifactSummarySchema,
  budgetPreflightSchema,
  decisionSchema,
  nullableNumber,
  nullableString,
  proofHandoffSchema,
  resourceSchema,
  scaffoldContractWarningSchema,
  toolCallSchema,
} from './shared';
import {
  activationSchema,
  chronicleSchema,
  relatedContextSchema,
  reviewContractSchema,
  workspaceInfluenceSchema,
} from './presentation';

export const WIDGET_OUTPUT_SCHEMAS = {
  approve_decision: z
    .object({
      decision_id: z.string().optional(),
      decision_ids: z.array(z.string()).optional(),
      status: z.string().optional(),
      approved: z.boolean().optional(),
      decision: decisionSchema.optional(),
      option_id: z.string().optional(),
      note: z.string().optional(),
      run_resumed: z.boolean().optional(),
      message: z.string().optional(),
    })
    .strict(),

  reject_decision: z
    .object({
      decision_id: z.string().optional(),
      decision_ids: z.array(z.string()).optional(),
      status: z.string().optional(),
      rejected: z.boolean().optional(),
      decision: decisionSchema.optional(),
      option_id: z.string().optional(),
      reason: z.string().optional(),
      message: z.string().optional(),
    })
    .strict(),

  get_agent_status: z
    .object({
      agents: z.array(agentSchema),
      summary: z.object({
        total: z.number().optional(),
        running: z.number().optional(),
        queued: z.number().optional(),
        blocked: z.number().optional(),
        stalled: z.number().optional(),
        idle: z.number().optional(),
        unknown: z.number().optional(),
        done: z.number().optional(),
        completed: z.number().optional(),
        actionable_tasks: z.number().optional(),
        assigned_tasks: z.number().optional(),
        blocked_tasks: z.number().optional(),
        unassigned_tasks: z.number().optional(),
      }),
      undispatched_tasks: z
        .object({
          total: z.number(),
          assigned: z.number(),
          blocked: z.number(),
          unassigned: z.number(),
          unassigned_examples: z.array(agentTaskSchema),
        })
        .optional(),
      stalled_agents: z.array(
        z.object({
          agent_id: z.string(),
          agent_name: z.string(),
          run_id: nullableString,
          initiative_id: nullableString,
          stalled_minutes: nullableNumber,
          last_heartbeat_at: nullableString,
        })
      ),
      message: z.string(),
      next_steps: z.array(z.string()).optional(),
      live_url: z.string().optional(),
    })
    .strict(),

  get_initiative_pulse: z
    .object({
      initiative_id: z.string(),
      name: z.string(),
      status: z.string(),
      health_score: z.number(),
      progress_pct: z.number(),
      created_at: z.string(),
      milestones: z.array(resourceSchema),
      workstreams: z.array(resourceSchema),
      blockers: z.array(resourceSchema),
      pending_decisions: z.number(),
      continuity: z
        .object({
          state: z.string().optional(),
          headline: z.string().optional(),
          summary: z.string().optional(),
        })
        .optional(),
      workstream_summary: z.object({
        total: z.number(),
        active: z.number(),
        paused: z.number(),
        completed: z.number(),
        blocked: z.number(),
      }),
      completion_state: z.object({
        all_tasks_complete: z.boolean(),
        all_milestones_complete: z.boolean(),
        all_workstreams_complete: z.boolean(),
        has_pending_decisions: z.boolean(),
        initiative_complete: z.boolean(),
        stale_state_count: z.number(),
        stale_state: z.array(resourceSchema),
      }),
      lifecycle_stage: z.string(),
      initiative_short_id: z.string(),
      recent_artifacts: z.array(artifactSchema),
      artifact_summary: artifactSummarySchema.nullable(),
      resolved_from_name: z.boolean(),
      message: z.string(),
      next_steps: z.array(z.string()),
      live_url: z.string().optional(),
      proof_cards: z.array(artifactSchema).optional(),
      review_items: z.array(artifactSchema).optional(),
      proof_handoff: proofHandoffSchema.optional(),
      widget_state_contract: z
        .object({
          source: z.string(),
          tool_result_mode: z.string(),
          states: resourceSchema,
          visual: resourceSchema,
          constraints: resourceSchema,
        })
        .optional(),
      _relatedContext: relatedContextSchema.optional(),
      _workspaceInfluence: workspaceInfluenceSchema.optional(),
    })
    .strict(),

  scaffold_initiative: z
    .object({
      ok: z.boolean().optional(),
      error_kind: z.string().optional(),
      error: z.string().optional(),
      resolution_hint: z.string().optional(),
      request_id: z.string().optional(),
      identity_warning: z
        .object({ code: z.string(), message: z.string() })
        .optional(),
      billing_url: z.string().optional(),
      pricing_url: z.string().optional(),
      usage: z
        .object({
          scaffoldsUsed: z.number(),
          scaffoldsIncluded: z.number(),
          hasScaffolds: z.boolean(),
        })
        .optional(),
      missing: z.array(z.string()).optional(),
      suggested_next_calls: z.array(toolCallSchema).optional(),
      mode: z.enum(['draft', 'scaffold', 'launch']).optional(),
      response_mode: z.string().optional(),
      summary: z.string().optional(),
      initiative_id: z.string().optional(),
      live_url: z.string().optional(),
      idempotency_key: nullableString.optional(),
      contract_warnings: z.array(scaffoldContractWarningSchema).optional(),
      summary_stats: z
        .object({
          requested_count: z.number().optional(),
          created_count: z.number().optional(),
          failed_count: z.number().optional(),
          created_by_type: z.record(z.string(), z.number()).optional(),
          failed_by_type: z.record(z.string(), z.number()).optional(),
          planned_by_type: z.record(z.string(), z.number()).optional(),
          workstream_count: z.number().optional(),
          milestone_count: z.number().optional(),
          task_count: z.number().optional(),
          inline_task_count: z.number().optional(),
          omitted_task_count: z.number().optional(),
          dependency_edge_count: z.number().optional(),
        })
        .optional(),
      dependency_edges: z.array(resourceSchema).optional(),
      coordination_dependency: resourceSchema.optional(),
      entity_plan_preview: z.array(resourceSchema).optional(),
      entity_plan_count: z.number().optional(),
      entity_plan_preview_count: z.number().optional(),
      first_agent_work: resourceSchema.optional(),
      external_sync: resourceSchema.optional(),
      benchmark_metrics: resourceSchema.optional(),
      hierarchy: z
        .object({
          initiative: resourceSchema.optional(),
          workstreams: z.array(resourceSchema).optional(),
        })
        .optional(),
      created_preview: z.array(resourceSchema).optional(),
      created_preview_count: z.number().optional(),
      created_count: z.number().optional(),
      failed_preview: z.array(resourceSchema).optional(),
      failed_preview_count: z.number().optional(),
      failed_count: z.number().optional(),
      ref_map: z.record(z.string(), z.string()).optional(),
      ref_map_count: z.number().optional(),
      ref_map_truncated: z.boolean().optional(),
      scaffold_stream_url: z.string().optional(),
      scaffold_session_id: z.string().optional(),
      agent_assignment: resourceSchema.optional(),
      credential_status: resourceSchema.optional(),
      launch: resourceSchema.optional(),
      streams: resourceSchema.optional(),
      billing_usage: resourceSchema.optional(),
      scaffold_usage: resourceSchema.optional(),
      fallback_agent_dispatch: resourceSchema.optional(),
      result_contract: z
        .object({
          mode: z.string(),
          reason: z.string(),
          do_not_retry_for_full_payload: z.boolean(),
          stable_keys: z.array(z.string()),
          detail_policy: z.string(),
          preferred_next_calls: z.array(toolCallSchema),
          suggested_next_calls: z.array(toolCallSchema),
        })
        .optional(),
      tool_hints: z
        .object({
          do_not_rerun_scaffold_for_more_detail: z.boolean().optional(),
          use_ref_map_or_list_entities_for_ids: z.boolean().optional(),
          large_payloads_are_intentionally_compacted: z.boolean().optional(),
          draft_mode_has_no_side_effects: z.boolean().optional(),
          use_mode_scaffold_to_create_without_launch: z.boolean().optional(),
          use_mode_launch_to_create_and_start_agents: z.boolean().optional(),
        })
        .optional(),
      estimated_time_seconds: z.number().optional(),
      estimated_cost: z.number().optional(),
      client_activation: activationSchema.optional(),
    })
    .strict(),

  handoff_task: z
    .object({
      task_id: z.string(),
      task_short_id: z.string(),
      task_title: z.string(),
      task_summary: z.string(),
      agent_id: z.string(),
      agent_name: z.string(),
      spawned_run_id: z.string().optional(),
      run_id: z.string().optional(),
      run_short_id: z.string().optional(),
      live_url: z.string().optional(),
      message: z.string(),
      next_steps: z.array(z.string()),
      domain: z.string().optional(),
      workspace_id: z.string().optional(),
      command_center_id: z.string().optional(),
      workspace_name: z.string().optional(),
      initiative_id: z.string().optional(),
      initiative_name: z.string().optional(),
      budget_preflight: budgetPreflightSchema.optional(),
    })
    .strict(),

  approve_agent_work: z
    .object({
      decisions: z.array(decisionSchema),
      total_pending: z.number(),
      summary: z.object({
        critical: z.number(),
        high: z.number(),
        medium: z.number(),
        low: z.number(),
      }),
      message: z.string(),
    })
    .strict(),

  review_artifact: z
    .object({
      artifact: artifactSchema.nullable(),
      reviewContract: reviewContractSchema.nullable().optional(),
      reviewContractSource: z
        .enum(['canonical', 'entity_fallback'])
        .optional(),
    })
    .strict(),

  get_morning_brief: z
    .object({
      session_summary: z
        .object({
          session_id: nullableString.optional(),
          session_type: z.string().optional(),
          status: z.string().optional(),
          started_at: nullableString.optional(),
          ended_at: nullableString.optional(),
          receipts_produced: z.number().optional(),
          completed: z.number().optional(),
          failed: z.number().optional(),
          total_cost: z.number().optional(),
          total_value: z.number().optional(),
        })
        .optional(),
      session_id: z.string().optional(),
      receipts: z.array(resourceSchema).optional(),
      top_receipts: z.array(resourceSchema).optional(),
      exceptions: z.array(resourceSchema).optional(),
      trust_events: z.array(resourceSchema).optional(),
      intelligence: z
        .object({
          learnings_total: z.number(),
          learnings_applied: z.number(),
          trust_promotions: z.number(),
          attributed_value: z.number(),
          decisions_resolved_30d: z.number(),
          initiatives_completed_30d: z.number(),
        })
        .optional(),
      source_tool: z.string().optional(),
      chronicle: chronicleSchema.optional(),
      reportingNarrative: chronicleSchema.shape.reportingNarrative.optional(),
      goals: z.array(resourceSchema).optional(),
      dataGaps: z.array(z.string()).optional(),
      brief_markdown: z.string().optional(),
      degraded: z.boolean().optional(),
      degraded_reason: nullableString.optional(),
      value_dashboard: z.object({
        period: z.literal('30d'),
        value_delivered_usd: z.number(),
        cost_usd: z.number(),
        roi: nullableNumber,
        roi_display: z.string(),
        estimated_time_saved_hours: nullableNumber,
        context_preserved_events: z.number(),
        decisions_resolved: z.number(),
        initiatives_completed: z.number(),
        completed_this_week: z.number(),
        trust_promotions: z.number(),
        learnings_applied: z.number(),
      }),
      outcome_attribution: z
        .object({
          period: z.string().optional(),
          summary: resourceSchema.optional(),
          outcomes: z.array(resourceSchema).optional(),
        })
        .optional(),
      workspace_pulse: z
        .object({ stats: resourceSchema.nullable(), generatedAt: nullableString })
        .optional(),
      client_activation: activationSchema.optional(),
    })
    .strict(),

  get_operator_chronicle: z
    .object({
      chronicle: chronicleSchema,
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
    .strict(),

  check_execution_readiness: z
    .object({
      has_credentials: z.boolean(),
      ready: z.boolean().optional(),
      missing: z.array(z.string()).optional(),
      has_execution_credentials: z.boolean(),
      has_subscription_accounts: z.boolean(),
      providers: z.object({
        openai: z.object({
          configured: z.boolean(),
          available: z.boolean(),
          source: nullableString,
          key_hint: nullableString,
          updated_at: nullableString,
        }),
        anthropic: z.object({
          configured: z.boolean(),
          available: z.boolean(),
          source: nullableString,
          key_hint: nullableString,
          updated_at: nullableString,
        }),
        gemini: z.object({
          configured: z.boolean(),
          available: z.boolean(),
          source: nullableString,
          key_hint: nullableString,
          updated_at: nullableString,
        }),
        cursor: z.object({
          configured: z.boolean(),
          available: z.boolean(),
          source: nullableString,
          key_hint: nullableString,
          updated_at: nullableString,
        }),
      }),
      can_execute: z.boolean(),
      subscription_execution: z.object({
        has_subscription_accounts: z.boolean(),
        has_executable_subscription: z.boolean(),
        has_interactive_route: z.boolean(),
        has_cloud_route: z.boolean(),
        accounts: z.array(resourceSchema),
      }),
      capabilities: z.object({
        api_sdk: z.boolean(),
        e2b_container: z.boolean(),
        subscription_runner: z.boolean(),
        codex_cloud: z.boolean(),
        claude_max_runner: z.boolean(),
        image_generation: z.boolean(),
        cursor_background_agents: z.boolean(),
      }),
      setup_url: z.string(),
    })
    .strict(),
} as const;
