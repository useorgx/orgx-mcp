/**
 * Intelligence Flywheel MCP Tool Definitions
 *
 * 7 new tools + 4 enhanced tool extensions for the Intelligence Flywheel.
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
        'ROI summary from the economic ledger. Human: "3.2x ROI this month." Agent: "My outreach_draft receipts average $0.26 attributed value." Returns cost/value/ROI breakdowns by agent, capability, and time period.'
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
    id: 'record_outcome',
    title: 'Record Outcome',
    description:
      'Record a business outcome (deal closed, meeting booked, cycle time reduced). Agents can self-report outcomes they detect. Triggers attribution inference to connect outcomes to receipts.',
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID'),
      outcome_type_key: z.string().describe('Outcome type key: deal_closed, meeting_booked, etc.'),
      outcome_value: z.number().optional().describe('Value in the outcome type unit (e.g., USD amount)'),
      source: z
        .enum(['manual', 'agent_self_report', 'crm_webhook', 'linear_sync'])
        .default('manual')
        .describe('Source that observed or reported the outcome'),
      source_id: z.string().optional().describe('External source ID for deduplication'),
      occurred_at: z.string().optional().describe('ISO datetime when the outcome occurred'),
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
      'Agent-facing: "What\'s my trust level per capability? What do I need for promotion? Which receipts are helping/hurting?" Returns the full trust context for an agent including levels, scores, thresholds, and recent trust events.',
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

  // --- Initiative 3: Autonomy Sessions ---
  {
    id: 'start_autonomous_session',
    title: 'Start Autonomous Session',
    description:
      'Start an autonomous execution session with budget guardrails. Human: "Run overnight with $5 budget." Creates a session that produces receipts while executing eligible work items.',
    inputSchema: z.object({
      workspace_id: z.string().describe('Workspace ID'),
      session_type: z
        .enum(['overnight', 'weekend', 'scheduled', 'manual'])
        .default('manual')
        .describe('Autonomy session mode to start'),
      max_cost_usd: z
        .number()
        .positive()
        .default(5.0)
        .describe('Maximum budget in USD (hard stop — zero tolerance)'),
      max_receipts: z
        .number()
        .int()
        .positive()
        .default(50)
        .describe('Maximum number of receipts to produce'),
      allowed_trust_levels: z
        .array(z.enum(['autonomous', 'act_with_approval', 'draft', 'read_only']))
        .default(['autonomous', 'act_with_approval'])
        .describe('Only execute capabilities at these trust levels'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    securitySchemes: [
      { type: 'oauth2' as const, scopes: ['agents:write'] },
    ],
  },
  {
    id: 'get_morning_brief',
    title: 'Get Morning Brief',
    description:
      `Returns the morning brief: curated receipts, exceptions, ROI delta, and value signals from the most recent autonomous session. Defaults to the most recent session if no session ID is provided. ${preferredToolCallout(
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
      'Agent-facing: "What has the org learned about my capability?" Returns ranked org learnings relevant to a specific capability or task context.',
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
      'Agent-facing: Submit a discovery or insight as an org learning. Enters org_learnings after confidence validation. One agent\'s discovery benefits all agents.',
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
