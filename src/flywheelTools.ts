/**
 * Intelligence Flywheel MCP Tool Definitions
 *
 * 9 new tools + 4 enhanced tool extensions for the Intelligence Flywheel.
 * These tools serve two audiences: humans (ROI proof, trust visibility)
 * and agents (self-serve trust context, baselines, learnings).
 *
 * @see Intelligence Flywheel Architecture — MCP Tools inventory
 */

import { z } from 'zod';
import {
  compatibilityAliasDescription,
  preferredToolCallout,
} from './preferredToolGuidance';
import { autonomousSessionInputShape } from './autonomousSessionBudget';

// =============================================================================
// NEW TOOLS
// =============================================================================

export const FLYWHEEL_TOOL_DEFINITIONS = [
  // --- Initiative 1: Value Ledger + Receipts ---
  {
    id: 'get_outcome_attribution',
    title: 'Get Outcome Attribution',
    description:
      compatibilityAliasDescription(
        'outcomeAttribution',
        'Use when the user asks what agent work is actually worth — ROI summary from the economic ledger. Human: "3.2x ROI this month." Agent: "My outreach_draft receipts average $0.26 attributed value." Returns cost/value/ROI breakdowns by agent, capability, and time period.'
      ),
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID'),
      period: z
        .enum(['7d', '30d', '90d'])
        .default('30d')
        .describe('Time period for ROI calculation'),
      agent_type: z.string().optional().describe('Filter by specific agent type'),
      capability_key: z.string().optional().describe('Filter by capability key'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['initiatives:read'] },
    ],
    _meta: { 'openai/readOnlyHint': true },
  },
  {
    id: 'configure_outcome_type',
    title: 'Configure Outcome Type',
    description:
      'Use when record_outcome returns an unknown outcome type recovery hint, or a custom result must become measurable. Creates or approves a workspace outcome type before recording custom baseline, audit, or quality-gate outcomes.',
    inputSchema: z.object({
      workspace_id: z.string().optional().describe('Workspace ID'),
      workspaceId: z.string().optional().describe('CamelCase alias for workspace_id'),
      key: z
        .string()
        .describe('Outcome type key, normalized server-side to snake_case'),
      display_name: z
        .string()
        .optional()
        .describe('Human-facing outcome type label'),
      displayName: z
        .string()
        .optional()
        .describe('CamelCase alias for display_name'),
      unit: z
        .enum(['usd', 'hours', 'count', 'percent'])
        .default('count')
        .describe('Measurement unit for this outcome type'),
      value_semantics: z
        .enum(['revenue', 'time_saved', 'risk_reduced', 'quality_improved'])
        .default('quality_improved')
        .describe('How the value should be interpreted by ROI/proof loops'),
      valueSemantics: z
        .enum(['revenue', 'time_saved', 'risk_reduced', 'quality_improved'])
        .optional()
        .describe('CamelCase alias for value_semantics'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['initiatives:write'] },
    ],
  },
  {
    id: 'record_outcome',
    title: 'Record Outcome',
    description:
      'Use when a business outcome lands — deal closed, meeting booked, cycle time reduced — and it must be credited to the work that produced it. Agents can self-report outcomes they detect. Triggers attribution inference to connect outcomes to receipts. If the outcome type is unknown, call configure_outcome_type first.',
    inputSchema: z.object({
      workspace_id: z.string().optional().describe('Workspace ID'),
      workspaceId: z.string().optional().describe('CamelCase alias for workspace_id'),
      outcome_type_key: z.string().optional().describe('Outcome type key: deal_closed, meeting_booked, etc.'),
      outcomeTypeKey: z.string().optional().describe('CamelCase alias for outcome_type_key'),
      outcome_value: z.number().optional().describe('Value in the outcome type unit (e.g., USD amount)'),
      outcomeValue: z.number().optional().describe('CamelCase alias for outcome_value'),
      source: z
        .enum(['manual', 'agent_self_report', 'crm_webhook', 'linear_sync'])
        .default('manual')
        .describe('Source that observed or reported the outcome'),
      source_id: z.string().optional().describe('External source ID for deduplication'),
      sourceId: z.string().optional().describe('CamelCase alias for source_id'),
      occurred_at: z.string().optional().describe('ISO datetime when the outcome occurred'),
      occurredAt: z.string().optional().describe('CamelCase alias for occurred_at'),
      metadata: z.record(z.unknown()).optional().describe('Additional context'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['initiatives:write'] },
    ],
  },

  // --- Initiative 2: Capabilities + Trust ---
  {
    id: 'get_my_trust_context',
    title: 'Get My Trust Context',
    description:
      'Use when an agent asks "what am I trusted to do, what do I need for promotion, and which receipts are helping or hurting?" Returns the full trust context for an agent including per-capability levels, scores, thresholds, and recent trust events.',
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID'),
      agent_type: z.string().describe('Agent type to query trust for'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['agents:read'] },
    ],
    _meta: { 'openai/readOnlyHint': true },
  },
  {
    id: 'orgx_free_audit',
    title: 'OrgX Free Audit',
    description:
      'Use when a workspace wants to know how ready it is for autonomous agent work before spending anything. Runs a free autonomy benchmark from trust, proof, ROI, and workspace signals. Returns Proof Score, Context Debt, Autonomy Maturity, ROI Visibility, and next recommendations without starting an autonomous session or consuming agent credits.',
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID to audit'),
      agent_type: z
        .string()
        .default('orchestrator')
        .describe('Agent type to benchmark trust against'),
      period: z
        .enum(['7d', '30d', '90d'])
        .default('30d')
        .describe('ROI attribution period used for ROI Visibility'),
      include_raw_signals: z
        .boolean()
        .default(false)
        .describe('Include raw upstream signal payloads for debugging and verification'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['agents:read', 'initiatives:read'] },
    ],
    _meta: { 'openai/readOnlyHint': true },
  },

  // --- Initiative 3: Autonomy Sessions ---
  {
    id: 'start_autonomous_session',
    title: 'Start Autonomous Session',
    description:
      'Use when the user says "run overnight with $5 budget" or wants eligible work executed unattended within guardrails. Starts an autonomous execution session that produces receipts while executing eligible work items.',
    inputSchema: z.object(autonomousSessionInputShape),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['agents:write'] },
    ],
  },
  {
    id: 'get_morning_brief',
    title: 'Get Morning Brief',
    description:
      `Use when the user asks 'what happened,' 'catch me up,' or starts a session after time away. Returns the morning brief: curated receipts, exceptions, ROI delta, and value signals from the most recent autonomous session. Defaults to the most recent session if no session ID is provided. ${preferredToolCallout(
        'outcomeAttribution'
      )}`,
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID'),
      session_id: z.string().optional().describe('Specific session ID (defaults to most recent)'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['initiatives:read'] },
    ],
    _meta: { 'openai/readOnlyHint': true },
  },

  // --- Initiative 4: Calibration ---
  {
    id: 'get_relevant_learnings',
    title: 'Get Relevant Learnings',
    description:
      'Use when an agent is about to attempt work the org may already have learned something about. Answers "what has the org learned about my capability?" Returns ranked org learnings relevant to a specific capability or task context.',
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID'),
      capability_key: z.string().optional().describe('Capability key to filter learnings'),
      keywords: z.array(z.string()).optional().describe('Keywords for semantic matching'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Maximum number of learnings to return'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['memory:read'] },
    ],
    _meta: { 'openai/readOnlyHint': true },
  },
  {
    id: 'submit_learning',
    title: 'Submit Learning',
    description:
      'Use when an agent discovers a pattern worth teaching the whole org — a failure mode, success pattern, cost optimization, or quality heuristic. Submits it as an org learning; enters org_learnings after confidence validation. One agent\'s discovery benefits all agents.',
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID'),
      learning_type: z
        .enum(['failure_pattern', 'success_pattern', 'cost_optimization', 'quality_heuristic'])
        .describe('Type of learning'),
      summary: z.string().describe('Human-readable learning summary'),
      capability_key: z.string().optional().describe('Applicable capability key'),
      evidence_receipt_ids: z
        .array(z.string())
        .optional()
        .describe('Receipt IDs that support this learning'),
      keywords: z.array(z.string()).optional().describe('Semantic keywords for matching'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['memory:read'] },
    ],
  },
] as const;

export type FlywheelToolId = (typeof FLYWHEEL_TOOL_DEFINITIONS)[number]['id'];
