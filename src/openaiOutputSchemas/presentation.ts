import { z } from 'zod';

import {
  artifactSchema,
  decisionSchema,
  nullableNumber,
  nullableString,
  resourceSchema,
} from './shared';

export const chronicleSchema = z.object({
  workspaceId: nullableString,
  workspaceName: z.string(),
  generatedAt: z.string(),
  period: z.enum(['day', 'week', '30d']),
  windowStart: z.string(),
  windowEnd: z.string(),
  attentionState: z.enum(['needs_you', 'progressing', 'complete']),
  headline: z.string(),
  summary: z.string(),
  metrics: z.object({
    decisionsResolved: z.number(),
    pendingDecisions: z.number(),
    artifactsProduced: z.number(),
    prReceipts: z.number(),
    activeInitiatives: z.number(),
    blockedWork: z.number(),
    goalsTracked: z.number(),
    completedRuns: z.number(),
    failedRuns: z.number(),
    receiptsProduced: z.number(),
    valueCreatedUsd: z.number(),
    avgQualityScore: nullableNumber,
    outreachWins: z.number().optional(),
  }),
  topPriorities: z.array(resourceSchema),
  rollups: z.array(resourceSchema),
  reportingNarrative: z.object({
    headline: z.string(),
    whatChanged: z.array(z.string()),
    proof: z.array(z.string()),
    risks: z.array(z.string()),
    nextAction: nullableString,
    briefMarkdown: z.string(),
  }),
  decisionChronology: z.array(decisionSchema),
  artifactLedger: z.array(artifactSchema),
  continuity: z.object({
    headline: z.string(),
    summary: z.string(),
    metrics: z.object({
      linkedClients: z.number(),
      observedClients: z.number(),
      verifiedClients: z.number(),
      healthyClients: z.number().optional(),
      attentionClients: z.number().optional(),
      silentLinkedClients: z.number(),
      crossClientSessions: z.number(),
      records: z.number(),
    }),
    clients: z.array(resourceSchema),
    events: z.array(resourceSchema),
  }),
  prVelocity: z.object({
    receipts: z.array(resourceSchema),
    source: z.literal('orgx_pr_receipts'),
    coverage: z.enum(['present', 'missing']),
  }),
  initiatives: z.array(resourceSchema),
  goals: z.array(resourceSchema),
  dataGaps: z.array(z.string()),
});

export const reviewContractSchema = z.object({
  schemaVersion: z.string(),
  quality: z.object({
    state: z.string().optional(),
    score: z.number().optional(),
    summary: z.string().optional(),
  }),
  workflow: z.object({
    state: z.string().optional(),
    headline: z.string().optional(),
    nextAction: z.string().optional(),
  }),
  ruling: z
    .object({ state: z.string().optional(), note: z.string().optional() })
    .optional(),
  outcome: z
    .object({ state: z.string().optional(), summary: z.string().optional() })
    .optional(),
  modalityGate: z
    .object({ state: z.string().optional(), reason: z.string().optional() })
    .optional(),
});

const activationActionSchema = z.object({
  tool: z.string(),
  label: z.string(),
  prompt: z.string(),
  args: z
    .object({
      action: z.string().optional(),
      type: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().optional(),
      mode: z.string().optional(),
      period: z.string().optional(),
      receipt_type: z.string().optional(),
    })
    .optional(),
});

export const activationSchema = z.object({
  source_client: nullableString,
  playbook: z.string(),
  progress_pct: z.number(),
  completed_stages: z.array(z.string()),
  next_stage: nullableString,
  optimization_hint: nullableString,
  next_action: activationActionSchema.nullable(),
  hook_coverage: z.object({
    source_client: z.string(),
    coverage_level: z.string(),
    surfaces: z.array(
      z.object({
        surface: z.string(),
        status: z.string(),
        proof: z.string(),
        reporting_role: z.string(),
      })
    ),
    reporting_entrypoints: z.array(activationActionSchema),
    required_proof: z.array(z.string()),
    gaps: z.array(z.string()),
  }),
  celebration: z
    .object({
      title: z.string(),
      message: z.string(),
      next_action: activationActionSchema.nullable(),
      persistent_adoption: z.object({
        label: z.string(),
        suggestion: z.string(),
        canonical_block_url: z.string(),
      }),
    })
    .optional(),
});

export const relatedContextSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().optional(),
      title: z.string(),
      domain: z.string(),
      type: z.string().optional(),
      reason: z.string().optional(),
    })
  ),
  count: z.number().optional(),
});

export const workspaceInfluenceSchema = z.object({
  workspace_id: z.string().optional(),
  summary: z.string().optional(),
  signals: z.array(resourceSchema).optional(),
});
