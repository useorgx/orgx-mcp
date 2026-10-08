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
  approvalListProofSchema,
  briefSourceGapSchema,
  humanDecisionReviewShape,
  pendingDecisionsScopeSchema,
  proofHandoffSchema,
  resourceSchema,
  scaffoldContractWarningSchema,
  streamGrantSchema,
  toolCallSchema,
} from './shared';
import {
  activationSchema,
  chronicleSchema,
  relatedContextSchema,
  reviewContractSchema,
  workspaceInfluenceSchema,
} from './presentation';

const decideActionSchema = z.enum(['approve', 'reject']);
const panelItemKindSchema = z.enum(['decision', 'approval', 'action']);
const panelReceiptRowSchema = z
  .object({
    id: z.string(),
    at: z.string().nullable(),
    actor: z.string().nullable(),
    summary: z.string(),
    outcome: z.string().nullable(),
    verification: z.string().nullable(),
    accepted: z.string().nullable(),
    work_type: z.string().nullable(),
    area: z.string().nullable(),
    entity_title: z.string().nullable(),
    criteria: z.object({ met: z.number(), unmet: z.number(), unknown: z.number() }).strict(),
    prs: z.array(z.string()),
    confidence: z.number().nullable(),
  })
  .strict();
const panelAskerKindSchema = z.enum(['agent', 'floor', 'unnamed', 'system']);
/** The app's per-item widget_actions contract, as the panel carries it (clipped). */
const panelWidgetActionsSchema = z
  .object({
    kind: panelItemKindSchema,
    actions: z.array(decideActionSchema),
    labels: z.object({ approve: z.string(), reject: z.string() }).strict(),
    reject_requires_reason: z.boolean(),
    answer: z
      .object({ required_for: z.array(decideActionSchema), max_length: z.number() })
      .strict()
      .nullable(),
    selection: z
      .object({
        mode: z.enum(['single', 'multiple']),
        options: z.array(
          z
            .object({
              id: z.string(),
              label: z.string(),
              description: z.string().nullable(),
              implied_action: decideActionSchema.nullable(),
              requires_reason: z.boolean(),
            })
            .strict()
        ),
        min: z.number(),
        max: z.number(),
        required_for: z.array(decideActionSchema),
      })
      .strict()
      .nullable(),
  })
  .strict();

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

  orgx_widget_decide: z
    .object({
      decision_id: z.string().optional(),
      kind: z.enum(['decision', 'approval', 'action']).optional(),
      action: z.enum(['approved', 'rejected']).optional(),
      status: z.string().optional(),
      route: z.string().optional(),
      surface: z.string().optional(),
      option_id: z.string().nullable().optional(),
      option_ids: z.array(z.string()).nullable().optional(),
      message: z.string().optional(),
    })
    .strict(),

  orgx_command_status: z
    .object({
      kind: z.enum(['decision', 'run', 'command']),
      id: z.string(),
      state: z.enum(['queued', 'held', 'running', 'succeeded', 'failed', 'cancelled', 'not_found']),
      outcome: z.string().nullable().optional(),
      waiting_on: z.enum(['person', 'agent']).nullable().optional(),
      started_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      next_poll_after_ms: z.number().nullable(),
      message: z.string().optional(),
    })
    .strict(),

  orgx_panel_snapshot: z
    .object({
      schema: z.literal('orgx.panel.v1'),
      generated_at: z.string(),
      state: z.enum(['ok', 'no_workspace', 'degraded']),
      workspace: z
        .object({ id: z.string(), name: z.string().nullable() })
        .strict()
        .nullable(),
      attention: z
        .object({
          pending: z.number(),
          oldest_at: z.string().nullable(),
          blocking: z.boolean(),
        })
        .strict(),
      queue: z.array(
        z
          .object({
            id: z.string(),
            version: z.string(),
            title: z.string(),
            urgency: z.enum(['low', 'medium', 'high', 'critical']),
            waiting_since: z.string().nullable(),
            initiative_title: z.string().nullable(),
            blocked: z.boolean(),
            decide_in_orgx_reason: z.string().nullable(),
            option_count: z.number(),
            kind: panelItemKindSchema,
            widget_actions: panelWidgetActionsSchema.nullable(),
            asker: z.string().nullable(),
            asker_kind: panelAskerKindSchema.optional(),
            session_label: z.string().nullable().optional(),
            detail: z.string().nullable().optional(),
            url: z.string(),
          })
          .strict()
      ),
      focus: z
        .object({
          type: z.literal('decision'),
          id: z.string(),
          kind: panelItemKindSchema,
          version: z.string(),
          question: z.string(),
          urgency: z.enum(['low', 'medium', 'high', 'critical']),
          waiting_since: z.string().nullable(),
          initiative_title: z.string().nullable(),
          recommendation: z
            .object({
              status: z.enum(['ready', 'unverified', 'unavailable']),
              action: z.string().nullable(),
            })
            .strict()
            .nullable(),
          evidence: z.array(
            z
              .object({ title: z.string(), source_url: z.string().nullable() })
              .strict()
          ),
          evidence_total: z.number(),
          consequence_if_approved: z.string().nullable(),
          consequence_if_rejected: z.string().nullable(),
          blocked: z.boolean(),
          decide_in_orgx_reason: z.string().nullable(),
          options: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
          multiselect: z.boolean(),
          widget_actions: panelWidgetActionsSchema.nullable(),
          asker: z.string().nullable(),
          asker_kind: panelAskerKindSchema.optional(),
          session_label: z.string().nullable().optional(),
          why: z
            .object({
              authority: z.string().nullable(),
              policy: z.string().nullable(),
              uncertainty: z.array(z.string()),
              run_url: z.string().nullable(),
              initiative_url: z.string().nullable(),
            })
            .strict()
            .optional(),
          url: z.string(),
        })
        .strict()
        .nullable(),
      selection: z
        .object({
          requested_id: z.string().nullable(),
          status: z.enum(['default', 'selected', 'unavailable']),
        })
        .strict(),
      proof: z
        .object({
          last_accepted: z
            .object({
              artifact_id: z.string(),
              title: z.string(),
              accepted_at: z.string().nullable(),
              accepted_by: z.enum(['you', 'workspace_member']),
              url: z.string(),
            })
            .strict()
            .nullable(),
          completed_unaccepted: z.number(),
        })
        .strict(),
      degraded: z.array(z.string()),
      work: z
        .object({
          status: z.enum(['ok', 'unavailable']),
          items: z.array(
            z
              .object({
                id: z.string(),
                agent: z.string(),
                title: z.string(),
                state: z.enum(['blocked', 'running', 'queued']),
                url: z.string(),
                domain: z.string().nullable().optional(),
                updated_at: z.string().nullable().optional(),
                stale: z.boolean().optional(),
              })
              .strict()
          ),
          total: z.number(),
        })
        .strict()
        .optional(),
      workspaces: z
        .object({
          status: z.enum(['ok', 'unavailable']),
          items: z.array(
            z.object({ id: z.string(), name: z.string(), current: z.boolean() }).strict()
          ),
        })
        .strict()
        .optional(),
      history: z
        .object({
          status: z.enum(['ok', 'unavailable']),
          range: z.enum(['today', '7d', '30d']),
          items: z.array(
            z
              .object({
                id: z.string(),
                title: z.string(),
                outcome: z.enum(['approved', 'declined', 'cancelled', 'superseded']),
                settled_at: z.string().nullable(),
                url: z.string(),
              })
              .strict()
          ),
          reason: z.string().nullable().optional(),
        })
        .strict()
        .optional(),
      // Work Ledger receipts (src/panelReceipts.ts).
      receipts: z
        .object({
          status: z.enum(['ok', 'unavailable']),
          query: z.string(),
          total: z.number(),
          items: z.array(panelReceiptRowSchema),
          reason: z.string().nullable(),
        })
        .strict()
        .optional(),
      receipt: z
        .object({
          status: z.enum(['ok', 'unavailable']),
          id: z.string(),
          row: panelReceiptRowSchema.nullable(),
          objective: z.string().nullable(),
          outcome_summary: z.string().nullable(),
          criteria: z.array(
            z
              .object({
                id: z.string(),
                text: z.string(),
                kind: z.string().nullable(),
                status: z.enum(['met', 'unmet', 'unknown']),
                confidence: z.number().nullable(),
              })
              .strict()
          ),
          artifacts: z.array(z.object({ kind: z.string(), name: z.string(), url: z.string().nullable() }).strict()),
          uncertain: z.array(z.string()),
          workstream_title: z.string().nullable(),
          cost_usd: z.number().nullable(),
          completed_at: z.string().nullable(),
          reason: z.string().nullable(),
        })
        .strict()
        .optional(),
      // The panel's own live feed (see src/live/panelFeed.ts).
      live: streamGrantSchema.optional(),
    })
    .strict(),

  orgx_widget_receipt_call: z
    .object({
      recorded: z.boolean(),
      receipt_id: z.string(),
      status: z.enum(['succeeded', 'partially_succeeded', 'failed', 'blocked']).nullable(),
      reason: z.string().nullable(),
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
      // The initiative API and pulse widget support both blocker text and
      // linked resource details. Preserve either representation on the wire.
      blockers: z.array(z.union([z.string().min(1), resourceSchema])),
      pending_decisions: z.number(),
      // What pending_decisions counted. Null (or absent) from older app
      // versions. When the canonical count fails, newer apps send a labelled
      // fallback scope with unit: 'decision_record' (raw decision rows, which
      // may include duplicates and system items); only unit: 'review_packet'
      // is an exact count, so widgets say a fallback total approximately.
      pending_decisions_scope: pendingDecisionsScopeSchema.nullable().optional(),
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

  // action=list returns the pending list; action=approve|reject returns
  // status "needs_human" with the review URL (a person decides, never MCP),
  // so the list fields are optional.
  approve_agent_work: z
    .object({
      decisions: z.array(decisionSchema).optional(),
      // The whole scope's count, not the page's length.
      total_pending: z.number().optional(),
      pending_decisions_scope: pendingDecisionsScopeSchema.optional(),
      summary: z
        .object({
          critical: z.number(),
          high: z.number(),
          medium: z.number(),
          low: z.number(),
        })
        .optional(),
      message: z.string(),
      // The app adds acceptance-ledger proof on the widget read channel.
      proof: approvalListProofSchema.optional(),
      ...humanDecisionReviewShape,
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
      generated_at: z.string().optional(),
      data_gaps: z.array(z.string()).optional(),
      workspace_id: z.string().optional(),
      artifacts_produced: z.array(artifactSchema).optional(),
      review_items: z.array(artifactSchema).optional(),
      top_priorities: z.array(resourceSchema).optional(),
      metrics: chronicleSchema.shape.metrics.optional(),
      topPriorities: chronicleSchema.shape.topPriorities.optional(),
      rollups: chronicleSchema.shape.rollups.optional(),
      decisionChronology: chronicleSchema.shape.decisionChronology.optional(),
      artifactLedger: chronicleSchema.shape.artifactLedger.optional(),
      continuity: chronicleSchema.shape.continuity.optional(),
      prVelocity: chronicleSchema.shape.prVelocity.optional(),
      initiatives: chronicleSchema.shape.initiatives.optional(),
      message: z.string().optional(),
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
          roi: nullableNumber.optional(),
        })
        .nullable()
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
      brief_markdown: nullableString.optional(),
      // The canonical workspace count (same as get_pending_decisions'
      // total_pending for this scope); null when that count failed to load.
      pending_decisions: nullableNumber.optional(),
      pending_decisions_scope: pendingDecisionsScopeSchema.nullable().optional(),
      // Set only when a named source failed; each one is listed here.
      degraded: z.union([z.boolean(), z.array(z.string())]).optional(),
      degraded_reason: nullableString.optional(),
      degraded_sources: z.array(briefSourceGapSchema).optional(),
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
        accounts: z.array(resourceSchema.extend({ reason: nullableString.optional() })),
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

  // POST /api/agent-runs/:id/resume (app/api/agent-runs/[id]/resume/route.ts):
  // the already-running no-op, the continue-required park, and the resume.
  resume_agent_run: z
    .object({
      ok: z.boolean().optional(),
      noop: z.boolean().optional(),
      run_id: z.string().optional(),
      status: z.string().optional(),
      prior_status: z.string().optional(),
      was_auto_closed: z.boolean().optional(),
      continue_action: z.enum(['accept', 'continue']).optional(),
      completed_at: z.string().nullable().optional(),
      updated_at: z.string().optional(),
      message: z.string().optional(),
    })
    .strict(),
} as const;
