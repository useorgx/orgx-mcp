import { applySearchDateRange } from '@/lib/searchFilters';
import { readEntitySearchDateRange } from '@/lib/server/entitySearchDateRange';
import { NextRequest, NextResponse } from 'next/server';

import {
  getSupabaseAdmin,
  resolveSupabaseUserIdForExternal,
} from '@/lib/supabase';
import {
  ensureServiceRequestAuthorized,
  extractGatewayUserId,
  extractGatewayUserEmail,
  resolveGatewayOrgxUserIdHint,
} from '@/lib/server/auth/serviceKey';
import { verifyGatewayOrgxUserId } from '@/lib/server/auth/gatewayOrgxUser';
import { authenticateApiKey } from '@/lib/server/auth/apiKeyAuth';
import { ensureServiceOrApiAuthorized } from '@/lib/server/auth/serviceOrApiAuth';
import { logger } from '@/lib/logger';
import { jsonOk } from '@/lib/server/apiResponse';
import { withDegradedPayload } from '@/lib/server/degradedPayload';
import { errors, assertRequired, assertString } from '@/lib/server/apiErrors';
import { markCompatibilityResponse } from '@/lib/server/api/compatibilityHeaders';
import { isStatementTimeout } from '@/lib/server/queryHelpers';
import { compose, toRoute, type ApiHandler } from '@/lib/server/apiRoute';
import { listCapabilities } from '@/lib/agents/capabilityRegistry';
import { AGENT_CONFIGS, type AgentDomainId } from '@/data/agent-config';
import { ensureUserProfileForClerkUser } from '@/lib/server/profile';
import { emitEntityEvent } from '@/lib/server/eventMiddleware';
import { kickoffInitiativePlanningRun } from '@/lib/server/workspace/initiatives';
import { ensureBacklogMilestoneId } from '@/lib/initiatives/hierarchy';
import { parseBoolean } from '@/lib/shared/strings';
import { ModelDefaults } from '@/lib/ai/models';
import { studioTool } from '@/lib/agents/tools/studio';
import { studioVideoTool } from '@/lib/agents/tools/studioVideo';
import { parseClientArtifactCreateBody } from '@/lib/server/artifacts/clientContract';
import { createClientArtifact } from '@/lib/server/artifacts/clientService';
import { resolveClientArtifactCreateBodyRefs } from '@/lib/server/artifacts/resolveClientArtifactRefs';
import { resolveEntityIdReference } from '@/lib/server/entities/entityIdResolver';
import {
  createRelationshipEntity,
  isRelationshipEntityType,
  type RelationshipEntityType,
} from '@/lib/server/entities/relationshipEntityWrites';
import {
  findSyntheticReferenceField,
  isClawdbotPluginUserAgent,
  isSyntheticEntityReferenceId,
} from '@/lib/server/entities/syntheticIdGuard';
import { ensureInitiativeActivationDispatch } from '@/lib/server/orchestrator/initiativeActivation';
import { isTerminalTaskStatus } from '@/lib/server/entities/taskStatusTransitions';
import { createBlockerEntityApiResponse } from '@/lib/server/entities/blockerEntityCreateResponse';
import { directRunLifecycleViolation } from '@/lib/server/entities/runEntityLifecycleGuard';
import {
  normalizeEntityTypeAlias,
  preserveLegacyIssueSourceType,
} from '@/lib/server/entities/entityTypeAliases';
import {
  decisionCreateScopeViolation,
  decisionCreateLifecycleViolation,
  decisionUpdateLifecycleViolation,
  directHumanDecisionActionMessage,
  resolvePendingDecisionProposalUpdateScope,
  type DecisionScopeClient,
  type PendingDecisionProposalUpdateScope,
} from '@/lib/server/decisions/entityLifecycleGuard';
import { inferWorkstreamsIntelligence } from '@/lib/server/planning/intelligence';
import {
  isGoalInvariantViolation,
  maybeRecordGoalInvariantViolation,
} from '@/lib/people-first/serverTelemetry';
import type { SupabaseDbClient } from '@/types/database';
import { publishStreamTransition } from '@/lib/server/orchestrator/streamTransitions';
import {
  STREAM_AGENT_DOMAINS,
  normalizeStreamAgentDomain,
} from '@/lib/entities/streamDomains';
import { MISSION_CONTROL_NODE_TYPES } from '@/types/domain/entity';
import {
  ARTIFACT_WORKFLOW_STATUSES,
  BLOCKER_STATUSES,
  BUG_REPORT_STATUSES,
  DECISION_STATUSES,
  INITIATIVE_PRIORITY_LEVELS,
  INITIATIVE_STATUSES,
  LAUNCH_CHECKPOINT_DECISIONS,
  MILESTONE_STATUSES,
  OBJECTIVE_STATUSES,
  OPPORTUNITY_STATUSES,
  PLAN_SESSION_STATUSES,
  PLAYBOOK_STATUSES,
  PRIORITY_LEVEL_3,
  PRIORITY_LEVEL_4,
  PROJECT_STATUSES,
  PROSPECT_STATUSES,
  RUN_STATUSES,
  STUDIO_BRAND_INGESTION_STATUSES,
  STREAM_STATUSES,
  STUDIO_CONTENT_STATUSES,
  TASK_STATUSES,
  WORKFLOW_STATUSES,
  WORKSTREAM_STATUSES,
  normalizeDecisionStatus,
} from '@/types/domain/status';

/**
 * Maximum wall-clock time for a single Supabase query before we abort.
 * Keeps the request well inside Vercel's 60 s function timeout so the
 * client gets a clear `timeout` error (503) instead of a generic FUNCTION_INVOCATION_TIMEOUT.
 */
const QUERY_TIMEOUT_MS = 15_000;

/**
 * Race a Supabase query against a timeout. Returns the query result or throws
 * a gateway-timeout error if the query exceeds QUERY_TIMEOUT_MS.
 */
async function withQueryTimeout<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(errors.timeout('Query timed out')),
      QUERY_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an external ID (Clerk user ID) to the internal Supabase UUID.
 *
 * If the ID is already a UUID, returns it as-is.
 * If it's a Clerk external_id (user_xxx), looks up the Supabase row.
 * If no row exists yet, lazy-provisions one via `ensureUserProfileForClerkUser`
 * (fetches Clerk identity + upserts the Supabase row). This absorbs the
 * common auth-drift failure where a Clerk OAuth session exists but the
 * Supabase row was never created — usually because the `user.created`
 * webhook hadn't fired yet or the Inngest sync errored. Without this, the
 * very first MCP tool call after signup throws
 * "User not found for external_id: user_xxx" and nothing gets created.
 */
async function resolveOwnerId(
  ownerId: string,
  opts?: { gatewayEmail?: string | null; gatewayOrgxUserId?: string | null }
): Promise<string> {
  // Verified fast path: the gateway resolved this session's internal UUID at
  // login and forwarded it. Confirm it (existence + email agreement) rather than
  // trust it verbatim; on any doubt fall through to the Clerk-id resolution
  // below. The caller only supplies gatewayOrgxUserId when `ownerId` is the
  // gateway's own user (never for an explicit owner override), so a verified
  // hit here is the same identity the Clerk-id path would resolve — just without
  // the multi-tier email JOIN or a request-time provision.
  if (opts?.gatewayOrgxUserId) {
    const verified = await verifyGatewayOrgxUserId(
      opts.gatewayOrgxUserId,
      opts.gatewayEmail ?? null,
      '[api:entities]'
    );
    if (verified) return verified;
  }

  // Check if it looks like a UUID (contains dashes in expected places)
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(ownerId)) {
    return ownerId;
  }

  // Looks like a Clerk external_id (e.g., user_xxx)
  if (ownerId.startsWith('user_')) {
    const admin = getSupabaseAdmin();
    if (!admin) {
      throw errors.serviceUnavailable('Database connection unavailable');
    }

    // Resolver consults users.external_id AND the user_external_ids
    // mapping — a raw column lookup misses identities from other
    // environments (MCP gateway, second Clerk instance).
    const resolved = await resolveSupabaseUserIdForExternal(ownerId, {
      createIfMissing: false,
    });
    if (resolved) {
      return resolved;
    }

    // Lazy-provision. The caller presented a valid OAuth bearer (meaning
    // the Clerk user exists), but their Supabase row isn't there yet.
    // ensureUserProfileForClerkUser fetches Clerk identity via the admin
    // API and upserts the users row through resolveSupabaseUserIdForExternal.
    // Seed with the gateway-verified email: the external id may belong to a
    // Clerk instance this app can't query (MCP gateway / second instance),
    // in which case the Clerk lookup returns nothing and, without the seed,
    // provisioning dies with "no verified email". With the seed, the email
    // fallback finds the existing account and self-heals the
    // user_external_ids mapping so future email-less calls resolve too.
    try {
      const profile = await ensureUserProfileForClerkUser(
        ownerId,
        opts?.gatewayEmail ? { email: opts.gatewayEmail } : undefined
      );
      logger.info('[api:entities] lazy-provisioned supabase user', {
        externalId: ownerId,
        supabaseUserId: profile.id,
      });
      return profile.id;
    } catch (provisionError) {
      logger.error('[api:entities] lazy-provision failed', {
        externalId: ownerId,
        error:
          provisionError instanceof Error
            ? provisionError.message
            : String(provisionError),
      });
      // Keep the original user-facing error shape so existing clients
      // still branch correctly, but surface the richer context in logs.
      throw errors.badRequest(
        `User not found for external_id: ${ownerId} (lazy-provision failed)`
      );
    }
  }

  // Unknown format - return as-is and let DB validation handle it
  return ownerId;
}

/**
 * Resolve a fallback owner when no explicit owner_id was provided.
 *
 * Priority:
 *  1. X-Orgx-User-Id header (set by MCP gateway after OAuth verification)
 *  2. API key user identity (plugin/local mode)
 *  3. Earliest-created user in the database (org founder / primary user)
 *
 * Returns null only when neither source yields a user.
 */
async function resolveDefaultOwnerId(request: Request): Promise<string | null> {
  // 1. Gateway-propagated user identity (trusted — service key already validated)
  const gatewayUserId = extractGatewayUserId(request);
  if (gatewayUserId) {
    logger.info('[api:entities] resolved owner from gateway header', {
      userId: gatewayUserId,
    });
    return gatewayUserId;
  }

  // 2. API key identity (plugin / local mode)
  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth?.userId) {
    logger.info('[api:entities] resolved owner from api key', {
      userId: apiKeyAuth.userId,
      keyId: apiKeyAuth.keyId,
    });
    return apiKeyAuth.userId;
  }

  // 3. Org primary user (first user created)
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from('users')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn('[api:entities] failed to resolve default owner', {
      error: error.message,
    });
    return null;
  }

  if (data?.id) {
    logger.info('[api:entities] resolved owner from org primary user', {
      userId: data.id,
    });
  }

  return data?.id ?? null;
}

/**
 * Entity type definitions with their table names and supported actions
 */
const DECISION_STATUSES_WITH_REJECTED = [
  ...DECISION_STATUSES,
  'rejected',
] as const;

/**
 * `ARTIFACT_WORKFLOW_STATUSES` plus the two values the artifact_status enum
 * gained in 20260725224500_artifact_review_authority.sql: `eval_passed` (the
 * machine's terminal state — verified, not accepted) and `rejected` (the
 * terminal negative the enum previously had no way to express).
 */
const ARTIFACT_STATUSES_WITH_REVIEW_AUTHORITY = [
  ...ARTIFACT_WORKFLOW_STATUSES,
  'eval_passed',
  'rejected',
] as const;

/**
 * Artifact statuses that assert a PERSON ruled, and so may not be written
 * through this route at all.
 *
 * This is the guard that actually holds. `validStatuses` and `lifecycleActions`
 * above do NOT gate writes: `validStatuses` is only read to validate a GET
 * status filter and to format the message on a DB constraint violation, and
 * nothing reads `artifact.lifecycleActions` at all (the sibling
 * `/api/entities/[type]/[id]/[action]` route carries its own ENTITY_CONFIG,
 * which has no `artifact` entry). Both POST and PATCH here pass `payload`
 * straight to the service-role client, so without this check any holder of an
 * API key or the service header could write `status: 'approved'` directly onto
 * a work_artifacts row — bypassing ArtifactRegistry.updateArtifactReview, its
 * human-only guard, and the acceptance ledger. That is the exact bypass
 * `eval_passed` exists to remove.
 *
 * A human acceptance goes through PATCH /api/artifacts/[artifactId]. The most
 * an automated caller can reach from here is `eval_passed`: verified, not
 * accepted.
 */
const ARTIFACT_HUMAN_ONLY_STATUSES = new Set(['approved', 'rejected']);

function assertArtifactStatusWritable(type: unknown, status: unknown): void {
  if (type !== 'artifact' || typeof status !== 'string') return;
  const normalized = status.trim().toLowerCase();
  if (!ARTIFACT_HUMAN_ONLY_STATUSES.has(normalized)) return;
  throw errors.forbidden(
    `Artifact status '${normalized}' asserts that a person ruled on the work and cannot be set through /api/entities. ` +
      `Use PATCH /api/artifacts/{artifactId}, which records the ruling in the acceptance ledger. ` +
      `An automated reviewer should write 'eval_passed' instead.`
  );
}

const ENTITY_CONFIG = {
  project: {
    table: 'projects',
    statusColumn: 'status',
    validStatuses: PROJECT_STATUSES,
    lifecycleActions: {
      launch: { from: ['draft'], to: 'active' },
      archive: { from: ['draft', 'active'], to: 'archived' },
    },
    relationships: ['initiatives', 'workflows'],
    select:
      'id, name, description, status, created_at, updated_at, owner_id, launched_at',
  },
  initiative: {
    table: 'initiatives',
    statusColumn: 'status',
    validStatuses: INITIATIVE_STATUSES,
    validPriorities: INITIATIVE_PRIORITY_LEVELS,
    lifecycleActions: {
      launch: { from: ['draft'], to: 'active' },
      pause: { from: ['active'], to: 'paused' },
      resume: { from: ['paused'], to: 'active' },
      complete: { from: ['active', 'paused'], to: 'completed' },
      archive: {
        from: ['draft', 'active', 'paused', 'completed'],
        to: 'archived',
      },
    },
    relationships: [
      'milestones(*, workstream_tasks(*))',
      'workstreams(*, milestones(*), workstream_tasks(*))',
    ],
    select:
      'id, title, summary, status, risk_level, priority, sequence, objective_id, estimated_hours, estimated_spend_usd, estimated_roi_usd, actual_hours, actual_spend_usd, daily_limit_usd, hourly_limit_usd, priority_rank, metadata, context, created_at, updated_at, workspace_id',
  },
  milestone: {
    table: 'milestones',
    statusColumn: 'status',
    validStatuses: MILESTONE_STATUSES,
    validPriorities: PRIORITY_LEVEL_4,
    lifecycleActions: {
      start: { from: ['planned'], to: 'in_progress' },
      complete: { from: ['in_progress', 'at_risk'], to: 'completed' },
      flag_risk: { from: ['in_progress'], to: 'at_risk' },
      cancel: { from: ['planned', 'in_progress', 'at_risk'], to: 'cancelled' },
    },
    relationships: ['workstream_tasks'],
    select:
      'id, title, description, status, due_date, sequence, priority, initiative_id, workstream_id, estimated_hours, estimated_spend_usd, estimated_roi_usd, actual_hours, actual_spend_usd, daily_limit_usd, hourly_limit_usd, priority_rank, metadata, context, created_at, updated_at, workspace_id',
  },
  workstream: {
    table: 'workstreams',
    statusColumn: 'status',
    validStatuses: WORKSTREAM_STATUSES,
    validPriorities: PRIORITY_LEVEL_4,
    lifecycleActions: {
      start: { from: ['not_started'], to: 'active' },
      pause: { from: ['active'], to: 'paused' },
      resume: { from: ['paused', 'blocked'], to: 'active' },
      block: { from: ['active'], to: 'blocked' },
      complete: { from: ['active'], to: 'completed' },
    },
    relationships: ['workstream_tasks', 'milestones'],
    select:
      'id, name, summary, status, sequence, priority, domain, persona, initiative_id, progress, estimated_hours, estimated_spend_usd, estimated_roi_usd, actual_hours, actual_spend_usd, daily_limit_usd, hourly_limit_usd, priority_rank, metadata, context, created_at, updated_at, workspace_id',
  },
  stream: {
    table: 'streams',
    statusColumn: 'status',
    validStatuses: STREAM_STATUSES,
    lifecycleActions: {
      start: { from: ['ready'], to: 'ready' },
      pause: { from: ['active', 'ready'], to: 'paused' },
      resume: { from: ['paused', 'blocked'], to: 'ready' },
      block: { from: ['active'], to: 'blocked' },
      complete: { from: ['active'], to: 'completed' },
      fail: { from: ['active', 'blocked'], to: 'failed' },
    },
    relationships: [],
    select:
      'id, name, description, status, initiative_id, workstream_id, agent_domain, progress_pct, confidence, blocked_reason, blocked_since, estimated_completion, actual_start, actual_end, auto_continue, created_at, updated_at, workspace_id',
  },
  task: {
    table: 'workstream_tasks',
    statusColumn: 'status',
    validStatuses: TASK_STATUSES,
    validPriorities: PRIORITY_LEVEL_3,
    lifecycleActions: {
      start: { from: ['todo'], to: 'in_progress' },
      complete: { from: ['todo', 'in_progress'], to: 'done' },
      block: { from: ['todo', 'in_progress'], to: 'blocked' },
      unblock: { from: ['blocked'], to: 'in_progress' },
      reopen: { from: ['done'], to: 'todo' },
    },
    relationships: [],
    select:
      'id, title, description, status, priority, sequence, due_date, milestone_id, workstream_id, initiative_id, estimated_hours, estimated_spend_usd, estimated_roi_usd, actual_hours, actual_spend_usd, daily_limit_usd, hourly_limit_usd, priority_rank, metadata, context, created_at, updated_at, workspace_id',
  },
  prospect: {
    table: 'sales_prospects',
    statusColumn: 'status',
    validStatuses: PROSPECT_STATUSES,
    lifecycleActions: {
      engage: { from: ['identified'], to: 'engaged' },
      qualify: { from: ['identified', 'engaged'], to: 'qualified' },
      book_audit: {
        from: ['identified', 'engaged', 'qualified'],
        to: 'audit_booked',
      },
      complete_audit: { from: ['audit_booked'], to: 'audit_completed' },
      win: {
        from: ['qualified', 'audit_booked', 'audit_completed'],
        to: 'closed_won',
      },
      lose: {
        from: [
          'identified',
          'engaged',
          'qualified',
          'audit_booked',
          'audit_completed',
        ],
        to: 'closed_lost',
      },
      archive: {
        from: ['closed_lost'],
        to: 'archived',
      },
    },
    relationships: ['sales_opportunities'],
    select:
      'id, name, email, company, handle, intent, status, source, enrichment, metadata, engaged_at, qualified_at, closed_at, archived_at, created_at, updated_at, workspace_id, owner_id',
  },
  opportunity: {
    table: 'sales_opportunities',
    statusColumn: 'status',
    validStatuses: OPPORTUNITY_STATUSES,
    lifecycleActions: {
      qualify: { from: ['draft'], to: 'qualified' },
      schedule_audit: {
        from: ['draft', 'qualified'],
        to: 'audit_scheduled',
      },
      complete_audit: { from: ['audit_scheduled'], to: 'audit_completed' },
      offer: {
        from: ['qualified', 'audit_scheduled', 'audit_completed'],
        to: 'offer_made',
      },
      win: {
        from: ['qualified', 'audit_scheduled', 'audit_completed', 'offer_made'],
        to: 'closed_won',
      },
      lose: {
        from: [
          'draft',
          'qualified',
          'audit_scheduled',
          'audit_completed',
          'offer_made',
        ],
        to: 'closed_lost',
      },
    },
    relationships: ['sales_prospects(*)'],
    select:
      'id, name, description, status, sku, stripe_checkout_session_id, stripe_payment_intent_id, value_cents, currency, expected_close_date, audit_at, closed_at, metadata, sales_prospect_id, created_at, updated_at, workspace_id, owner_id',
  },
  bug_report: {
    table: 'bug_reports',
    statusColumn: 'status',
    validStatuses: BUG_REPORT_STATUSES,
    lifecycleActions: {
      triage: { from: ['open'], to: 'triaged' },
      start: { from: ['triaged'], to: 'in_progress' },
      resolve: {
        from: ['open', 'triaged', 'in_progress'],
        to: 'resolved',
      },
      close: { from: ['resolved'], to: 'closed' },
      decline: {
        from: ['open', 'triaged', 'in_progress'],
        to: 'wont_fix',
      },
    },
    relationships: [],
    select:
      'id, title, description, severity, status, reporter_email, reporter_user_id, triaged_at, sla_due_at, resolved_at, closed_at, source_url, metadata, created_at, updated_at, workspace_id, owner_id',
  },
  launch_checkpoint: {
    table: 'launch_checkpoints',
    statusColumn: 'decision',
    validStatuses: LAUNCH_CHECKPOINT_DECISIONS,
    lifecycleActions: {
      go: { from: ['pending', 'hold'], to: 'go' },
      hold: { from: ['pending', 'go'], to: 'hold' },
      fallback: { from: ['pending', 'go', 'hold'], to: 'fallback' },
      reset: { from: ['go', 'hold', 'fallback'], to: 'pending' },
    },
    relationships: [],
    select:
      'id, name, scheduled_at, decision, notes, decided_by_user_id, decided_at, metadata, created_at, updated_at, workspace_id, owner_id',
  },
  objective: {
    table: 'company_objectives',
    statusColumn: 'status',
    validStatuses: OBJECTIVE_STATUSES,
    lifecycleActions: {
      pause: { from: ['active'], to: 'paused' },
      resume: { from: ['paused'], to: 'active' },
      complete: { from: ['active'], to: 'completed' },
      archive: { from: ['active', 'paused', 'completed'], to: 'archived' },
    },
    relationships: ['initiatives'],
    select:
      'id, title, description, status, timeframe, target_value, current_value, created_at, workspace_id',
  },
  playbook: {
    table: 'playbooks',
    statusColumn: 'status',
    validStatuses: PLAYBOOK_STATUSES,
    lifecycleActions: {
      activate: { from: ['draft'], to: 'active' },
      archive: { from: ['draft', 'active'], to: 'archived' },
    },
    relationships: [],
    select: 'id, title, description, persona, status, created_at, workspace_id',
  },
  decision: {
    table: 'decision_requests',
    statusColumn: 'status',
    validStatuses: DECISION_STATUSES_WITH_REJECTED,
    validPriorities: PRIORITY_LEVEL_4,
    lifecycleActions: {
      approve: { from: ['pending'], to: 'approved' },
      decline: { from: ['pending'], to: 'declined' },
      // Backward-compat alias: reject maps to canonical declined.
      reject: { from: ['pending'], to: 'declined' },
      supersede: { from: ['pending'], to: 'superseded' },
      cancel: { from: ['pending'], to: 'cancelled' },
    },
    relationships: [],
    select:
      'id, title, summary, status, priority, decision_type, initiative_id, workstream_id, agent_id, due_at, source_system, conflict_source, dedupe_key, source_run_id, source_session_id, source_stream_id, recommended_action, first_seen_at, last_seen_at, occurrence_count, metadata, created_at, updated_at, workspace_id',
  },
  artifact: {
    table: 'work_artifacts',
    statusColumn: 'status',
    validStatuses: ARTIFACT_STATUSES_WITH_REVIEW_AUTHORITY,
    lifecycleActions: {
      submit_for_review: { from: ['draft'], to: 'in_review' },
      // `approve` is deliberately ABSENT, so this table never documents a
      // machine-reachable route to `approved`. Note what this block does and
      // does NOT do: nothing currently reads `artifact.lifecycleActions` — the
      // sibling /api/entities/[type]/[id]/[action] route carries its own
      // ENTITY_CONFIG with no `artifact` entry, and lib/server/entities/
      // specRegistry.ts covers only prospect/opportunity/bug_report/
      // launch_checkpoint. This is the declared lifecycle, not the enforcement
      // point. The enforcement point is assertArtifactStatusWritable(), called
      // on both the POST insert and the PATCH update above, because those are
      // what actually write status through to the service-role client.
      // Human acceptance goes through PATCH /api/artifacts/[artifactId], which
      // routes to ArtifactRegistry.updateArtifactReview and records the ruling.
      // The most an automated caller can reach from here is `eval_passed`:
      // verified, not accepted.
      eval_pass: { from: ['in_review'], to: 'eval_passed' },
      request_changes: {
        from: ['in_review', 'eval_passed'],
        to: 'changes_requested',
      },
      revise: { from: ['changes_requested'], to: 'draft' },
      supersede: {
        from: ['draft', 'eval_passed', 'approved'],
        to: 'superseded',
      },
      archive: {
        from: ['draft', 'eval_passed', 'approved', 'superseded'],
        to: 'archived',
      },
    },
    relationships: [],
    select:
      'id, name, description, artifact_url, status, version, artifact_type, entity_type, entity_id, metadata, verification, created_at, updated_at',
  },
  run: {
    table: 'agent_runs',
    statusColumn: 'status',
    validStatuses: RUN_STATUSES,
    lifecycleActions: {
      start: { from: ['draft', 'planned'], to: 'running' },
      pause: { from: ['running'], to: 'paused' },
      resume: { from: ['paused'], to: 'running' },
      complete: { from: ['running'], to: 'completed' },
      cancel: {
        from: ['draft', 'planned', 'running', 'paused', 'blocked'],
        to: 'cancelled',
      },
      archive: { from: ['completed', 'failed', 'cancelled'], to: 'archived' },
    },
    relationships: ['agent_run_steps', 'agent_run_artifacts'],
    select:
      'id, title, summary, status, initiative_id, primary_agent_id, cost_cents, token_count, started_at, completed_at, created_at, workspace_id, metadata',
  },
  blocker: {
    table: 'agent_run_blockers',
    statusColumn: 'status',
    validStatuses: BLOCKER_STATUSES,
    lifecycleActions: {
      resolve: { from: ['open'], to: 'resolved' },
      dismiss: { from: ['open'], to: 'dismissed' },
    },
    relationships: [],
    select:
      'id, title, description, type, blocker_kind, source_type, attention_mode, decision_id, lifecycle_version, status, run_id, step_id, resolution, resolved_at, created_at',
  },
  workflow: {
    table: 'workflows',
    statusColumn: 'status',
    validStatuses: WORKFLOW_STATUSES,
    lifecycleActions: {
      activate: { from: ['draft'], to: 'active' },
      pause: { from: ['active'], to: 'paused' },
      resume: { from: ['paused'], to: 'active' },
      complete: { from: ['active'], to: 'completed' },
    },
    relationships: [],
    select:
      'id, name, description, status, project_id, nodes, edges, created_at, updated_at',
  },
  skill: {
    table: 'plan_skills',
    statusColumn: 'status',
    validStatuses: PROJECT_STATUSES,
    lifecycleActions: {
      activate: { from: ['draft', 'archived'], to: 'active' },
      archive: { from: ['draft', 'active'], to: 'archived' },
    },
    relationships: [],
    select:
      'id, name, description, trigger_keywords, trigger_domains, prompt_template, times_applied, status, created_at, updated_at',
  },
  plan_session: {
    table: 'plan_sessions',
    statusColumn: 'status',
    validStatuses: PLAN_SESSION_STATUSES,
    lifecycleActions: {
      start: { from: ['active'], to: 'active' },
      complete: { from: ['active'], to: 'completed' },
      abandon: { from: ['active'], to: 'abandoned' },
      reopen: { from: ['completed', 'abandoned'], to: 'active' },
    },
    relationships: ['plan_edits'],
    select:
      'id, title, feature_name, current_plan, status, domains_detected, started_at, completed_at, created_at, updated_at',
  },
  workspace: {
    table: 'workspaces',
    statusColumn: null, // No status column
    validStatuses: [],
    validPriorities: INITIATIVE_PRIORITY_LEVELS,
    lifecycleActions: {},
    relationships: ['initiatives'],
    select:
      'id, name, slug, description, is_default, priority, project_id, created_at, updated_at',
  },
  studio_brand: {
    table: 'studio_brands',
    statusColumn: 'ingestion_status',
    validStatuses: STUDIO_BRAND_INGESTION_STATUSES,
    lifecycleActions: {},
    relationships: [],
    select:
      'id, name, domain, visibility, is_default, ingestion_status, pipeline_stage, workspace_id, user_id, created_at, updated_at',
  },
  studio_content: {
    table: 'studio_content',
    statusColumn: 'status',
    validStatuses: STUDIO_CONTENT_STATUSES,
    lifecycleActions: {},
    relationships: [],
    select:
      'id, content_type, title, prompt, status, modality, brand_id, is_favorite, user_id, run_id, created_at, updated_at',
  },
  // ---------------------------------------------------------------------------
  // Relationship OS spine. Creates for person/business/goal are DELEGATED to the
  // canonical write layer (see the isRelationshipEntityType guard in postHandler)
  // so the raw payload path below is never used for them on create. These config
  // entries drive reads, list, search, and goal lifecycle transitions.
  // `relationship` (person_business_roles) is read-first: no create-via-chain
  // semantics yet, lifecycle transitions are a fast-follow.
  // ---------------------------------------------------------------------------
  person: {
    table: 'persons',
    statusColumn: 'relationship_stage',
    validStatuses: [
      'stranger',
      'prospect',
      'conversation',
      'design_partner',
      'active_client',
      'paused',
      'churned',
      'alumni',
    ],
    lifecycleActions: {},
    relationships: [],
    select:
      'id, display_name, given_name, family_name, headline, notes_markdown, primary_email, primary_handle, contact_channels, relationship_stage, trust_tier, last_touch_at, next_action_at, metadata, created_at, updated_at, workspace_id, owner_id',
  },
  business: {
    table: 'businesses',
    statusColumn: 'engagement_stage',
    validStatuses: [
      'unknown',
      'qualified',
      'engaged',
      'active',
      'paused',
      'churned',
      'alumni',
    ],
    lifecycleActions: {},
    relationships: [],
    select:
      'id, legal_name, display_name, website, industry, size, engagement_stage, engagement_model, primary_domain, domain_tags, notes_markdown, last_touch_at, next_action_at, metadata, created_at, updated_at, workspace_id, owner_id',
  },
  goal: {
    table: 'goals',
    statusColumn: 'status',
    validStatuses: [
      'draft',
      'active',
      'at_risk',
      'blocked',
      'achieved',
      'missed',
      'descoped',
      'pivoted',
    ],
    lifecycleActions: {
      activate: { from: ['draft'], to: 'active' },
      pause: { from: ['active'], to: 'blocked' },
      resume: { from: ['blocked', 'at_risk'], to: 'active' },
      flag_risk: { from: ['active'], to: 'at_risk' },
      achieve: { from: ['active', 'at_risk', 'blocked'], to: 'achieved' },
      miss: { from: ['active', 'at_risk', 'blocked'], to: 'missed' },
      descope: {
        from: ['draft', 'active', 'at_risk', 'blocked'],
        to: 'descoped',
      },
    },
    relationships: [],
    select:
      'id, title, description_markdown, owner_person_id, owner_business_id, target_type, status, priority, objective_id, timeframe_start, timeframe_end, metadata, created_at, updated_at, workspace_id, owner_id',
  },
  relationship: {
    table: 'person_business_roles',
    statusColumn: 'relationship_lifecycle_stage',
    validStatuses: [], // 25-stage lifecycle CHECK enforced at DB; route stays permissive until transitions land
    lifecycleActions: {},
    relationships: [],
    select:
      'id, person_id, business_id, role_title, role_category, is_primary_contact, source_of_truth, relationship_lifecycle_stage, trust_tier, owner_user_id, owner_agent_slug, latest_artifact_id, latest_room_id, metadata, created_at, updated_at, workspace_id',
  },
} as const;

type EntityType = keyof typeof ENTITY_CONFIG;

const ENTITY_FIELD_ALIASES: Partial<
  Record<EntityType, Record<string, string>>
> = {
  workstream: {
    title: 'name',
  },
  task: {
    domain: 'metadata',
  },
};

function isValidEntityType(type: string): type is EntityType {
  return type in ENTITY_CONFIG;
}

const CONTEXT_SUPPORTED_TYPES = new Set<EntityType>([
  'initiative',
  'workstream',
  'milestone',
  'task',
]);
const HIERARCHY_ENTITY_TYPES = new Set<EntityType>(
  MISSION_CONTROL_NODE_TYPES as readonly EntityType[]
);
const TASK_EXECUTION_TYPES = new Set([
  'research',
  'create',
  'review',
  'implement',
]);

const OWNER_FILTER_SUPPORTED_TYPES = new Set<EntityType>([
  'person',
  'business',
  'goal',
  'project',
  'initiative',
  'milestone',
  'workstream',
  'task',
  'objective',
  'playbook',
  'decision',
  'artifact',
  'run',
  'blocker',
  'workflow',
  'skill',
  'plan_session',
  'workspace',
]);

// Entity types whose tables support workspace scoping via workspace_id.
const COMMAND_CENTER_FILTER_SUPPORTED_TYPES = new Set<EntityType>([
  'person',
  'business',
  'goal',
  'relationship',
  'initiative',
  'workstream',
  'milestone',
  'task',
  'decision',
  'objective',
  'playbook',
  'run',
  'stream',
  'studio_brand',
]);

const SEQUENCE_ORDERED_TYPES = new Set<EntityType>([
  'initiative',
  'workstream',
  'milestone',
  'task',
]);

const LIST_ORDERABLE_COLUMNS = [
  'created_at',
  'updated_at',
  'sequence',
  'due_date',
  'priority',
  'status',
  'title',
  'name',
] as const;

type ListOrderableColumn = (typeof LIST_ORDERABLE_COLUMNS)[number];
type ListOrderBy = ListOrderableColumn | 'natural';
type ListOrderDirection = 'asc' | 'desc';

const LIST_ORDERABLE_COLUMN_SET: ReadonlySet<string> = new Set(
  LIST_ORDERABLE_COLUMNS
);

const ENTITY_SEARCH_COLUMN_MAP: Partial<Record<EntityType, string[]>> = {
  project: ['name', 'description'],
  initiative: ['title', 'summary'],
  milestone: ['title', 'description'],
  workstream: ['name', 'summary'],
  stream: ['name', 'description'],
  task: ['title', 'description'],
  objective: ['title', 'description'],
  playbook: ['title', 'description'],
  decision: ['title', 'summary'],
  artifact: ['name', 'description'],
  run: ['title', 'summary'],
  workflow: ['name', 'description'],
  skill: ['name', 'description'],
  plan_session: ['title', 'feature_name', 'current_plan'],
  workspace: ['name', 'description'],
};

function normalizeEntitySearchTerm(value: string): string {
  return value
    .replace(/[%*]/g, ' ')
    .replace(/,/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenizeEntitySearchTerm(value: string): string[] {
  return Array.from(
    new Set(
      normalizeEntitySearchTerm(value)
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  ).slice(0, 8);
}

function buildEntitySearchExpression(
  type: EntityType,
  searchValue: string
): string | null {
  const columns = ENTITY_SEARCH_COLUMN_MAP[type];
  if (!columns || columns.length === 0) return null;
  const normalized = normalizeEntitySearchTerm(searchValue);
  if (!normalized) return null;
  const phraseClauses = columns.map(
    (column) => `${column}.ilike.%${normalized}%`
  );
  const tokenClauses = tokenizeEntitySearchTerm(searchValue)
    .filter((token) => token !== normalized.toLowerCase())
    .map((token) => {
      const perToken = columns.map((column) => `${column}.ilike.%${token}%`);
      return `or(${perToken.join(',')})`;
    });

  if (tokenClauses.length === 0) {
    return phraseClauses.join(',');
  }

  return [...phraseClauses, `and(${tokenClauses.join(',')})`].join(',');
}

function normalizeListOrderDirection(value: string | null): ListOrderDirection {
  if (!value) return 'desc';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'asc' || normalized === 'ascending') return 'asc';
  if (normalized === 'desc' || normalized === 'descending') return 'desc';
  throw errors.badRequest(
    "order_direction must be 'asc' or 'desc' when provided"
  );
}

function normalizeListOrderBy(
  type: EntityType,
  value: string | null
): ListOrderBy {
  if (!value) return 'created_at';

  const normalized = value.trim().toLowerCase();
  if (normalized === 'natural') {
    if (!SEQUENCE_ORDERED_TYPES.has(type)) {
      throw errors.badRequest(`order_by=natural is not supported for ${type}`);
    }
    return 'natural';
  }

  const fieldAliases = ENTITY_FIELD_ALIASES[type] ?? {};
  const column = fieldAliases[normalized] ?? normalized;

  if (!LIST_ORDERABLE_COLUMN_SET.has(column)) {
    throw errors.badRequest(
      `order_by must be one of: ${[...LIST_ORDERABLE_COLUMNS, 'natural'].join(
        ', '
      )}`
    );
  }

  const configColumns = ENTITY_CONFIG[type].select
    .split(',')
    .map((col) => col.trim());
  if (!configColumns.includes(column)) {
    throw errors.badRequest(
      `order_by=${normalized} is not supported for ${type}`
    );
  }

  return column as ListOrderableColumn;
}

// STREAM_AGENT_DOMAINS and normalizeStreamAgentDomain imported from @/lib/entities/streamDomains

// -----------------------------------------------------------------------------
// Generic field normalization
//
// MCP and other clients often send generic fields like `title`, `name`,
// `summary`, and `description`. Not every table supports all of these.
// To prevent PostgREST schema-cache errors (PGRST204), we map aliases to the
// actual columns per entity type and drop unused aliases.
// -----------------------------------------------------------------------------

const ENTITY_LABEL_COLUMN: Record<
  EntityType,
  'title' | 'name' | 'display_name' | 'legal_name' | 'role_title'
> = {
  project: 'name',
  initiative: 'title',
  milestone: 'title',
  workstream: 'name',
  stream: 'name',
  task: 'title',
  objective: 'title',
  playbook: 'title',
  decision: 'title',
  artifact: 'name',
  run: 'title',
  blocker: 'title',
  workflow: 'name',
  skill: 'name',
  plan_session: 'title',
  workspace: 'name',
  studio_brand: 'name',
  studio_content: 'title',
  prospect: 'name',
  opportunity: 'name',
  bug_report: 'title',
  launch_checkpoint: 'name',
  person: 'display_name',
  business: 'legal_name',
  goal: 'title',
  relationship: 'role_title',
};

const ENTITY_BODY_COLUMN: Record<EntityType, 'summary' | 'description'> = {
  project: 'description',
  initiative: 'summary',
  milestone: 'description',
  workstream: 'summary',
  stream: 'description',
  task: 'description',
  objective: 'description',
  playbook: 'description',
  decision: 'summary',
  artifact: 'description',
  run: 'summary',
  blocker: 'description',
  workflow: 'description',
  skill: 'description',
  plan_session: 'description',
  workspace: 'description',
  studio_brand: 'description',
  studio_content: 'description',
  prospect: 'description',
  opportunity: 'description',
  bug_report: 'description',
  launch_checkpoint: 'description',
  person: 'description',
  business: 'description',
  goal: 'description',
  relationship: 'description',
};

function normalizeEntityCreatePayload(
  type: EntityType,
  ownerId: string | null,
  entityData: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (ownerId) {
    if (type === 'run') {
      // agent_runs are scoped by requester_id (not owner_id)
      payload.requester_id = ownerId;
    } else if (type !== 'stream' && type !== 'blocker') {
      // Most user-scoped tables use owner_id.
      // agent_run_blockers are scoped via their parent run, so don't set owner_id.
      payload.owner_id = ownerId;
    }
  }
  const consumed = new Set<string>();

  const labelColumn = ENTITY_LABEL_COLUMN[type];
  const bodyColumn = ENTITY_BODY_COLUMN[type];

  // Map label aliases
  if (labelColumn === 'title') {
    const title = entityData.title ?? entityData.name;
    if (title !== undefined) payload.title = title;
    consumed.add('title');
    consumed.add('name');
  } else {
    const name = entityData.name ?? entityData.title;
    if (name !== undefined) payload.name = name;
    consumed.add('name');
    consumed.add('title');
  }

  // Map body aliases
  if (bodyColumn === 'summary') {
    const summary = entityData.summary ?? entityData.description;
    if (summary !== undefined) payload.summary = summary;
    consumed.add('summary');
    consumed.add('description');
  } else {
    const description = entityData.description ?? entityData.summary;
    if (description !== undefined) payload.description = description;
    consumed.add('description');
    consumed.add('summary');
  }

  // Preserve initiative.description if provided (DB supports both summary + description).
  if (type === 'initiative' && entityData.description !== undefined) {
    payload.description = entityData.description;
  }

  // Copy through remaining fields, excluding consumed aliases
  for (const [key, value] of Object.entries(entityData)) {
    if (consumed.has(key)) continue;
    payload[key] = value;
  }

  if (type === 'decision' && payload.status !== undefined) {
    payload.status = normalizeDecisionStatus(payload.status) ?? payload.status;
  }

  return payload;
}

function coerceOptionalId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveWorkspaceIdAlias(params: {
  workspaceId?: unknown;
  sourceLabel: string;
}): string | null {
  return coerceOptionalId(params.workspaceId) ?? null;
}

function attachWorkspaceAlias<T>(row: T): T {
  return row;
}

function attachEntityLabelAliases<T extends Record<string, unknown>>(
  type: EntityType,
  row: T
): T {
  const labelColumn = ENTITY_LABEL_COLUMN[type];
  const record = row as Record<string, unknown>;

  // Relationship-spine label columns (display_name / legal_name / role_title)
  // are neither 'name' nor 'title'. Mirror the real label column into BOTH
  // aliases so generic consumers (Mission Control, MCP, graph) that read
  // `.name` / `.title` still get a label for these entities.
  if (labelColumn !== 'name' && labelColumn !== 'title') {
    const label =
      typeof record[labelColumn] === 'string' &&
      (record[labelColumn] as string).trim().length > 0
        ? (record[labelColumn] as string).trim()
        : null;
    if (label) {
      if (typeof record.name !== 'string' || record.name.trim().length === 0) {
        record.name = label;
      }
      if (
        typeof record.title !== 'string' ||
        record.title.trim().length === 0
      ) {
        record.title = label;
      }
    }
    return row;
  }

  if (labelColumn === 'name') {
    const name =
      typeof record.name === 'string' && record.name.trim().length > 0
        ? record.name.trim()
        : null;
    if (
      name &&
      (typeof record.title !== 'string' || record.title.trim().length === 0)
    ) {
      record.title = name;
    }
  } else {
    const title =
      typeof record.title === 'string' && record.title.trim().length > 0
        ? record.title.trim()
        : null;
    if (
      title &&
      (typeof record.name !== 'string' || record.name.trim().length === 0)
    ) {
      record.name = title;
    }
  }

  return row;
}

function attachResponseAliases<T>(type: EntityType, row: T): T {
  const withWorkspaceAlias = attachWorkspaceAlias(row);
  if (
    !withWorkspaceAlias ||
    typeof withWorkspaceAlias !== 'object' ||
    Array.isArray(withWorkspaceAlias)
  ) {
    return withWorkspaceAlias;
  }
  const record = attachEntityLabelAliases(
    type,
    withWorkspaceAlias as Record<string, unknown>
  ) as Record<string, unknown>;
  if (HIERARCHY_ENTITY_TYPES.has(type)) {
    const metadata = isObjectRecord(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : null;
    if (
      (typeof record.domain !== 'string' ||
        record.domain.trim().length === 0) &&
      metadata &&
      typeof metadata.domain === 'string' &&
      metadata.domain.trim().length > 0
    ) {
      record.domain = metadata.domain.trim();
    }
  }
  return record as T;
}

function attachResponseAliasesToRows<T>(type: EntityType, rows: T[]): T[] {
  return rows.map((row) => attachResponseAliases(type, row));
}

function normalizeHierarchyDedupeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : null;
}

type HierarchyDedupeType = 'workstream' | 'milestone' | 'task';

const HIERARCHY_CREATE_DEDUPE: Record<
  HierarchyDedupeType,
  { table: string; labelColumn: 'name' | 'title'; scopeColumn: string }
> = {
  workstream: {
    table: 'workstreams',
    labelColumn: 'name',
    scopeColumn: 'initiative_id',
  },
  milestone: {
    table: 'milestones',
    labelColumn: 'title',
    scopeColumn: 'workstream_id',
  },
  task: {
    table: 'workstream_tasks',
    labelColumn: 'title',
    scopeColumn: 'milestone_id',
  },
};

function isHierarchyDedupeType(type: EntityType): type is HierarchyDedupeType {
  return type === 'workstream' || type === 'milestone' || type === 'task';
}

async function findExistingHierarchyCreateTarget(params: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  type: EntityType;
  payload: Record<string, unknown>;
}): Promise<{ row: Record<string, unknown>; label: string } | null> {
  const { type, payload } = params;
  if (!isHierarchyDedupeType(type)) return null;

  const config = HIERARCHY_CREATE_DEDUPE[type];
  const scopeValue = payload[config.scopeColumn];
  if (typeof scopeValue !== 'string' || scopeValue.trim().length === 0) {
    return null;
  }

  const label = normalizeHierarchyDedupeLabel(
    payload[config.labelColumn] ??
      (config.labelColumn === 'name' ? payload.title : payload.name)
  );
  if (!label) return null;

  let query = params.admin
    .from(config.table)
    .select('*')
    .eq(config.scopeColumn, scopeValue)
    .ilike(config.labelColumn, label) as any;

  // Existing duplicate sets used to make maybeSingle() fail with
  // "multiple rows returned", which made retries insert yet another sibling.
  // Pick a stable canonical row instead so agents self-heal on the next create.
  if (typeof query.order === 'function') {
    query = query.order('created_at', { ascending: true });
  }
  if (typeof query.limit === 'function') {
    query = query.limit(1);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    logger.warn('[api:entities] hierarchy create dedupe lookup failed', {
      type,
      label,
      scopeColumn: config.scopeColumn,
      error: error.message,
    });
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  return { row: data as Record<string, unknown>, label };
}

function buildHierarchyDedupResponse(params: {
  type: EntityType;
  row: Record<string, unknown>;
  label: string;
}) {
  const data = attachResponseAliases(params.type, { ...params.row });
  return NextResponse.json(
    {
      ...(isObjectRecord(data) ? data : {}),
      type: params.type,
      data,
      _dedup: true,
      _message: `${params.type} "${params.label}" already exists in this parent scope.`,
    },
    { status: 200 }
  );
}

function cleanScaffoldIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : null;
}

async function findExistingInitiativeByIdempotency(params: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const idempotencyKey = cleanScaffoldIdempotencyKey(
    params.payload.idempotency_key
  );
  if (!idempotencyKey) return null;

  const selectWithGraph =
    '*, workstreams(*, milestones(*), workstream_tasks(*)), milestones(*, workstream_tasks(*))';

  const buildQuery = (select: string) => {
    let query = params.admin
      .from('initiatives')
      .select(select)
      .eq('idempotency_key', idempotencyKey) as any;

    const ownerId = coerceOptionalId(params.payload.owner_id);
    if (ownerId) query = query.eq('owner_id', ownerId);

    const workspaceId = coerceOptionalId(params.payload.workspace_id);
    if (workspaceId) query = query.eq('workspace_id', workspaceId);

    if (typeof query.order === 'function') {
      query = query.order('created_at', { ascending: true });
    }
    if (typeof query.limit === 'function') {
      query = query.limit(1);
    }
    return query;
  };

  let result = await buildQuery(selectWithGraph).maybeSingle();
  if (result.error) {
    logger.warn('[api:entities] initiative idempotency graph lookup failed', {
      idempotencyKey,
      error: result.error.message,
    });
    result = await buildQuery('*').maybeSingle();
  }

  if (result.error) {
    logger.warn('[api:entities] initiative idempotency lookup failed', {
      idempotencyKey,
      error: result.error.message,
    });
    return null;
  }

  if (
    !result.data ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data)
  ) {
    return null;
  }

  return result.data as Record<string, unknown>;
}

function buildInitiativeIdempotencyReplayResponse(params: {
  row: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const data = attachResponseAliases('initiative', { ...params.row });
  return NextResponse.json(
    {
      ...(isObjectRecord(data) ? data : {}),
      type: 'initiative',
      data,
      _dedup: true,
      _replayed: true,
      idempotency_key: params.idempotencyKey,
      _message: 'initiative already exists for this idempotency_key.',
    },
    { status: 200 }
  );
}

function maybeBuildSyntheticReferenceNoop(params: {
  request: Request;
  type: string;
  operation: 'create' | 'update';
  syntheticRef: { field: string; value: string } | null;
}): NextResponse | null {
  const { request, type, operation, syntheticRef } = params;
  if (!syntheticRef) return null;
  if (!isClawdbotPluginUserAgent(request.headers.get('user-agent'))) {
    return null;
  }

  logger.warn('[api:entities] ignored synthetic reference id from plugin', {
    type,
    operation,
    field: syntheticRef.field,
    value: syntheticRef.value,
  });

  return NextResponse.json(
    {
      ok: false,
      skipped: true,
      reason: 'synthetic_reference_not_supported',
      type,
      operation,
      synthetic_reference: syntheticRef,
      hint: 'Use persisted OrgX UUIDs from orgx_list_entities before write operations.',
    },
    { status: 202 }
  );
}

// -----------------------------------------------------------------------------
// Metadata shadow fields
//
// Mission Control and other clients send a few cross-entity fields that are
// stored in `metadata` rather than as dedicated columns on every table.
// PostgREST rejects unknown columns (PGRST204), so we proactively move these
// values into `metadata` and (on PATCH) merge with existing metadata.
// -----------------------------------------------------------------------------

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeSequenceValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function toStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const items = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return items.length > 0 ? items : [];
  }
  if (typeof value === 'string') {
    const items = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return items.length > 0 ? items : [];
  }
  return null;
}

const ASSIGNMENT_DOMAIN_ALIASES: Record<string, string> = {
  eng: 'engineering',
  engineering: 'engineering',
  product: 'product',
  prod: 'product',
  design: 'design',
  ux: 'design',
  ui: 'design',
  marketing: 'marketing',
  growth: 'marketing',
  gtm: 'marketing',
  mark: 'marketing',
  sales: 'sales',
  revenue: 'sales',
  ops: 'operations',
  operation: 'operations',
  operations: 'operations',
  orchestrator: 'orchestrator',
  orchestration: 'orchestrator',
};

const ASSIGNMENT_DOMAIN_TO_AGENT_ID: Record<string, string> = {
  product: 'product-agent',
  engineering: 'engineering-agent',
  marketing: 'marketing-agent',
  sales: 'sales-agent',
  operations: 'operations-agent',
  design: 'design-agent',
  orchestrator: 'orchestrator-agent',
};

type AssignmentHints = {
  agentIds: string[];
  agentNames: string[];
  domain: string | null;
};

function dedupeNonEmptyStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeAssignmentDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) return null;
  const direct = ASSIGNMENT_DOMAIN_ALIASES[normalized];
  if (direct) return direct;

  if (normalized.includes('product')) return 'product';
  if (normalized.includes('engineer') || normalized === 'eng')
    return 'engineering';
  if (
    normalized.includes('design') ||
    normalized.includes('ux') ||
    normalized.includes('ui')
  ) {
    return 'design';
  }
  if (
    normalized.includes('market') ||
    normalized.includes('growth') ||
    normalized.includes('gtm')
  ) {
    return 'marketing';
  }
  if (normalized.includes('sales') || normalized.includes('revenue')) {
    return 'sales';
  }
  if (normalized.includes('ops') || normalized.includes('operation')) {
    return 'operations';
  }
  if (normalized.includes('orchestr')) return 'orchestrator';
  return null;
}

function inferDomainFromAgentId(
  agentId: string | null | undefined
): string | null {
  if (typeof agentId !== 'string') return null;
  const normalized = agentId.trim().toLowerCase();
  if (!normalized) return null;
  for (const [domain, mappedAgentId] of Object.entries(
    ASSIGNMENT_DOMAIN_TO_AGENT_ID
  )) {
    if (mappedAgentId === normalized) return domain;
  }
  if (normalized.endsWith('-agent')) {
    return normalizeAssignmentDomain(
      normalized.slice(0, normalized.length - '-agent'.length)
    );
  }
  return null;
}

function humanizeAgentId(agentId: string): string {
  return agentId
    .replace(/-agent$/i, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractAssignmentHints(
  record: Record<string, unknown>
): AssignmentHints {
  const metadata = isObjectRecord(record.metadata)
    ? (record.metadata as Record<string, unknown>)
    : {};

  const ids = dedupeNonEmptyStrings([
    ...(toStringArray(record.assigned_agent_ids) ?? []),
    ...(toStringArray(record.assignedAgentIds) ?? []),
    ...(toStringArray(metadata.assigned_agent_ids) ?? []),
    ...(toStringArray(metadata.assignedAgentIds) ?? []),
    typeof record.ownerAgent === 'string' ? record.ownerAgent : '',
    typeof record.primaryAgent === 'string' ? record.primaryAgent : '',
    typeof record.agent_id === 'string' ? record.agent_id : '',
    typeof metadata.ownerAgent === 'string' ? metadata.ownerAgent : '',
    typeof metadata.primaryAgent === 'string' ? metadata.primaryAgent : '',
    typeof metadata.agent_id === 'string' ? metadata.agent_id : '',
  ]);
  const names = dedupeNonEmptyStrings([
    ...(toStringArray(record.assigned_agent_names) ?? []),
    ...(toStringArray(record.assignedAgentNames) ?? []),
    ...(toStringArray(metadata.assigned_agent_names) ?? []),
    ...(toStringArray(metadata.assignedAgentNames) ?? []),
    typeof record.ownerName === 'string' ? record.ownerName : '',
    typeof record.agent_name === 'string' ? record.agent_name : '',
    typeof metadata.ownerName === 'string' ? metadata.ownerName : '',
    typeof metadata.agent_name === 'string' ? metadata.agent_name : '',
  ]);

  const domain =
    normalizeAssignmentDomain(record.agent_domain) ??
    normalizeAssignmentDomain(record.agentDomain) ??
    normalizeAssignmentDomain(record.domain) ??
    normalizeAssignmentDomain(record.persona) ??
    normalizeAssignmentDomain(metadata.agent_domain) ??
    normalizeAssignmentDomain(metadata.agentDomain) ??
    normalizeAssignmentDomain(metadata.domain) ??
    normalizeAssignmentDomain(metadata.persona) ??
    inferDomainFromAgentId(ids[0] ?? null);

  return { agentIds: ids, agentNames: names, domain };
}

function applyAssignmentDefaultsToPayload(params: {
  payload: Record<string, unknown>;
  type: 'workstream' | 'milestone' | 'task';
  sourceHints?: AssignmentHints[];
  fallbackDomainCandidates?: unknown[];
  disableTypeDefault?: boolean;
}) {
  const metadata = isObjectRecord(params.payload.metadata)
    ? { ...(params.payload.metadata as Record<string, unknown>) }
    : {};
  const payloadHints = extractAssignmentHints({
    ...params.payload,
    metadata,
  });
  const sources = params.sourceHints ?? [];

  const mergedAgentIds = dedupeNonEmptyStrings([
    ...payloadHints.agentIds,
    ...sources.flatMap((hint) => hint.agentIds),
  ]);
  const mergedAgentNames = dedupeNonEmptyStrings([
    ...payloadHints.agentNames,
    ...sources.flatMap((hint) => hint.agentNames),
  ]);

  let domain: string | null =
    payloadHints.domain ??
    (() => {
      for (const candidate of params.fallbackDomainCandidates ?? []) {
        const normalized = normalizeAssignmentDomain(candidate);
        if (normalized) return normalized;
      }
      return null;
    })() ??
    sources
      .map((hint) => hint.domain)
      .find((hint): hint is string => Boolean(hint)) ??
    inferDomainFromAgentId(mergedAgentIds[0] ?? null);

  if (!domain && params.type === 'workstream' && !params.disableTypeDefault) {
    domain = 'operations';
  }

  if (mergedAgentIds.length === 0 && domain) {
    const fallbackAgentId = ASSIGNMENT_DOMAIN_TO_AGENT_ID[domain];
    if (fallbackAgentId) {
      mergedAgentIds.push(fallbackAgentId);
    }
  }

  if (mergedAgentNames.length === 0 && mergedAgentIds.length > 0) {
    mergedAgentNames.push(humanizeAgentId(mergedAgentIds[0]!));
  }

  if (mergedAgentIds.length > 0) {
    metadata.assigned_agent_ids = mergedAgentIds;
    metadata.assigned_agent_names = mergedAgentNames;
  }
  if (domain) {
    metadata.agent_domain = domain;
    if (
      typeof metadata.domain !== 'string' ||
      metadata.domain.trim().length === 0
    ) {
      metadata.domain = domain;
    }
  }

  params.payload.metadata = metadata;

  if (
    params.type === 'workstream' &&
    domain &&
    (typeof params.payload.persona !== 'string' ||
      params.payload.persona.trim().length === 0)
  ) {
    params.payload.persona = domain;
  }
}

type IwmtAssignmentContext = {
  initiative?: Record<string, unknown> | null;
  workstream?: Record<string, unknown> | null;
  milestone?: Record<string, unknown> | null;
  task?: Record<string, unknown> | null;
};

function hasAssignedAgentOnPayload(payload: Record<string, unknown>): boolean {
  const metadata = isObjectRecord(payload.metadata)
    ? (payload.metadata as Record<string, unknown>)
    : {};
  return extractAssignmentHints({ ...payload, metadata }).agentIds.length > 0;
}

function pickFirstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function pickEntityString(
  entity: Record<string, unknown> | null | undefined,
  keys: string[]
): string | null {
  if (!isObjectRecord(entity)) return null;
  for (const key of keys) {
    const value = entity[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function buildEntityNarrative(
  label: string,
  entity: Record<string, unknown> | null | undefined
): string | null {
  if (!isObjectRecord(entity)) return null;
  const title = pickEntityString(entity, ['title', 'name']);
  const summary = pickEntityString(entity, ['summary', 'description']);
  const domain = pickEntityString(entity, [
    'domain',
    'persona',
    'agent_domain',
  ]);

  const parts: string[] = [];
  if (title) parts.push(title);
  if (summary) parts.push(summary);
  if (domain) parts.push(`domain=${domain}`);
  if (parts.length === 0) return null;
  return `${label}: ${parts.join(' | ')}`;
}

function buildDraftEntityContext(
  payload: Record<string, unknown>,
  entityData: Record<string, unknown>
): Record<string, unknown> {
  return {
    id:
      typeof payload.id === 'string'
        ? payload.id
        : typeof entityData.id === 'string'
        ? entityData.id
        : null,
    name:
      typeof payload.name === 'string'
        ? payload.name
        : typeof entityData.name === 'string'
        ? entityData.name
        : null,
    title:
      typeof payload.title === 'string'
        ? payload.title
        : typeof entityData.title === 'string'
        ? entityData.title
        : null,
    summary:
      typeof payload.summary === 'string'
        ? payload.summary
        : typeof entityData.summary === 'string'
        ? entityData.summary
        : null,
    description:
      typeof payload.description === 'string'
        ? payload.description
        : typeof entityData.description === 'string'
        ? entityData.description
        : null,
    domain:
      typeof payload.domain === 'string'
        ? payload.domain
        : typeof entityData.domain === 'string'
        ? entityData.domain
        : null,
    persona:
      typeof payload.persona === 'string'
        ? payload.persona
        : typeof entityData.persona === 'string'
        ? entityData.persona
        : null,
    metadata: isObjectRecord(payload.metadata)
      ? payload.metadata
      : isObjectRecord(entityData.metadata)
      ? entityData.metadata
      : null,
  };
}

async function applyIwmtAssignmentFallback(params: {
  payload: Record<string, unknown>;
  type: 'workstream' | 'milestone' | 'task';
  userId?: string | null;
  context?: IwmtAssignmentContext;
  sourceHints?: AssignmentHints[];
  fallbackDomainCandidates?: unknown[];
}) {
  if (hasAssignedAgentOnPayload(params.payload)) return;

  const context = params.context ?? {};
  const metadata = isObjectRecord(params.payload.metadata)
    ? { ...(params.payload.metadata as Record<string, unknown>) }
    : {};

  const contextEntities = [
    context.initiative,
    context.workstream,
    context.milestone,
    context.task,
  ].filter((entity): entity is Record<string, unknown> =>
    isObjectRecord(entity)
  );

  const payloadHints = extractAssignmentHints({
    ...params.payload,
    metadata,
  });
  const sourceHints = params.sourceHints ?? [];
  const contextHints = contextEntities.map((entity) =>
    extractAssignmentHints(entity)
  );
  const allHints = [payloadHints, ...sourceHints, ...contextHints];

  const agentHint =
    dedupeNonEmptyStrings(allHints.flatMap((hint) => hint.agentIds))[0] ?? null;

  let domainHint: string | null =
    allHints
      .map((hint) => hint.domain)
      .find((candidate): candidate is string => Boolean(candidate)) ?? null;

  if (!domainHint) {
    for (const candidate of params.fallbackDomainCandidates ?? []) {
      const normalized = normalizeAssignmentDomain(candidate);
      if (normalized) {
        domainHint = normalized;
        break;
      }
    }
  }

  const dependsOn = dedupeNonEmptyStrings([
    ...(toStringArray(metadata.depends_on) ?? []),
    ...contextEntities.flatMap(
      (entity) =>
        toStringArray(
          isObjectRecord(entity.metadata)
            ? (entity.metadata as Record<string, unknown>).depends_on
            : undefined
        ) ?? []
    ),
  ]).slice(0, 20);

  const deliverables = dedupeNonEmptyStrings([
    ...(toStringArray(metadata.deliverables) ?? []),
    ...contextEntities.flatMap(
      (entity) =>
        toStringArray(
          isObjectRecord(entity.metadata)
            ? (entity.metadata as Record<string, unknown>).deliverables
            : undefined
        ) ?? []
    ),
  ]).slice(0, 20);

  const name =
    pickFirstString([
      params.payload.name,
      params.payload.title,
      pickEntityString(context.workstream, ['name', 'title']),
      pickEntityString(context.milestone, ['title', 'name']),
      pickEntityString(context.task, ['title', 'name']),
    ]) ?? `${params.type} assignment`;

  const narrative = [
    buildEntityNarrative('Initiative', context.initiative),
    buildEntityNarrative('Workstream', context.workstream),
    buildEntityNarrative('Milestone', context.milestone),
    buildEntityNarrative('Task', context.task),
  ].filter((entry): entry is string => typeof entry === 'string');

  const goal = narrative.length > 0 ? narrative.join('\n') : name;

  try {
    const intelligence = await inferWorkstreamsIntelligence({
      workstreams: [
        {
          id: `iwmt-${params.type}-assignment`,
          name,
          goal,
          domainHint,
          personaHint: pickEntityString(context.workstream, ['persona']),
          agentHint,
          dependsOn,
          deliverables,
        },
      ],
      userId: params.userId ?? null,
      purpose: `IWMT assignment fallback for ${params.type} creation`,
      model: process.env.ASSIGNMENT_FALLBACK_MODEL ?? ModelDefaults.fast,
    });

    const resolved = intelligence.results[0];
    if (!resolved?.agent_id) return;

    const resolvedDomain =
      normalizeAssignmentDomain(resolved.domain) ?? 'operations';
    const mergedAgentIds = dedupeNonEmptyStrings([
      ...(toStringArray(metadata.assigned_agent_ids) ?? []),
      resolved.agent_id,
    ]);
    const mergedAgentNames = dedupeNonEmptyStrings([
      ...(toStringArray(metadata.assigned_agent_names) ?? []),
      resolved.agent_name,
    ]);

    if (mergedAgentIds.length > 0) {
      metadata.assigned_agent_ids = mergedAgentIds;
      metadata.assigned_agent_names =
        mergedAgentNames.length > 0
          ? mergedAgentNames
          : [humanizeAgentId(mergedAgentIds[0]!)];
    }

    metadata.agent_domain = resolvedDomain;
    if (
      typeof metadata.domain !== 'string' ||
      metadata.domain.trim().length === 0
    ) {
      metadata.domain = resolvedDomain;
    }
    metadata.assignment_source =
      intelligence.source === 'model' ? 'iwmt_small_model' : 'iwmt_baseline';
    metadata.assignment_confidence = resolved.confidence;
    metadata.assignment_rationale = resolved.rationale;

    params.payload.metadata = metadata;

    if (
      params.type === 'workstream' &&
      (typeof params.payload.persona !== 'string' ||
        params.payload.persona.trim().length === 0)
    ) {
      params.payload.persona = resolvedDomain;
    }
  } catch (error) {
    logger.warn('[api:entities] IWMT assignment fallback failed', {
      type: params.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function extractMetadataShadowFields(
  type: EntityType,
  data: Record<string, unknown>
): Record<string, unknown> {
  if (!HIERARCHY_ENTITY_TYPES.has(type as EntityType)) {
    return {};
  }

  const metaPatch: Record<string, unknown> = {};

  const take = (
    metaKey: string,
    keys: string[],
    transform?: (value: unknown) => unknown
  ) => {
    for (const key of keys) {
      if (!(key in data)) continue;
      const raw = data[key];
      delete data[key];
      const next = transform ? transform(raw) : raw;
      if (next !== null && next !== undefined) {
        metaPatch[metaKey] = next;
      }
      break;
    }
  };

  take(
    'expected_duration_minutes',
    [
      'expected_duration_minutes',
      'expectedDurationMinutes',
      'duration_minutes',
      'durationMinutes',
    ],
    toFiniteNumber
  );
  take(
    'expected_duration_hours',
    [
      'expected_duration_hours',
      'expectedDurationHours',
      'duration_hours',
      'durationHours',
    ],
    toFiniteNumber
  );
  take(
    'expected_tokens',
    [
      'expected_tokens',
      'expectedTokens',
      'token_budget',
      'tokenBudget',
      'tokens',
    ],
    toFiniteNumber
  );
  take(
    'expected_budget_usd',
    ['expected_budget_usd', 'expectedBudgetUsd', 'budget_usd', 'budgetUsd'],
    toFiniteNumber
  );
  take(
    'priority_num',
    ['priority_num', 'priorityNum', 'priority_number'],
    toFiniteNumber
  );

  take('eta_end_at', ['eta_end_at', 'etaEndAt'], (value) =>
    typeof value === 'string' && value.trim().length > 0 ? value : null
  );
  take('ref', ['ref', 'source_ref', 'sourceRef'], (value) =>
    typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).$ref === 'string' &&
        String((value as Record<string, unknown>).$ref).trim().length > 0
      ? String((value as Record<string, unknown>).$ref).trim()
      : null
  );
  take('domain', ['domain'], (value) =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  );

  take(
    'depends_on',
    [
      'depends_on',
      'dependsOn',
      'dependency_ids',
      'dependencyIds',
      'dependencies',
    ],
    toStringArray
  );
  take(
    'assigned_agent_ids',
    ['assigned_agent_ids', 'assignedAgentIds'],
    toStringArray
  );
  take(
    'assigned_agent_names',
    ['assigned_agent_names', 'assignedAgentNames'],
    toStringArray
  );
  if (type === 'task') {
    take(
      'task_type',
      ['task_type', 'taskType', 'work_type', 'workType'],
      (value) => {
        if (typeof value !== 'string') return null;
        const normalized = value.trim().toLowerCase();
        return TASK_EXECUTION_TYPES.has(normalized) ? normalized : null;
      }
    );
  }

  return metaPatch;
}

const ECONOMICS_COLUMN_ALIASES = {
  estimated_hours: ['estimated_hours', 'estimatedHours'],
  estimated_spend_usd: ['estimated_spend_usd', 'estimatedSpendUsd'],
  estimated_roi_usd: ['estimated_roi_usd', 'estimatedRoiUsd'],
  actual_hours: ['actual_hours', 'actualHours'],
  actual_spend_usd: ['actual_spend_usd', 'actualSpendUsd'],
  daily_limit_usd: ['daily_limit_usd', 'dailyLimitUsd'],
  hourly_limit_usd: ['hourly_limit_usd', 'hourlyLimitUsd'],
  priority_rank: ['priority_rank', 'priorityRank'],
} as const;

function normalizeEconomicsColumnInputs(
  type: EntityType,
  data: Record<string, unknown>
) {
  if (!HIERARCHY_ENTITY_TYPES.has(type)) return;

  for (const [column, aliases] of Object.entries(ECONOMICS_COLUMN_ALIASES)) {
    let found = false;
    let rawValue: unknown;

    for (const alias of aliases) {
      if (!(alias in data)) continue;
      if (!found) {
        found = true;
        rawValue = data[alias];
      }
      if (alias !== column) {
        delete data[alias];
      }
    }

    if (!found) continue;
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      data[column] = null;
      continue;
    }

    const normalized = toFiniteNumber(rawValue);
    if (normalized === null) {
      throw errors.badRequest(
        `Invalid ${column}: expected a finite numeric value`
      );
    }

    data[column] =
      column === 'priority_rank'
        ? Math.max(1, Math.round(normalized))
        : normalized;
  }
}

function normalizeEntityUpdatePayload(
  type: EntityType,
  updateData: Record<string, unknown>
): Record<string, unknown> {
  if (type === 'plan_session') {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    const consumed = new Set<string>();

    const title = updateData.title ?? updateData.name;
    if (title !== undefined && title !== null) payload.title = title;
    consumed.add('title');
    consumed.add('name');

    const currentPlan =
      updateData.current_plan ?? updateData.description ?? updateData.summary;
    if (currentPlan !== undefined && currentPlan !== null)
      payload.current_plan = currentPlan;
    consumed.add('current_plan');
    consumed.add('description');
    consumed.add('summary');

    for (const [key, value] of Object.entries(updateData)) {
      if (consumed.has(key)) continue;
      if (value !== undefined && value !== null) {
        payload[key] = value;
      }
    }

    return payload;
  }

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  const consumed = new Set<string>();

  const labelColumn = ENTITY_LABEL_COLUMN[type];
  const bodyColumn = ENTITY_BODY_COLUMN[type];

  // Map label aliases
  if (labelColumn === 'title') {
    const title = updateData.title ?? updateData.name;
    if (title !== undefined && title !== null) payload.title = title;
    consumed.add('title');
    consumed.add('name');
  } else if (labelColumn === 'name') {
    const name = updateData.name ?? updateData.title;
    if (name !== undefined && name !== null) payload.name = name;
    consumed.add('name');
    consumed.add('title');
  } else {
    // Relationship-spine label columns (display_name / legal_name / role_title):
    // write the real column from any of the generic label aliases.
    const label =
      updateData[labelColumn] ?? updateData.title ?? updateData.name;
    if (label !== undefined && label !== null) payload[labelColumn] = label;
    consumed.add(labelColumn);
    consumed.add('name');
    consumed.add('title');
  }

  // Map body aliases. `goal` stores its body in `description_markdown`, not the
  // generic `description`; the relationship-spine body column is `description`
  // for person/business but those updates are typically delegated. Keep the
  // standard summary/description mapping; goal-specific column handled below.
  if (bodyColumn === 'summary') {
    const summary = updateData.summary ?? updateData.description;
    if (summary !== undefined && summary !== null) payload.summary = summary;
    consumed.add('summary');
    consumed.add('description');
  } else {
    const description = updateData.description ?? updateData.summary;
    if (description !== undefined && description !== null)
      payload.description = description;
    consumed.add('description');
    consumed.add('summary');
  }

  if (
    type === 'initiative' &&
    updateData.description !== undefined &&
    updateData.description !== null
  ) {
    payload.description = updateData.description;
  }

  // Copy through remaining fields, excluding consumed aliases and null/undefined.
  // Hierarchy economics are owner-editable and may be cleared intentionally.
  for (const [key, value] of Object.entries(updateData)) {
    if (consumed.has(key)) continue;
    const allowsNull =
      HIERARCHY_ENTITY_TYPES.has(type) && key in ECONOMICS_COLUMN_ALIASES;
    if (value !== undefined && (value !== null || allowsNull)) {
      payload[key] = value;
    }
  }

  return payload;
}

function isSchemaCacheRelationshipError(
  error: { code?: string; message?: string } | null | undefined
) {
  if (!error) return false;
  return (
    error.code === 'PGRST204' ||
    error.message?.toLowerCase().includes('schema cache')
  );
}

function isMissingColumnError(
  error: { code?: string; message?: string } | null | undefined
) {
  if (!error) return false;
  // PostgREST schema cache error for unknown columns.
  if (error.code === 'PGRST204') return true;
  // Postgres "undefined_column" (can surface depending on API path).
  if (error.code === '42703') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  const msg = message.toLowerCase();
  return (
    (msg.includes('column') && msg.includes('does not exist')) ||
    (msg.includes('could not find the') && msg.includes('column')) ||
    (msg.includes('column') && msg.includes('schema cache'))
  );
}

function extractMissingColumnName(message: string | undefined | null): string {
  if (!message) return '';
  // Example: "Could not find the 'context' column of 'initiatives' in the schema cache"
  const match = message.match(/Could not find the '(\w+)' column/i);
  if (match?.[1]) return match[1];

  // Example: "column \"workspace_id\" does not exist"
  const pgMatch = message.match(/column\s+\"?([\w.]+)\"?\s+does not exist/i);
  if (!pgMatch?.[1]) return '';

  const raw = pgMatch[1];
  // Handle qualified names (table.column) by returning the final segment.
  const parts = raw.split('.');
  return parts[parts.length - 1] ?? raw;
}

function pruneSelectColumn(select: string, column: string): string {
  const needle = column.trim();
  if (!needle) return select;
  const parts = select
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const pruned = parts.filter((part) => part !== needle);
  return pruned.join(', ');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

type InitiativeActivationSummary = {
  created_stream_count: number;
  redispatched_stream_count: number;
  error?: string;
};

async function maybeActivateInitiative(params: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  initiativeId: string | null | undefined;
  sourceContext: string;
  statusHint?: unknown;
  titleHint?: unknown;
}): Promise<InitiativeActivationSummary | null> {
  const { admin, sourceContext } = params;
  const initiativeId =
    typeof params.initiativeId === 'string' ? params.initiativeId.trim() : '';
  if (!initiativeId) return null;

  let status =
    typeof params.statusHint === 'string' ? params.statusHint.trim() : null;
  let title =
    typeof params.titleHint === 'string' ? params.titleHint.trim() : null;

  if (!status || !title) {
    const { data: initiativeRow, error: initiativeError } = await admin
      .from('initiatives')
      .select('status, title')
      .eq('id', initiativeId)
      .maybeSingle();

    if (initiativeError) {
      logger.warn(
        '[api:entities] failed to resolve initiative for activation',
        {
          sourceContext,
          initiativeId,
          error: initiativeError.message,
        }
      );
      return null;
    }
    if (!initiativeRow) return null;

    status =
      status ??
      (typeof initiativeRow.status === 'string'
        ? initiativeRow.status.trim()
        : null);
    title =
      title ??
      (typeof initiativeRow.title === 'string'
        ? initiativeRow.title.trim()
        : null);
  }

  if (status !== 'active') return null;

  try {
    const lifecycleResult = await ensureInitiativeActivationDispatch({
      admin: admin as unknown as SupabaseDbClient,
      initiativeId,
      initiativeTitle: title && title.length > 0 ? title : 'Initiative',
      source: 'initiative_status_update',
    });

    return {
      created_stream_count: lifecycleResult.createdStreamCount,
      redispatched_stream_count: lifecycleResult.redispatchedStreamCount,
    };
  } catch (activationError) {
    const activationErrorMessage =
      activationError instanceof Error
        ? activationError.message
        : String(activationError);
    logger.error('[api:entities] initiative activation dispatch failed', {
      sourceContext,
      initiativeId,
      error: activationErrorMessage,
    });
    return {
      created_stream_count: 0,
      redispatched_stream_count: 0,
      error: activationErrorMessage,
    };
  }
}

function collectInitiativeTasks(
  initiative: Record<string, unknown>
): Array<Record<string, unknown>> {
  const dedup = new Map<string, Record<string, unknown>>();

  const milestones = Array.isArray(initiative.milestones)
    ? (initiative.milestones as Array<Record<string, unknown>>)
    : [];
  for (const milestone of milestones) {
    const nestedTasks = Array.isArray(milestone.workstream_tasks)
      ? (milestone.workstream_tasks as Array<Record<string, unknown>>)
      : [];
    for (const task of nestedTasks) {
      const taskId = typeof task.id === 'string' ? task.id : null;
      if (!taskId) continue;
      dedup.set(taskId, task);
    }
  }

  if (dedup.size > 0) {
    return Array.from(dedup.values());
  }

  const workstreams = Array.isArray(initiative.workstreams)
    ? (initiative.workstreams as Array<Record<string, unknown>>)
    : [];
  for (const workstream of workstreams) {
    const nestedTasks = Array.isArray(workstream.workstream_tasks)
      ? (workstream.workstream_tasks as Array<Record<string, unknown>>)
      : [];
    for (const task of nestedTasks) {
      const taskId = typeof task.id === 'string' ? task.id : null;
      if (!taskId) continue;
      dedup.set(taskId, task);
    }
  }

  return Array.from(dedup.values());
}

function attachInitiativeProgressRollup(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((initiative) => {
    const workstreams = Array.isArray(initiative.workstreams)
      ? (initiative.workstreams as Array<Record<string, unknown>>)
      : [];
    const milestones = Array.isArray(initiative.milestones)
      ? (initiative.milestones as Array<Record<string, unknown>>)
      : [];
    const tasks = collectInitiativeTasks(initiative);

    const totalWorkstreams = workstreams.length;
    const completedWorkstreams = workstreams.filter(
      (workstream) => workstream.status === 'completed'
    ).length;

    const totalMilestones = milestones.length;
    const closedMilestones = milestones.filter((milestone) =>
      ['completed', 'cancelled'].includes(String(milestone.status ?? ''))
    ).length;

    const totalTasks = tasks.length;
    const doneTasks = tasks.filter((task) => task.status === 'done').length;

    const derivedProgress =
      totalTasks > 0
        ? Math.round((doneTasks / totalTasks) * 100)
        : totalMilestones > 0
        ? Math.round((closedMilestones / totalMilestones) * 100)
        : totalWorkstreams > 0
        ? Math.round((completedWorkstreams / totalWorkstreams) * 100)
        : 0;

    return {
      ...initiative,
      progress_rollup: {
        progress_pct: derivedProgress,
        total_workstreams: totalWorkstreams,
        completed_workstreams: completedWorkstreams,
        total_milestones: totalMilestones,
        closed_milestones: closedMilestones,
        total_tasks: totalTasks,
        done_tasks: doneTasks,
      },
    };
  });
}

function readEntityReferenceField(
  payload: Record<string, unknown>,
  entityData: Record<string, unknown>,
  fieldName: string
): string | null {
  const readRefLikeString = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const ref = (value as Record<string, unknown>).$ref;
      if (typeof ref === 'string' && ref.trim().length > 0) {
        return ref.trim();
      }
    }
    return null;
  };

  return (
    readRefLikeString(payload[fieldName]) ??
    readRefLikeString(entityData[fieldName])
  );
}

async function resolveCreateParentReference(params: {
  admin: ReturnType<typeof getSupabaseAdmin>;
  payload: Record<string, unknown>;
  entityData: Record<string, unknown>;
  entityType: string;
  fieldName: string;
  ownerId?: string | null;
}): Promise<string | null> {
  const { admin, payload, entityData, entityType, fieldName, ownerId } = params;
  const inputId = readEntityReferenceField(payload, entityData, fieldName);
  if (!inputId) {
    return null;
  }

  const resolved = await resolveEntityIdReference({
    adminClient: admin as unknown as SupabaseDbClient,
    entityType,
    inputId,
    ownerId: ownerId ?? null,
    fieldLabel: fieldName,
  });

  payload[fieldName] = resolved.id;

  if (resolved.resolvedByReference) {
    logger.info('[api:entities] resolved create parent reference', {
      entityType,
      fieldName,
      requestedId: inputId,
      resolvedId: resolved.id,
      resolutionMethod: resolved.resolutionMethod,
    });
  }

  return resolved.id;
}

async function resolveMilestoneHierarchyPayload(params: {
  admin: ReturnType<typeof getSupabaseAdmin>;
  payload: Record<string, unknown>;
  entityData: Record<string, unknown>;
  ownerId?: string | null;
  userId?: string | null;
}) {
  const { admin, payload, entityData, ownerId, userId } = params;

  const workstreamId = await resolveCreateParentReference({
    admin,
    payload,
    entityData,
    entityType: 'workstream',
    fieldName: 'workstream_id',
    ownerId,
  });

  let initiativeId = await resolveCreateParentReference({
    admin,
    payload,
    entityData,
    entityType: 'initiative',
    fieldName: 'initiative_id',
    ownerId,
  });

  let workspaceId =
    typeof payload.workspace_id === 'string'
      ? payload.workspace_id
      : typeof entityData.workspace_id === 'string'
      ? entityData.workspace_id
      : null;

  if (!workstreamId) {
    throw errors.badRequest('Milestone requires workstream_id');
  }

  const { data: workstreamRow, error: workstreamLookupError } = await admin
    .from('workstreams')
    .select(
      'id, initiative_id, workspace_id, name, summary, domain, persona, metadata'
    )
    .eq('id', workstreamId)
    .maybeSingle();

  if (workstreamLookupError) {
    throw errors.internal('Unable to load workstream for milestone creation');
  }
  if (!workstreamRow) {
    throw errors.badRequest('Milestone workstream_id is invalid');
  }

  if (initiativeId && initiativeId !== workstreamRow.initiative_id) {
    throw errors.badRequest(
      'Milestone initiative_id must match workstream initiative_id'
    );
  }

  initiativeId = workstreamRow.initiative_id;
  workspaceId = workspaceId ?? workstreamRow.workspace_id ?? null;
  payload.workstream_id = workstreamRow.id;
  payload.initiative_id = initiativeId;

  if (!payload.workspace_id && workspaceId) {
    payload.workspace_id = workspaceId;
  }

  const workstreamHints = extractAssignmentHints(
    workstreamRow as unknown as Record<string, unknown>
  );
  applyAssignmentDefaultsToPayload({
    payload,
    type: 'milestone',
    sourceHints: [workstreamHints],
    fallbackDomainCandidates: [
      (workstreamRow as Record<string, unknown>).domain,
      (workstreamRow as Record<string, unknown>).persona,
    ],
  });

  const { data: initiativeRow } = await admin
    .from('initiatives')
    .select('id, title, summary, metadata')
    .eq('id', initiativeId)
    .maybeSingle();

  await applyIwmtAssignmentFallback({
    payload,
    type: 'milestone',
    userId,
    sourceHints: [workstreamHints],
    fallbackDomainCandidates: [
      (workstreamRow as Record<string, unknown>).domain,
      (workstreamRow as Record<string, unknown>).persona,
    ],
    context: {
      initiative: (initiativeRow as Record<string, unknown> | null) ?? null,
      workstream: workstreamRow as unknown as Record<string, unknown>,
      milestone: buildDraftEntityContext(payload, entityData),
    },
  });
}

async function resolveTaskHierarchyPayload(params: {
  admin: ReturnType<typeof getSupabaseAdmin>;
  payload: Record<string, unknown>;
  entityData: Record<string, unknown>;
  ownerId: string;
  userId?: string | null;
}) {
  const { admin, payload, entityData, ownerId, userId } = params;
  const milestoneId = await resolveCreateParentReference({
    admin,
    payload,
    entityData,
    entityType: 'milestone',
    fieldName: 'milestone_id',
    ownerId,
  });

  let initiativeId = await resolveCreateParentReference({
    admin,
    payload,
    entityData,
    entityType: 'initiative',
    fieldName: 'initiative_id',
    ownerId,
  });
  let workstreamId = await resolveCreateParentReference({
    admin,
    payload,
    entityData,
    entityType: 'workstream',
    fieldName: 'workstream_id',
    ownerId,
  });

  let workspaceId =
    typeof payload.workspace_id === 'string'
      ? payload.workspace_id
      : typeof entityData.workspace_id === 'string'
      ? entityData.workspace_id
      : null;
  let milestoneHints: AssignmentHints | null = null;
  let milestoneContextRow: Record<string, unknown> | null = null;

  if (milestoneId) {
    const { data: milestoneRow, error: milestoneLookupError } = await admin
      .from('milestones')
      .select(
        'id, initiative_id, workstream_id, workspace_id, title, description, metadata'
      )
      .eq('id', milestoneId)
      .maybeSingle();

    if (milestoneLookupError) {
      throw errors.internal('Unable to load milestone for task creation');
    }
    if (!milestoneRow) {
      throw errors.badRequest('Task milestone_id is invalid');
    }

    if (initiativeId && initiativeId !== milestoneRow.initiative_id) {
      throw errors.badRequest(
        'Task initiative_id must match milestone initiative_id'
      );
    }
    if (workstreamId && workstreamId !== milestoneRow.workstream_id) {
      throw errors.badRequest(
        'Task workstream_id must match milestone workstream_id'
      );
    }

    initiativeId = milestoneRow.initiative_id;
    workstreamId = milestoneRow.workstream_id;
    workspaceId = workspaceId ?? milestoneRow.workspace_id ?? null;
    payload.milestone_id = milestoneRow.id;
    milestoneHints = extractAssignmentHints(
      milestoneRow as unknown as Record<string, unknown>
    );
    milestoneContextRow = milestoneRow as unknown as Record<string, unknown>;
  }

  if (!initiativeId) {
    throw errors.badRequest('Task requires initiative_id');
  }

  if (!workstreamId) {
    const { data: existingWorkstream, error: workstreamLookupError } =
      await admin
        .from('workstreams')
        .select('id, workspace_id, name, metadata, created_at')
        .eq('initiative_id', initiativeId)
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: true })
        .limit(50);

    if (workstreamLookupError) {
      throw errors.internal('Unable to resolve default workstream for task');
    }

    const rows = (existingWorkstream ?? []) as Array<{
      id: string;
      workspace_id?: string | null;
      name?: string | null;
      metadata?: unknown;
    }>;
    const backlogWorkstream =
      rows.find((row) => {
        const name =
          typeof row.name === 'string' ? row.name.trim().toLowerCase() : '';
        const metadata =
          row.metadata && typeof row.metadata === 'object'
            ? (row.metadata as Record<string, unknown>)
            : null;
        return (
          name === 'backlog' ||
          metadata?.system_backlog === true ||
          metadata?.system_backlog === 'true'
        );
      }) ??
      rows[0] ??
      null;

    if (backlogWorkstream?.id) {
      workstreamId = backlogWorkstream.id;
      workspaceId = workspaceId ?? backlogWorkstream.workspace_id ?? null;
      payload.workstream_id = workstreamId;
    } else {
      const { data: createdWorkstream, error: createWorkstreamError } =
        await admin
          .from('workstreams')
          .insert({
            owner_id: ownerId,
            initiative_id: initiativeId,
            workspace_id: workspaceId,
            name: 'Backlog',
            summary: 'Default workstream for uncategorized tasks.',
            status: 'planned',
            metadata: {
              system_backlog: true,
              source: 'task_hierarchy_auto_resolution',
            },
          })
          .select('id, workspace_id')
          .maybeSingle();

      if (createWorkstreamError || !createdWorkstream?.id) {
        throw errors.internal('Unable to resolve default workstream for task');
      }

      workstreamId = createdWorkstream.id;
      workspaceId = workspaceId ?? createdWorkstream.workspace_id ?? null;
      payload.workstream_id = workstreamId;
    }
  }

  if (!workstreamId) {
    throw errors.badRequest('Task requires workstream_id');
  }

  if (!payload.milestone_id) {
    const backlogMilestoneId = await ensureBacklogMilestoneId(
      admin as unknown as SupabaseDbClient,
      {
        ownerId,
        initiativeId,
        workstreamId,
        workspaceId,
      }
    );
    if (!backlogMilestoneId) {
      throw errors.internal('Unable to resolve backlog milestone for task');
    }
    payload.milestone_id = backlogMilestoneId;
  }

  if (!milestoneContextRow && typeof payload.milestone_id === 'string') {
    const { data: milestoneRow } = await admin
      .from('milestones')
      .select(
        'id, initiative_id, workstream_id, workspace_id, title, description, metadata'
      )
      .eq('id', payload.milestone_id)
      .maybeSingle();
    if (milestoneRow) {
      milestoneContextRow = milestoneRow as unknown as Record<string, unknown>;
      milestoneHints = extractAssignmentHints(milestoneContextRow);
    }
  }

  payload.initiative_id = initiativeId;
  payload.workstream_id = workstreamId;
  const { data: workstreamRow, error: workstreamLookupError } = await admin
    .from('workstreams')
    .select(
      'id, initiative_id, workspace_id, name, summary, domain, persona, metadata'
    )
    .eq('id', workstreamId)
    .maybeSingle();

  if (workstreamLookupError) {
    throw errors.internal('Unable to load workstream for task creation');
  }
  if (!workstreamRow) {
    throw errors.badRequest('Task workstream_id is invalid');
  }
  if (initiativeId !== workstreamRow.initiative_id) {
    throw errors.badRequest(
      'Task initiative_id must match workstream initiative_id'
    );
  }
  workspaceId = workspaceId ?? workstreamRow.workspace_id ?? null;

  if (!payload.workspace_id && workspaceId) {
    payload.workspace_id = workspaceId;
  }

  const sourceHints: AssignmentHints[] = [
    extractAssignmentHints(workstreamRow as unknown as Record<string, unknown>),
  ];
  if (milestoneHints) {
    sourceHints.unshift(milestoneHints);
  }
  applyAssignmentDefaultsToPayload({
    payload,
    type: 'task',
    sourceHints,
    fallbackDomainCandidates: [
      (workstreamRow as Record<string, unknown>).domain,
      (workstreamRow as Record<string, unknown>).persona,
    ],
  });

  const { data: initiativeRow } = await admin
    .from('initiatives')
    .select('id, title, summary, metadata')
    .eq('id', initiativeId)
    .maybeSingle();

  await applyIwmtAssignmentFallback({
    payload,
    type: 'task',
    userId,
    sourceHints,
    fallbackDomainCandidates: [
      (workstreamRow as Record<string, unknown>).domain,
      (workstreamRow as Record<string, unknown>).persona,
    ],
    context: {
      initiative: (initiativeRow as Record<string, unknown> | null) ?? null,
      workstream: workstreamRow as unknown as Record<string, unknown>,
      milestone: milestoneContextRow,
      task: buildDraftEntityContext(payload, entityData),
    },
  });
}

// Valid entity types including special non-DB types
const ALL_ENTITY_TYPES = [
  ...Object.keys(ENTITY_CONFIG),
  'agent',
  'video_template',
] as const;

/**
 * Handle agent listing from capability registry
 * Returns agents with their tools, guardrails, channels, and config from AGENT_CONFIGS
 */
function handleAgentList(params: {
  limit: number;
  offset: number;
  domain: string | null;
  includeRelationships: boolean;
}): NextResponse {
  const { limit, offset, domain, includeRelationships } = params;

  // Get all capabilities from registry
  let capabilities = listCapabilities();

  // Filter out duplicates (same agentId) and special agents
  const seenIds = new Set<string>();
  capabilities = capabilities.filter((cap) => {
    // Skip chatgpt-app and other internal agents
    if (cap.agentId === 'chatgpt-app' || cap.agentId.includes('onboarding')) {
      return false;
    }
    if (seenIds.has(cap.agentId)) {
      return false;
    }
    seenIds.add(cap.agentId);
    return true;
  });

  // Filter by domain if specified
  if (domain) {
    capabilities = capabilities.filter((cap) => cap.domain === domain);
  }

  const total = capabilities.length;
  const paginatedCapabilities = capabilities.slice(offset, offset + limit);

  // Build agent data with config info
  const agents = paginatedCapabilities.map((cap) => {
    const config = AGENT_CONFIGS[cap.domain as AgentDomainId];

    const agent: Record<string, unknown> = {
      id: cap.agentId,
      domain: cap.domain,
      name: config?.name ?? cap.displayName ?? cap.agentId,
      role: config?.role ?? 'Agent',
      tagline: config?.tagline ?? null,
      description: config?.description ?? null,
      avatar: config?.avatar ?? cap.avatarUrl ?? null,
      domains: cap.domains,
      channels: cap.channels ?? [],
      guardrails: cap.guardrails ?? [],
      max_depth: cap.maxDepth ?? null,
    };

    // Include full tool list if relationships requested
    if (includeRelationships) {
      agent.tools = cap.tools ?? [];
      agent.tool_count = (cap.tools ?? []).length;
    } else {
      // Just show counts
      agent.tool_count = (cap.tools ?? []).length;
      agent.tools_preview = (cap.tools ?? []).slice(0, 5);
    }

    return agent;
  });

  return NextResponse.json({
    type: 'agent',
    data: agents,
    pagination: {
      total,
      limit,
      offset,
      has_more: total > offset + limit,
    },
  });
}

/**
 * Handle video template listing - static templates from studioVideoTool
 */
async function handleVideoTemplateList(params: {
  limit: number;
  offset: number;
}): Promise<NextResponse> {
  const { limit, offset } = params;

  const result = await studioVideoTool.videoTemplates(
    {},
    {} as import('@/lib/agents/tools/types').ToolContext
  );
  if (!result.ok || !result.data) {
    throw errors.internal('Failed to list video templates');
  }

  const templates = (result.data as { templates?: unknown[] }).templates ?? [];
  const total = templates.length;
  const data = templates.slice(offset, offset + limit);

  return NextResponse.json({
    type: 'video_template',
    data,
    pagination: { total, limit, offset, has_more: total > offset + limit },
  });
}

/**
 * GET /api/entities?type=initiative&limit=20&offset=0&include_relationships=true
 * List entities with pagination and optional relationships
 *
 * Special handling for type=agent:
 * - Returns agents from capability registry with their tools, guardrails, channels
 * - Supports domain filter (e.g., domain=product)
 * - include_relationships=true returns full tool lists
 */
const getHandler: ApiHandler = async (request: Request) => {
  const url = new URL(request.url);
  const requestedType = url.searchParams.get('type');
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') || '20', 10),
    100
  );
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const includeRelationships =
    url.searchParams.get('include_relationships') === 'true';
  // Opt-in exact count — avoids expensive full-table COUNT(*) on every request.
  // Clients that need total should pass ?count=true explicitly.
  const wantExactCount = url.searchParams.get('count') === 'true';
  const id = url.searchParams.get('id');
  const status = url.searchParams.get('status');
  const initiativeId = url.searchParams.get('initiative_id');
  const workstreamId = url.searchParams.get('workstream_id');
  const domain = url.searchParams.get('domain');
  // Studio-specific filter params
  const brandId = url.searchParams.get('brand_id');
  const contentType = url.searchParams.get('content_type');
  const search = url.searchParams.get('search') ?? url.searchParams.get('query');
  const dateRange = readEntitySearchDateRange(url.searchParams);
  const fieldsParam = url.searchParams.get('fields');
  const idsParam = url.searchParams.get('ids');
  const ids =
    typeof idsParam === 'string' && idsParam.trim().length > 0
      ? Array.from(
          new Set(
            idsParam
              .split(',')
              .map((value) => value.trim())
              .filter((value) => value.length > 0)
          )
        ).slice(0, 100)
      : [];
  const userIdParam = url.searchParams.get('user_id');
  const workspaceIdParam = url.searchParams.get('workspace_id');
  let workspaceId = resolveWorkspaceIdAlias({
    workspaceId: workspaceIdParam,
    sourceLabel: 'query parameters',
  });

  assertRequired(requestedType, 'type');
  assertString(requestedType, 'type');
  const type = normalizeEntityTypeAlias(requestedType);
  // Handle 'agent' type specially - from capability registry, not database
  if (type === 'agent') {
    return handleAgentList({ limit, offset, domain, includeRelationships });
  }
  // Handle 'video_template' type specially - static list, no DB table
  if (type === 'video_template') {
    return handleVideoTemplateList({ limit, offset });
  }

  if (!isValidEntityType(type)) {
    throw errors.badRequest(
      `Invalid entity type: ${type}. Valid types: ${ALL_ENTITY_TYPES.join(
        ', '
      )}`
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    throw errors.serviceUnavailable('Database connection unavailable');
  }

  const config = ENTITY_CONFIG[type];
  const statusFilter =
    type === 'decision'
      ? normalizeDecisionStatus(status)
      : typeof status === 'string'
      ? status
      : null;
  const orderBy = normalizeListOrderBy(type, url.searchParams.get('order_by'));
  const orderDirection = normalizeListOrderDirection(
    url.searchParams.get('order_direction')
  );

  // Resolve the effective user identity for user-scoped entity types.
  //
  // This prevents accidental full-table scans when using the service role
  // Supabase client and ensures API-key callers can't read other users' data
  // by overriding `user_id`.
  const requiresUserIdentity =
    OWNER_FILTER_SUPPORTED_TYPES.has(type) ||
    type === 'relationship' ||
    type === 'studio_brand' ||
    type === 'studio_content' ||
    type === 'stream';

  const rawUserId =
    typeof userIdParam === 'string' && userIdParam.trim().length > 0
      ? userIdParam.trim()
      : null;

  let serviceAuthorized = false;
  try {
    // Only trust X-Orgx-User-Id when the request is authenticated with the service key.
    serviceAuthorized = !ensureServiceRequestAuthorized(request);
  } catch {
    serviceAuthorized = false;
  }

  const apiKeyAuth =
    !serviceAuthorized && requiresUserIdentity
      ? await authenticateApiKey(request)
      : null;

  let effectiveUserId: string | null = null;
  if (requiresUserIdentity) {
    if (serviceAuthorized) {
      // Trusted gateway path: allow explicit user_id override for service calls.
      effectiveUserId = rawUserId ?? extractGatewayUserId(request);
    } else {
      // API key path: never allow overriding user identity via user_id param.
      effectiveUserId = apiKeyAuth?.userId ?? null;

      if (rawUserId && effectiveUserId) {
        const resolvedRaw = await resolveOwnerId(rawUserId);
        if (resolvedRaw !== effectiveUserId) {
          throw errors.forbidden('user_id does not match API key identity');
        }
      }
    }
  } else {
    effectiveUserId = rawUserId;
  }

  if (requiresUserIdentity && !effectiveUserId) {
    throw errors.badRequest(
      'user_id is required for this entity type (or provide service auth with X-Orgx-User-Id)'
    );
  }

  const resolvedUserId = effectiveUserId
    ? await resolveOwnerId(effectiveUserId, {
        gatewayEmail: serviceAuthorized
          ? extractGatewayUserEmail(request)
          : null,
        gatewayOrgxUserId: resolveGatewayOrgxUserIdHint(
          request,
          effectiveUserId,
          serviceAuthorized
        ),
      })
    : null;

  // For UUID-typed ownership columns, fail fast if the resolved ID isn't a UUID.
  // This avoids leaking internal Postgres errors as 500s (e.g. 22P02 invalid UUID).
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    requiresUserIdentity &&
    resolvedUserId &&
    !uuidPattern.test(resolvedUserId)
  ) {
    throw errors.badRequest(
      "user_id must be a UUID or a valid external id starting with 'user_'"
    );
  }

  if (workspaceId && !uuidPattern.test(workspaceId)) {
    throw errors.badRequest('workspace_id must be a UUID');
  }

  if (ids.length > 0) {
    const invalidIds = ids.filter((v) => !uuidPattern.test(v));
    if (invalidIds.length > 0) {
      throw errors.badRequest(
        `ids contains invalid UUIDs: ${invalidIds.slice(0, 3).join(', ')}`
      );
    }
  }

  const resolveFilterId = async (
    entityType: EntityType,
    inputId: string | null,
    fieldLabel: string
  ): Promise<string | null> => {
    if (!inputId) return null;
    const resolved = await resolveEntityIdReference({
      adminClient: admin as unknown as SupabaseDbClient,
      entityType,
      inputId,
      ownerId: resolvedUserId,
      fieldLabel,
    });

    if (resolved.resolvedByReference) {
      logger.info('[api:entities] resolved query filter id', {
        entityType,
        fieldLabel,
        requestedId: inputId,
        resolvedId: resolved.id,
        resolutionMethod: resolved.resolutionMethod,
      });
    }

    return resolved.id;
  };

  const resolvedEntityId = await resolveFilterId(type, id, 'id');
  const resolvedInitiativeId = await resolveFilterId(
    'initiative',
    initiativeId,
    'initiative_id'
  );
  const resolvedWorkstreamId = await resolveFilterId(
    'workstream',
    workstreamId,
    'workstream_id'
  );
  const resolvedBrandId = await resolveFilterId(
    'studio_brand',
    brandId,
    'brand_id'
  );

  const INITIATIVE_CHILD_TYPES: ReadonlySet<string> = new Set([
    'milestone',
    'workstream',
    'stream',
    'task',
    'decision',
  ]);
  const isInitiativeScopedChildQuery =
    resolvedInitiativeId !== null && INITIATIVE_CHILD_TYPES.has(type);

  // Streams do not have owner_id columns, but they must still be scoped to a user
  // when using the service-role Supabase client (to avoid cross-user data leakage).
  //
  // Initiative-scoped child queries are the exception: the initiative_id filter
  // is the access boundary, so collaborator reads must not be re-filtered back
  // down to only workspaces owned by the caller. Without this carve-out, launch
  // succeeds but MCP `list_entities(type="stream", initiative_id=...)` reports
  // an empty set whenever the initiative workspace is not directly owned by the
  // requesting user.
  let allowedStreamWorkspaceIds: string[] | null = null;
  if (type === 'stream' && resolvedUserId && !isInitiativeScopedChildQuery) {
    const { data: centers, error: centersError } = await admin
      .from('workspaces')
      .select('id')
      .eq('owner_id', resolvedUserId);

    if (centersError) {
      logger.error('[api:entities] failed to resolve command centers', {
        error: centersError.message,
        userId: resolvedUserId,
      });
      throw errors.internal('Failed to resolve workspace scope');
    }

    const centerIds = (centers ?? [])
      .map((row: { id: string | null }) => row.id)
      .filter((value: string | null): value is string => {
        return typeof value === 'string' && value.trim().length > 0;
      });

    allowedStreamWorkspaceIds = centerIds;

    if (workspaceId && !centerIds.includes(workspaceId)) {
      throw errors.forbidden('workspace_id is not accessible for this user');
    }
  }

  type EntityFilterableQuery = {
    eq: (column: string, value: unknown) => EntityFilterableQuery;
    ilike: (column: string, pattern: string) => EntityFilterableQuery;
    or: (expression: string) => EntityFilterableQuery;
    in: (column: string, values: unknown[]) => EntityFilterableQuery;
    contains: (column: string, value: unknown) => EntityFilterableQuery;
  };

  // Initiative-scoped child queries skip the owner_id filter so collaborators
  // on an initiative can enumerate its children even when individual rows
  // were created by other users (e.g. a system agent scaffolded the milestones
  // while the caller was granted initiative-level read access later).
  //
  // Access control falls through to the initiative_id equality filter below,
  // which is itself the scope boundary. This matches the access model used by
  // getInitiativePulse() (see lib/server/chatgptAppSearch.ts), so the two
  // endpoints return consistent child sets. Without this carve-out, an
  // initiative scaffolded by a different user appears empty via list_entities
  // while pulse returns its full hierarchy — the exact inconsistency that
  // caused artifact attachment to land at initiative-level instead of at
  // the correct milestone children.

  const applyFilters = <T>(query: T): T => {
    let typedQuery = applySearchDateRange(query, dateRange) as T & EntityFilterableQuery;
    if (resolvedEntityId) {
      typedQuery = typedQuery.eq('id', resolvedEntityId) as T &
        EntityFilterableQuery;
    } else if (ids.length > 0) {
      typedQuery = typedQuery.in('id', ids) as T & EntityFilterableQuery;
    }
    if (resolvedUserId && !isInitiativeScopedChildQuery) {
      if (type === 'run') {
        typedQuery = typedQuery.eq('requester_id', resolvedUserId) as T &
          EntityFilterableQuery;
      } else if (type === 'relationship') {
        typedQuery = typedQuery.eq('owner_user_id', resolvedUserId) as T &
          EntityFilterableQuery;
      } else if (OWNER_FILTER_SUPPORTED_TYPES.has(type) && type !== 'blocker') {
        typedQuery = typedQuery.eq('owner_id', resolvedUserId) as T &
          EntityFilterableQuery;
      }
    }
    if (
      statusFilter &&
      (config.validStatuses as readonly string[]).includes(statusFilter)
    ) {
      typedQuery = typedQuery.eq(
        String(config.statusColumn),
        statusFilter
      ) as T & EntityFilterableQuery;
    }
    if (
      resolvedInitiativeId &&
      ['milestone', 'workstream', 'stream', 'task', 'decision', 'run'].includes(
        type
      )
    ) {
      // 'run' was previously excluded here, so list_entities(type=run,
      // initiative_id=X) silently returned workspace-wide runs (incl.
      // rows with null or different initiative_id). The access scope
      // for runs is still requester_id (applied above), so adding
      // initiative_id narrows the result without weakening security.
      typedQuery = typedQuery.eq('initiative_id', resolvedInitiativeId) as T &
        EntityFilterableQuery;
    }
    if (resolvedInitiativeId && type === 'artifact') {
      typedQuery = typedQuery.or(
        `and(entity_type.eq.initiative,entity_id.eq.${resolvedInitiativeId}),metadata->>source_initiative_id.eq.${resolvedInitiativeId}`
      ) as T & EntityFilterableQuery;
    }
    if (resolvedWorkstreamId && type === 'task') {
      typedQuery = typedQuery.eq('workstream_id', resolvedWorkstreamId) as T &
        EntityFilterableQuery;
    }
    if (resolvedWorkstreamId && type === 'artifact') {
      typedQuery = typedQuery.contains('metadata', {
        source_entity_type: 'workstream',
        source_entity_id: resolvedWorkstreamId,
      }) as T & EntityFilterableQuery;
    }

    // Studio-specific filters
    if (resolvedBrandId && type === 'studio_content') {
      typedQuery = typedQuery.eq('brand_id', resolvedBrandId) as T &
        EntityFilterableQuery;
    }
    if (contentType && type === 'studio_content') {
      typedQuery = typedQuery.eq('content_type', contentType) as T &
        EntityFilterableQuery;
    }
    if (
      resolvedUserId &&
      (type === 'studio_brand' || type === 'studio_content')
    ) {
      typedQuery = typedQuery.eq('user_id', resolvedUserId) as T &
        EntityFilterableQuery;
    }

    if (type === 'stream') {
      if (workspaceId) {
        typedQuery = typedQuery.eq('workspace_id', workspaceId) as T &
          EntityFilterableQuery;
      } else if (
        !isInitiativeScopedChildQuery &&
        allowedStreamWorkspaceIds?.length
      ) {
        typedQuery = typedQuery.in(
          'workspace_id',
          allowedStreamWorkspaceIds
        ) as T & EntityFilterableQuery;
      } else if (!isInitiativeScopedChildQuery && allowedStreamWorkspaceIds) {
        // A user with no workspaces shouldn't see any streams.
        typedQuery = typedQuery.eq(
          'workspace_id',
          '00000000-0000-0000-0000-000000000000'
        ) as T & EntityFilterableQuery;
      }
    } else if (
      workspaceId &&
      COMMAND_CENTER_FILTER_SUPPORTED_TYPES.has(type as EntityType)
    ) {
      // Include both exact-match and NULL rows. NULL rows are pre-workspace
      // entities (created before workspace scoping was introduced) and must
      // remain visible so they aren't silently dropped from all views.
      // owner_id already prevents cross-user leakage.
      typedQuery = typedQuery.or(
        `workspace_id.eq.${workspaceId},workspace_id.is.null`
      ) as T & EntityFilterableQuery;
    }

    if (typeof search === 'string' && search.trim().length > 0) {
      const labelCol = type === 'studio_brand' ? 'name' : 'title';
      if (type === 'studio_content') {
        typedQuery = typedQuery.or(
          `${labelCol}.ilike.%${search}%,prompt.ilike.%${search}%`
        ) as T & EntityFilterableQuery;
      } else if (type === 'studio_brand') {
        typedQuery = typedQuery.ilike(labelCol, `%${search}%`) as T &
          EntityFilterableQuery;
      } else {
        const searchExpression = buildEntitySearchExpression(
          type as EntityType,
          search
        );
        if (searchExpression) {
          typedQuery = typedQuery.or(searchExpression) as T &
            EntityFilterableQuery;
        }
      }
    }

    return typedQuery as T;
  };

  // Build select with optional relationships and fields filtering
  // When `fields` is provided, only select the requested columns (must be a
  // subset of the config.select columns). Always includes 'id'.
  let baseSelect: string = config.select;
  if (fieldsParam) {
    const configColumns = new Set(
      config.select.split(',').map((col: string) => col.trim())
    );
    const fieldAliases = ENTITY_FIELD_ALIASES[type as EntityType] ?? {};
    const requestedFields = fieldsParam
      .split(',')
      .map((f: string) => f.trim())
      .map((field: string) => {
        if (configColumns.has(field)) return field;
        const aliasedField = fieldAliases[field];
        return aliasedField && configColumns.has(aliasedField)
          ? aliasedField
          : null;
      })
      .filter(
        (field: string | null): field is string => typeof field === 'string'
      );
    // Always include 'id'
    if (!requestedFields.includes('id')) {
      requestedFields.unshift('id');
    }
    if (requestedFields.length > 0) {
      baseSelect = Array.from(new Set(requestedFields)).join(', ');
    }
  }

  let selectQuery: string = baseSelect;
  if (includeRelationships && config.relationships.length > 0) {
    const relationshipSelects = config.relationships
      .map((rel) => (rel.includes('(') ? rel : `${rel}(*)`))
      .join(', ');
    selectQuery = `${baseSelect}, ${relationshipSelects}`;
  }

  const explicitOrderBy = url.searchParams.has('order_by');
  const useNaturalHierarchyOrder =
    orderBy === 'natural' ||
    (!explicitOrderBy &&
      SEQUENCE_ORDERED_TYPES.has(type as EntityType) &&
      type !== 'initiative' &&
      (resolvedInitiativeId !== null || resolvedWorkstreamId !== null));
  let enableSequenceOrdering = useNaturalHierarchyOrder;
  let enableDueDateOrdering = type === 'milestone' || type === 'task';

  const applyListOrdering = <T>(query: T): T => {
    let ordered = query as T & {
      order: (column: string, options?: Record<string, unknown>) => any;
    };

    if (enableSequenceOrdering) {
      ordered = ordered.order('sequence', {
        ascending: true,
        nullsFirst: false,
      });
    }
    if (enableDueDateOrdering && useNaturalHierarchyOrder) {
      ordered = ordered.order('due_date', {
        ascending: true,
        nullsFirst: false,
      });
    }

    return ordered.order(useNaturalHierarchyOrder ? 'created_at' : orderBy, {
      ascending: useNaturalHierarchyOrder ? true : orderDirection === 'asc',
      nullsFirst: false,
    }) as T;
  };

  // Only compute exact row count when the caller explicitly asks for it
  // (count=true). The default avoids an expensive COUNT(*) full-table scan
  // that was causing 60 s timeouts under load.
  const countOption = wantExactCount ? 'exact' : undefined;

  const runListQuery = async (select: string) => {
    if (type === 'blocker' && resolvedUserId) {
      // agent_run_blockers has no owner column. Scope it by joining agent_runs and
      // filtering on requester_id, then strip the join payload from the response.
      const selectWithJoin = `${select}, agent_runs!inner(requester_id, initiative_id)`;
      let blockerQuery = admin
        .from(config.table)
        .select(selectWithJoin as any, { count: countOption })
        .eq('agent_runs.requester_id', resolvedUserId);
      if (resolvedInitiativeId) {
        blockerQuery = blockerQuery.eq(
          'agent_runs.initiative_id',
          resolvedInitiativeId
        );
      }
      return await applyFilters(
        applyListOrdering(blockerQuery).range(offset, offset + limit - 1)
      );
    }

    return await applyFilters(
      applyListOrdering(
        admin.from(config.table).select(select as any, { count: countOption })
      ).range(offset, offset + limit - 1)
    );
  };

  let currentSelect: string = selectQuery;
  let { data, error, count } = await withQueryTimeout(
    runListQuery(currentSelect)
  );

  // Backwards-compat: if the API was deployed before migrations ran, selects
  // can reference columns not present in the schema yet (PGRST204/42703). Prune
  // missing columns and retry rather than failing the whole list call.
  for (
    let attempt = 0;
    attempt < 5 && error && isMissingColumnError(error);
    attempt++
  ) {
    const missing = extractMissingColumnName(error.message);
    if (!missing) break;
    let shouldRetry = false;

    // If the schema isn't migrated yet, workspace_id filters can break reads.
    // Disable workspace scoping and retry rather than failing the whole request.
    if (missing === 'workspace_id' && workspaceId) {
      workspaceId = null;
      shouldRetry = true;
    }

    if (missing === 'sequence' && enableSequenceOrdering) {
      enableSequenceOrdering = false;
      shouldRetry = true;
    }

    if (missing === 'due_date' && enableDueDateOrdering) {
      enableDueDateOrdering = false;
      shouldRetry = true;
    }

    const nextSelect = pruneSelectColumn(currentSelect, missing);
    if (nextSelect && nextSelect !== currentSelect) {
      currentSelect = nextSelect;
      shouldRetry = true;
    }

    if (!shouldRetry) break;
    logger.warn('[api:entities] missing column in select, retrying', {
      type,
      table: config.table,
      missingColumn: missing,
    });
    ({ data, error, count } = await withQueryTimeout(
      runListQuery(currentSelect)
    ));
  }

  if (error && includeRelationships && isSchemaCacheRelationshipError(error)) {
    logger.warn(
      `[api:entities] relationships unavailable for ${type}, falling back`,
      {
        relationships: config.relationships,
        error: error.message,
        code: error.code,
      }
    );

    const {
      data: fallbackData,
      error: fallbackError,
      count: fallbackCount,
    } = await withQueryTimeout(runListQuery(baseSelect));

    // Same backwards-compat pruning for fallback selects.
    let finalFallbackData = fallbackData;
    let finalFallbackError = fallbackError;
    let finalFallbackCount = fallbackCount;
    let fallbackSelect: string = baseSelect;
    for (
      let attempt = 0;
      attempt < 5 &&
      finalFallbackError &&
      isMissingColumnError(finalFallbackError);
      attempt++
    ) {
      const missing = extractMissingColumnName(finalFallbackError.message);
      if (!missing) break;
      let shouldRetry = false;

      if (missing === 'workspace_id' && workspaceId) {
        workspaceId = null;
        shouldRetry = true;
      }

      if (missing === 'sequence' && enableSequenceOrdering) {
        enableSequenceOrdering = false;
        shouldRetry = true;
      }

      if (missing === 'due_date' && enableDueDateOrdering) {
        enableDueDateOrdering = false;
        shouldRetry = true;
      }

      const nextSelect = pruneSelectColumn(fallbackSelect, missing);
      if (nextSelect && nextSelect !== fallbackSelect) {
        fallbackSelect = nextSelect;
        shouldRetry = true;
      }

      if (!shouldRetry) break;
      logger.warn(
        '[api:entities] missing column in fallback select, retrying',
        {
          type,
          table: config.table,
          missingColumn: missing,
        }
      );
      const res = await withQueryTimeout(runListQuery(fallbackSelect));
      finalFallbackData = res.data;
      finalFallbackError = res.error;
      finalFallbackCount = res.count;
    }

    if (finalFallbackError) {
      logger.error(
        `[api:entities] failed to list ${type} without relationships`,
        {
          error: finalFallbackError.message,
          code: finalFallbackError.code,
        }
      );
      if (isStatementTimeout(finalFallbackError)) {
        throw errors.timeout(`Query timed out listing ${type}`);
      }
      throw errors.internal(`Failed to list ${type}`);
    }

    const fbRows = (finalFallbackData ?? []) as unknown[];
    const fbTotal = finalFallbackCount ?? null;
    return NextResponse.json({
      type,
      data: attachResponseAliasesToRows(type as EntityType, fbRows),
      ordering: {
        order_by: useNaturalHierarchyOrder ? 'natural' : orderBy,
        order_direction: useNaturalHierarchyOrder ? 'asc' : orderDirection,
      },
      pagination: {
        total: fbTotal ?? -1,
        limit,
        offset,
        has_more:
          fbTotal != null ? fbTotal > offset + limit : fbRows.length === limit,
      },
    });
  }

  if (error) {
    logger.error(`[api:entities] failed to list ${type}`, {
      error: error.message,
      code: error.code,
    });
    if (isStatementTimeout(error)) {
      throw errors.timeout(`Query timed out listing ${type}`);
    }
    if (type === 'initiative' && !includeRelationships) {
      return jsonOk(
        withDegradedPayload(
          {
            type,
            data: [],
            ordering: {
              order_by: useNaturalHierarchyOrder ? 'natural' : orderBy,
              order_direction: useNaturalHierarchyOrder
                ? 'asc'
                : orderDirection,
            },
            pagination: {
              total: -1,
              limit,
              offset,
              has_more: false,
            },
          },
          'entities_unavailable'
        ),
        {
          cache: {
            visibility: 'private',
            maxAge: 10,
            staleWhileRevalidate: 30,
          },
        }
      );
    }
    throw errors.internal(`Failed to list ${type}`);
  }

  const dataWithRollups =
    includeRelationships && type === 'initiative'
      ? attachInitiativeProgressRollup(
          ((data ?? []) as Array<unknown>).map((item) => asRecord(item) ?? {})
        )
      : data ?? [];

  const normalizedData =
    type === 'blocker' && Array.isArray(dataWithRollups)
      ? dataWithRollups.map((item) => {
          const record = asRecord(item);
          if (!record || !('agent_runs' in record)) return item;
          const { agent_runs: _agentRuns, ...rest } = record;
          return rest;
        })
      : dataWithRollups;

  const rows = (normalizedData ?? []) as unknown[];
  const totalCount = count ?? null;
  return NextResponse.json({
    type,
    data: attachResponseAliasesToRows(type as EntityType, rows),
    ordering: {
      order_by: useNaturalHierarchyOrder ? 'natural' : orderBy,
      order_direction: useNaturalHierarchyOrder ? 'asc' : orderDirection,
    },
    pagination: {
      total: totalCount ?? -1,
      limit,
      offset,
      has_more:
        totalCount != null
          ? totalCount > offset + limit
          : rows.length === limit,
    },
  });
};

/**
 * Build skill payload with required fields
 */
function buildSkillPayload(
  ownerId: string,
  entityData: Record<string, unknown>
): Record<string, unknown> {
  const name = entityData.name ?? entityData.title;
  const promptTemplate =
    entityData.prompt_template ?? entityData.promptTemplate;

  if (!name) {
    throw errors.badRequest('Skill requires a name');
  }
  if (!promptTemplate) {
    throw errors.badRequest('Skill requires a prompt_template');
  }

  return {
    owner_id: ownerId,
    name,
    description: entityData.description ?? entityData.summary ?? null,
    prompt_template: promptTemplate,
    source_type: 'manual_created',
    trigger_keywords: entityData.trigger_keywords ?? [],
    trigger_domains: entityData.trigger_domains ?? [],
    checklist: entityData.checklist ?? [],
  };
}

/**
 * Build plan_session payload with required fields
 */
function buildPlanSessionPayload(
  ownerId: string,
  entityData: Record<string, unknown>
): Record<string, unknown> {
  const featureName =
    entityData.feature_name ?? entityData.title ?? entityData.name;

  if (!featureName) {
    throw errors.badRequest('Plan session requires a feature_name or title');
  }

  return {
    owner_id: ownerId,
    feature_name: featureName,
    title: entityData.title ?? featureName,
    current_plan: entityData.initial_plan ?? entityData.current_plan ?? null,
    status: 'active',
  };
}

/**
 * POST /api/entities
 * Create a new entity
 */
const postHandler: ApiHandler = async (request: Request) => {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw errors.serviceUnavailable('Database connection unavailable');
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw errors.badRequest('Invalid JSON body');
  }

  const {
    type: requestedType,
    owner_id,
    user_id,
    agentic_workstreams,
    agenticWorkstreams,
    auto_plan,
    autoPlan,
    project_id,
    projectId,
    ...entityData
  } = body as Record<string, unknown>;

  assertRequired(requestedType, 'type');
  assertString(requestedType, 'type');
  const type = normalizeEntityTypeAlias(requestedType);
  preserveLegacyIssueSourceType(requestedType, entityData);
  const resolvedWorkspaceId = resolveWorkspaceIdAlias({
    workspaceId: entityData.workspace_id,
    sourceLabel: 'request body',
  });
  if (resolvedWorkspaceId) {
    entityData.workspace_id = resolvedWorkspaceId;
  } else {
    delete entityData.workspace_id;
  }

  let createServiceAuthorized = false;
  try {
    createServiceAuthorized = !ensureServiceRequestAuthorized(request);
  } catch {
    createServiceAuthorized = false;
  }
  const createApiKeyAuth = !createServiceAuthorized
    ? await authenticateApiKey(request)
    : null;
  if (!createServiceAuthorized && !createApiKeyAuth) {
    throw errors.unauthorized('Valid service key or API key is required');
  }

  // Service calls may explicitly target an owner. Per-user API keys may not:
  // their authenticated principal is the only safe default or explicit owner.
  const explicitOwnerId = owner_id ?? user_id;
  const ownerId =
    explicitOwnerId ??
    (createServiceAuthorized
      ? await resolveDefaultOwnerId(request)
      : createApiKeyAuth?.userId) ??
    undefined;

  const agenticOverride = parseBoolean(
    agenticWorkstreams ?? agentic_workstreams,
    null
  );
  const autoPlanOverride = parseBoolean(autoPlan ?? auto_plan, null);
  const overrideProjectId =
    typeof projectId === 'string'
      ? projectId
      : typeof project_id === 'string'
      ? project_id
      : null;

  const isStream = type === 'stream';
  if (!isStream) {
    assertRequired(ownerId, 'owner_id');
    assertString(ownerId, 'owner_id');
  }

  if (!isValidEntityType(type as string)) {
    throw errors.badRequest(
      `Invalid entity type: ${type}. Valid types: ${Object.keys(
        ENTITY_CONFIG
      ).join(', ')}`
    );
  }

  const createViolation = decisionCreateLifecycleViolation(type, entityData);
  if (createViolation) {
    throw errors.forbidden(directHumanDecisionActionMessage(createViolation));
  }
  const runCreateViolation = directRunLifecycleViolation(type, entityData);
  if (runCreateViolation) throw errors.forbidden(runCreateViolation);
  const createReferenceFieldsByType: Partial<Record<EntityType, string[]>> = {
    artifact: ['entity_id', 'initiative_id'],
    milestone: ['initiative_id', 'workstream_id'],
    task: ['initiative_id', 'workstream_id', 'milestone_id'],
    workstream: ['initiative_id'],
    stream: ['initiative_id', 'workstream_id'],
  };
  const createReferenceFields = createReferenceFieldsByType[
    type as EntityType
  ] ?? ['initiative_id', 'workstream_id', 'milestone_id', 'entity_id'];
  const syntheticCreateRef = findSyntheticReferenceField(
    entityData,
    createReferenceFields
  );
  const syntheticCreateNoop = maybeBuildSyntheticReferenceNoop({
    request,
    type: type as string,
    operation: 'create',
    syntheticRef: syntheticCreateRef,
  });
  if (syntheticCreateNoop) {
    return syntheticCreateNoop;
  }

  // Resolve external_id to internal UUID if needed
  const ownerIdValue = !isStream ? (ownerId as string) : null;
  // Gateway identity hints are only trustworthy on service-key requests.
  const gatewayEmail = createServiceAuthorized
    ? extractGatewayUserEmail(request)
    : null;
  const resolvedOwnerId = ownerIdValue
    ? await resolveOwnerId(ownerIdValue, {
        gatewayEmail,
        gatewayOrgxUserId: resolveGatewayOrgxUserIdHint(
          request,
          ownerIdValue,
          createServiceAuthorized
        ),
      })
    : null;
  if (
    !createServiceAuthorized &&
    resolvedOwnerId !== createApiKeyAuth?.userId
  ) {
    throw errors.forbidden('owner_id does not match API key identity');
  }

  const config = ENTITY_CONFIG[type as EntityType];

  // Relationship OS spine (person / business / goal): never raw-insert. These
  // tables carry invariants (identity dedupe, person_business_roles edge, goal
  // ownership) owned by the canonical write layer. Delegate, then re-read the
  // row through the normal select so the response shape matches every other
  // entity type. See docs/initiatives/onboarding-consolidation-ADR.md (Phase 1b).
  if (isRelationshipEntityType(type as string)) {
    const ownerForRelationship = resolvedOwnerId ?? ownerIdValue;
    if (!ownerForRelationship) {
      throw errors.badRequest(`${type} requires owner_id`);
    }
    const result = await createRelationshipEntity({
      type: type as RelationshipEntityType,
      ownerId: ownerForRelationship,
      body: { ...entityData, owner_id: ownerForRelationship },
    });
    const { data: createdRow } = await admin
      .from(config.table)
      .select(config.select)
      .eq('id', result.id)
      .maybeSingle();
    const responseData = attachResponseAliases(
      type as EntityType,
      (createdRow as Record<string, unknown> | null) ?? { id: result.id }
    );
    return NextResponse.json(
      {
        ...(isObjectRecord(responseData) ? responseData : {}),
        type,
        data: responseData,
        _created: result.created,
      },
      { status: result.created ? 201 : 200 }
    );
  }

  // Build payload based on entity type
  let payload: Record<string, unknown>;

  if (type === 'artifact') {
    const ownerForPayload = resolvedOwnerId ?? ownerIdValue;
    if (!ownerForPayload) {
      throw errors.badRequest('artifact requires owner_id');
    }

    // An artifact must not be BORN human-accepted. `createClientArtifact`
    // writes `payload.status ?? 'draft'` straight through, and its zod contract
    // still admits `approved`, so without this a caller could create a row that
    // claims a person accepted work nobody has seen — the same bypass
    // agentJobExecutor had before it was changed to always create `in_review`.
    assertArtifactStatusWritable(type, entityData.status);

    const normalizedArtifactBody = await resolveClientArtifactCreateBodyRefs({
      adminClient: admin as any,
      requesterId: ownerForPayload,
      body: {
        id: entityData.id,
        artifact_id: entityData.artifact_id,
        entity_type: entityData.entity_type,
        entity_id: entityData.entity_id,
        initiative_id: entityData.initiative_id,
        name: entityData.name ?? entityData.title,
        artifact_type: entityData.artifact_type,
        description: entityData.description ?? entityData.summary ?? null,
        artifact_url: entityData.artifact_url,
        external_url: entityData.external_url,
        preview_markdown: entityData.preview_markdown,
        status: entityData.status,
        metadata: entityData.metadata,
        created_by_type: entityData.created_by_type,
        created_by_id: entityData.created_by_id,
      },
    });
    const artifactPayload = parseClientArtifactCreateBody(
      normalizedArtifactBody
    );

    const result = await createClientArtifact({
      requesterId: ownerForPayload,
      payload: artifactPayload,
      adminClient: admin as any,
    });

    return NextResponse.json(
      {
        type: 'artifact',
        data: attachResponseAliases('artifact', result.artifact),
        artifact_type_fallback: result.artifactTypeFallbackApplied,
        effective_artifact_type: result.effectiveArtifactType,
      },
      { status: 201 }
    );
  } else if (type === 'skill') {
    const ownerForPayload = resolvedOwnerId ?? ownerIdValue;
    if (!ownerForPayload) {
      throw errors.badRequest('Skill requires owner_id');
    }
    payload = buildSkillPayload(ownerForPayload, entityData);
  } else if (type === 'plan_session') {
    const ownerForPayload = resolvedOwnerId ?? ownerIdValue;
    if (!ownerForPayload) {
      throw errors.badRequest('Plan session requires owner_id');
    }
    payload = buildPlanSessionPayload(ownerForPayload, entityData);
  } else if (type === 'studio_brand') {
    // Delegate to studio brand creation (handles SSRF validation, assets, Inngest dispatch)
    const ownerForPayload = resolvedOwnerId ?? ownerIdValue;
    if (!ownerForPayload) {
      throw errors.badRequest('studio_brand requires owner_id');
    }
    const ctx = {
      issueId: '',
      userId: ownerForPayload,
      workspaceId: (entityData.workspace_id as string) ?? null,
    };
    const result = await studioTool.brandIngest(
      {
        sources: entityData.sources as any[],
        brandName: (entityData.name ?? entityData.title) as string | undefined,
        brandId: entityData.brand_id as string | undefined,
        workspaceId: entityData.workspace_id as string | undefined,
        visibility: entityData.visibility as
          | 'private'
          | 'org'
          | 'public'
          | undefined,
        isDefault: entityData.is_default as boolean | undefined,
      },
      ctx
    );
    if (!result.ok) {
      throw errors.badRequest(result.error);
    }
    return NextResponse.json(
      {
        type: 'studio_brand',
        data: attachResponseAliases('studio_brand', result.data),
      },
      { status: 201 }
    );
  } else if (type === 'studio_content') {
    // Delegate to studio content creation (handles brand resolution, Inngest dispatch)
    const ownerForPayload = resolvedOwnerId ?? ownerIdValue;
    if (!ownerForPayload) {
      throw errors.badRequest('studio_content requires owner_id');
    }
    const ctx = {
      issueId: (entityData.run_id as string) ?? '',
      runId: (entityData.run_id as string) ?? null,
      userId: ownerForPayload,
      workspaceId: (entityData.workspace_id as string) ?? null,
    };
    // If content_type is 'video' and a template is specified, use video creation
    if (entityData.content_type === 'video' && entityData.template) {
      const result = await studioVideoTool.videoCreate(
        {
          template: entityData.template as string,
          content: (entityData.content ?? entityData.options ?? {}) as Record<
            string,
            unknown
          >,
          aspectRatio: (entityData.options as any)?.aspectRatio,
          brandId: entityData.brand_id as string | undefined,
          title: (entityData.title ?? entityData.name) as string | undefined,
          runId: entityData.run_id as string | undefined,
        },
        ctx
      );
      if (!result.ok) {
        throw errors.badRequest(result.error);
      }
      return NextResponse.json(
        {
          type: 'studio_content',
          data: attachResponseAliases('studio_content', result.data),
        },
        { status: 201 }
      );
    }
    // Non-video content creation
    const result = await studioTool.contentCreate(
      {
        prompt: entityData.prompt as string | undefined,
        contentType: entityData.content_type as any,
        brandId: entityData.brand_id as string | undefined,
        platform: entityData.platform as any,
        options: entityData.options as any,
        title: (entityData.title ?? entityData.name) as string | undefined,
        runId: entityData.run_id as string | undefined,
      },
      ctx
    );
    if (!result.ok) {
      throw errors.badRequest(result.error);
    }
    return NextResponse.json(
      {
        type: 'studio_content',
        data: attachResponseAliases('studio_content', result.data),
      },
      { status: 201 }
    );
  } else {
    if (type === 'blocker') {
      return createBlockerEntityApiResponse();
    }
    normalizeEconomicsColumnInputs(type as EntityType, entityData);
    // Move Mission Control cross-entity fields into metadata to avoid requiring
    // dedicated columns on every table.
    const createMetaPatch = extractMetadataShadowFields(
      type as EntityType,
      entityData
    );
    if (Object.keys(createMetaPatch).length > 0) {
      const existingMeta = isObjectRecord(entityData.metadata)
        ? (entityData.metadata as Record<string, unknown>)
        : {};
      entityData.metadata = { ...existingMeta, ...createMetaPatch };
    }

    payload = normalizeEntityCreatePayload(
      type as EntityType,
      resolvedOwnerId,
      entityData
    );
  }

  const scopeViolation = await decisionCreateScopeViolation({
    type,
    ownerId: resolvedOwnerId,
    data: payload,
    client: admin as unknown as DecisionScopeClient,
  });
  if (scopeViolation) {
    throw errors.forbidden(
      `Decision ${scopeViolation} must match the authenticated owner and workspace scope.`
    );
  }

  // Validate priority field if provided
  if (entityData.priority !== undefined || payload.priority !== undefined) {
    const priorityVal = (payload.priority ?? entityData.priority) as string;
    const validPriorities = (config as any).validPriorities as
      | string[]
      | undefined;
    if (validPriorities && validPriorities.length > 0) {
      if (!validPriorities.includes(priorityVal)) {
        throw errors.badRequest(
          `Invalid priority '${priorityVal}' for ${type}. Valid values: ${validPriorities.join(
            ', '
          )}`
        );
      }
    } else {
      // Entity type doesn't support priority — strip it
      delete payload.priority;
    }
  }

  // Validate sequence field if provided
  if (entityData.sequence !== undefined || payload.sequence !== undefined) {
    const sequenceVal = payload.sequence ?? entityData.sequence;
    if (HIERARCHY_ENTITY_TYPES.has(type as EntityType)) {
      const normalizedSequence = normalizeSequenceValue(sequenceVal);
      if (normalizedSequence === null) {
        throw errors.badRequest(
          `Invalid sequence '${String(
            sequenceVal
          )}' for ${type}. Sequence must be a non-negative integer.`
        );
      }
      payload.sequence = normalizedSequence;
    } else {
      // Entity type doesn't support sequence — strip it
      delete payload.sequence;
    }
  }

  // Only some entities persist context attachments today.
  // Strip `context` for unsupported types to avoid schema-cache errors.
  if (!CONTEXT_SUPPORTED_TYPES.has(type as EntityType)) {
    delete payload.context;
  }
  if (payload.context !== undefined) {
    if (!Array.isArray(payload.context)) {
      throw errors.badRequest('context must be an array');
    }
    if (payload.context.length > 50) {
      throw errors.badRequest('context may have at most 50 entries');
    }
  }

  // Validate that required label field exists for generic entities
  if (type !== 'skill' && type !== 'plan_session') {
    const labelColumn = ENTITY_LABEL_COLUMN[type as EntityType];
    if (!payload[labelColumn]) {
      throw errors.badRequest(`${type} requires ${labelColumn}`);
    }
  }

  // Validate required foreign keys for specific entity types
  if (type === 'task') {
    const ownerForTask = resolvedOwnerId ?? ownerIdValue;
    if (!ownerForTask) {
      throw errors.badRequest('Task requires owner_id');
    }
    await resolveTaskHierarchyPayload({
      admin,
      payload,
      entityData,
      ownerId: ownerForTask,
      userId: ownerForTask,
    });
  }

  if (type === 'milestone') {
    await resolveMilestoneHierarchyPayload({
      admin,
      payload,
      entityData,
      ownerId: resolvedOwnerId ?? ownerIdValue ?? null,
      userId: resolvedOwnerId ?? ownerIdValue ?? null,
    });
  }

  if (type === 'workstream') {
    const initiativeId = await resolveCreateParentReference({
      admin,
      payload,
      entityData,
      entityType: 'initiative',
      fieldName: 'initiative_id',
      ownerId: resolvedOwnerId ?? ownerIdValue ?? null,
    });
    if (!initiativeId) {
      throw errors.badRequest('Workstream requires initiative_id');
    }

    applyAssignmentDefaultsToPayload({
      payload,
      type: 'workstream',
      sourceHints: [extractAssignmentHints(entityData)],
      fallbackDomainCandidates: [
        payload.persona,
        entityData.persona,
        payload.domain,
        entityData.domain,
      ],
      disableTypeDefault: true,
    });

    const { data: initiativeRow } = initiativeId
      ? await admin
          .from('initiatives')
          .select('id, title, summary, metadata, workspace_id')
          .eq('id', initiativeId)
          .maybeSingle()
      : { data: null };

    // Derive workspace_id from the parent initiative when the caller
    // didn't pass one explicitly. workstreams.workspace_id is NOT NULL, and
    // an MCP client that already named the initiative shouldn't have to
    // round-trip to look up the workspace.
    if (!payload.workspace_id) {
      const parentWorkspaceId =
        (initiativeRow as { workspace_id?: string } | null)?.workspace_id ??
        null;
      if (parentWorkspaceId) {
        payload.workspace_id = parentWorkspaceId;
      }
    }

    await applyIwmtAssignmentFallback({
      payload,
      type: 'workstream',
      userId: resolvedOwnerId ?? ownerIdValue ?? null,
      sourceHints: [extractAssignmentHints(entityData)],
      fallbackDomainCandidates: [
        payload.persona,
        entityData.persona,
        payload.domain,
        entityData.domain,
      ],
      context: {
        initiative: (initiativeRow as Record<string, unknown> | null) ?? null,
        workstream: buildDraftEntityContext(payload, entityData),
      },
    });

    if (!hasAssignedAgentOnPayload(payload)) {
      applyAssignmentDefaultsToPayload({
        payload,
        type: 'workstream',
        sourceHints: [extractAssignmentHints(entityData)],
        fallbackDomainCandidates: [
          payload.persona,
          entityData.persona,
          payload.domain,
          entityData.domain,
        ],
      });
    }
  }
  if (type === 'stream') {
    const initiativeId = await resolveCreateParentReference({
      admin,
      payload,
      entityData,
      entityType: 'initiative',
      fieldName: 'initiative_id',
      ownerId: resolvedOwnerId ?? ownerIdValue ?? null,
    });
    if (!initiativeId) {
      throw errors.badRequest('Stream requires initiative_id');
    }

    const workstreamId = await resolveCreateParentReference({
      admin,
      payload,
      entityData,
      entityType: 'workstream',
      fieldName: 'workstream_id',
      ownerId: resolvedOwnerId ?? ownerIdValue ?? null,
    });

    let workstreamRow: Record<string, unknown> | null = null;
    if (workstreamId) {
      const { data } = await admin
        .from('workstreams')
        .select('id, initiative_id, domain, persona, metadata')
        .eq('id', workstreamId)
        .maybeSingle();
      workstreamRow = (data as Record<string, unknown> | null) ?? null;
      if (
        workstreamRow &&
        typeof workstreamRow.initiative_id === 'string' &&
        initiativeId !== workstreamRow.initiative_id
      ) {
        throw errors.badRequest(
          'Stream initiative_id must match workstream initiative_id'
        );
      }
      if (workstreamRow) {
        const hints = extractAssignmentHints(workstreamRow);
        if (hints.domain) {
          payload.agent_domain = hints.domain;
        }
      }
    }
    if (payload.agent_domain === undefined) {
      payload.agent_domain = 'operations';
    }
  }

  if (type === 'stream' && payload.agent_domain !== undefined) {
    const normalizedAgentDomain = normalizeStreamAgentDomain(
      payload.agent_domain
    );
    if (!normalizedAgentDomain) {
      throw errors.badRequest(
        `Invalid stream agent_domain. Valid values: ${STREAM_AGENT_DOMAINS.join(
          ', '
        )}`
      );
    }
    payload.agent_domain = normalizedAgentDomain;
  }

  if (type === 'initiative') {
    const idempotencyKey = cleanScaffoldIdempotencyKey(payload.idempotency_key);
    if (idempotencyKey) {
      payload.idempotency_key = idempotencyKey;
      const existingInitiative = await findExistingInitiativeByIdempotency({
        admin,
        payload,
      });
      if (existingInitiative) {
        logger.info(
          '[api:entities] initiative idempotency replay: returning existing',
          {
            existingId: existingInitiative.id,
            idempotencyKey,
          }
        );
        return buildInitiativeIdempotencyReplayResponse({
          row: existingInitiative,
          idempotencyKey,
        });
      }
    }
  }

  // Agents can retry a planning step with the same hierarchy names. Reuse the
  // existing sibling instead of inserting duplicate W/M/T rows.
  const dedupedHierarchyTarget = await findExistingHierarchyCreateTarget({
    admin,
    type: type as EntityType,
    payload,
  });
  if (dedupedHierarchyTarget) {
    logger.info('[api:entities] hierarchy create dedup: returning existing', {
      type,
      existingId: dedupedHierarchyTarget.row.id,
      label: dedupedHierarchyTarget.label,
    });
    return buildHierarchyDedupResponse({
      type: type as EntityType,
      row: dedupedHierarchyTarget.row,
      label: dedupedHierarchyTarget.label,
    });
  }

  const { data, error } = await admin
    .from(config.table)
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    const goalInvariantType =
      type === 'initiative' ||
      type === 'workstream' ||
      type === 'milestone' ||
      type === 'task'
        ? type
        : null;

    if (goalInvariantType && isGoalInvariantViolation(error)) {
      await maybeRecordGoalInvariantViolation({
        error,
        entityType: goalInvariantType,
        workspaceId:
          typeof payload.workspace_id === 'string'
            ? payload.workspace_id
            : null,
        userId: resolvedOwnerId,
        attemptedFields: Object.keys(payload),
      });
      throw errors.badRequest(
        `This workspace requires every ${goalInvariantType} to declare a primary goal. Add at least one goal_id to goal_ids before retrying.`
      );
    }

    logger.error(`[api:entities] failed to create ${type}`, {
      error: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      payload: Object.keys(payload), // Log field names to help debug missing fields
    });

    // Provide more specific error messages for common constraint violations
    if (error.code === '23503') {
      // foreign_key_violation
      const match = error.message?.match(/Key \((\w+)\)=/);
      const field = match?.[1] ?? 'foreign key';
      throw errors.badRequest(
        `Invalid ${field}: referenced record does not exist`
      );
    }
    if (error.code === '23502') {
      // not_null_violation
      const match = error.message?.match(/column "(\w+)"/);
      const field = match?.[1] ?? 'required field';
      throw errors.badRequest(`Missing required field: ${field}`);
    }
    if (error.code === '23505') {
      // unique_violation
      throw errors.conflict(`${type} already exists with these values`);
    }
    if (error.code === 'PGRST204') {
      // Unknown column — extract the column name for actionable feedback
      const colMatch = error.message?.match(
        /Could not find the '(\w+)' column/
      );
      const col = colMatch?.[1] ?? 'unknown';
      throw errors.badRequest(
        `Field '${col}' is not valid for entity type '${type}'. Remove it and retry.`
      );
    }
    if (error.code === '23514') {
      // Check constraint violation (e.g., invalid status value)
      const constraintMatch = error.message?.match(
        /violates check constraint "(\w+)"/
      );
      const constraint = constraintMatch?.[1] ?? '';
      const entityConfig = ENTITY_CONFIG[type as EntityType];
      if (constraint.includes('status') && entityConfig?.validStatuses) {
        throw errors.badRequest(
          `Invalid status for ${type}. Valid values: ${entityConfig.validStatuses.join(
            ', '
          )}`
        );
      }
      throw errors.badRequest(
        `Value violates constraint for ${type}. Check that all field values are valid.`
      );
    }

    // Fallback: include the Postgres message + hint so agents calling this
    // endpoint can self-diagnose instead of seeing a generic wall. The
    // detailed error is ALSO logged server-side above for human review.
    const fallbackParts = [`Failed to create ${type}`];
    if (error.message) fallbackParts.push(error.message);
    if (error.hint) fallbackParts.push(`hint: ${error.hint}`);
    throw errors.internal(fallbackParts.join(' — '));
  }

  let initiativeActivation: InitiativeActivationSummary | null = null;

  if (type === 'initiative' && data) {
    const initiativeRow = data as any;
    try {
      await emitEntityEvent('initiative_created', {
        initiativeId: initiativeRow.id,
        ownerId: initiativeRow.owner_id ?? resolvedOwnerId,
        workspaceId:
          initiativeRow.workspace_id ??
          (entityData as any).workspace_id ??
          null,
      });
    } catch (emitError) {
      logger.warn('[api:entities] failed to emit initiative_created', {
        initiativeId: initiativeRow.id,
        error:
          emitError instanceof Error ? emitError.message : String(emitError),
      });
    }

    const shouldAutoPlan = autoPlanOverride !== null ? autoPlanOverride : true;
    if (shouldAutoPlan) {
      await kickoffInitiativePlanningRun({
        admin,
        initiative: initiativeRow as any,
        ownerId: initiativeRow.owner_id ?? resolvedOwnerId,
        workspaceId:
          initiativeRow.workspace_id ??
          (entityData as any).workspace_id ??
          null,
        projectId: overrideProjectId ?? undefined,
        autoPlan: shouldAutoPlan,
        agenticWorkstreams: agenticOverride ?? undefined,
        source: 'api_entities',
      });
    }

    initiativeActivation = await maybeActivateInitiative({
      admin,
      initiativeId:
        typeof initiativeRow.id === 'string' ? initiativeRow.id : null,
      statusHint: initiativeRow.status,
      titleHint: initiativeRow.title,
      sourceContext: 'entities.create.initiative',
    });
  } else if (type === 'workstream' && data) {
    const workstreamRow = data as Record<string, unknown>;
    initiativeActivation = await maybeActivateInitiative({
      admin,
      initiativeId:
        typeof workstreamRow.initiative_id === 'string'
          ? workstreamRow.initiative_id
          : null,
      sourceContext: 'entities.create.workstream',
    });
  }

  return NextResponse.json({
    type,
    data: attachResponseAliases(type as EntityType, data),
    ...(initiativeActivation
      ? { initiative_activation: initiativeActivation }
      : {}),
  });
};

/**
 * PATCH /api/entities
 * Update an existing entity
 */
const patchHandler: ApiHandler = async (request: Request) => {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw errors.serviceUnavailable('Database connection unavailable');
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    throw errors.badRequest('Invalid JSON body');
  }

  const readRefLikeString = (value: unknown): string | null => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const ref = (value as Record<string, unknown>).$ref;
      if (typeof ref === 'string' && ref.trim().length > 0) {
        return ref.trim();
      }
    }
    return null;
  };

  const {
    type: requestedType,
    id: rawId,
    ...updateData
  } = body as Record<string, unknown>;
  const id = readRefLikeString(rawId) ?? rawId;

  const resolvedWorkspaceId = resolveWorkspaceIdAlias({
    workspaceId: updateData.workspace_id,
    sourceLabel: 'request body',
  });
  if (resolvedWorkspaceId) {
    updateData.workspace_id = resolvedWorkspaceId;
  } else {
    delete updateData.workspace_id;
  }

  assertRequired(requestedType, 'type');
  assertString(requestedType, 'type');
  const type = normalizeEntityTypeAlias(requestedType);
  assertRequired(id, 'id');
  assertString(id, 'id');

  if (!isValidEntityType(type as string)) {
    throw errors.badRequest(
      `Invalid entity type: ${type}. Valid types: ${Object.keys(
        ENTITY_CONFIG
      ).join(', ')}`
    );
  }
  const updateViolation = decisionUpdateLifecycleViolation(type, updateData);
  if (updateViolation) {
    throw errors.forbidden(directHumanDecisionActionMessage(updateViolation));
  }
  const runUpdateViolation = directRunLifecycleViolation(type, updateData);
  if (runUpdateViolation) throw errors.forbidden(runUpdateViolation);
  const config = ENTITY_CONFIG[type as EntityType];
  if (type === 'blocker') {
    throw errors.forbidden(
      'Blockers cannot be patched directly. Use the resolve or dismiss lifecycle action.'
    );
  }
  const requestedId = id as string;
  const syntheticUpdateRef = isSyntheticEntityReferenceId(requestedId)
    ? { field: 'id', value: requestedId.trim() }
    : findSyntheticReferenceField(updateData, [
        'initiative_id',
        'workstream_id',
        'milestone_id',
        'entity_id',
      ]);
  const syntheticUpdateNoop = maybeBuildSyntheticReferenceNoop({
    request,
    type: type as string,
    operation: 'update',
    syntheticRef: syntheticUpdateRef,
  });
  if (syntheticUpdateNoop) {
    return syntheticUpdateNoop;
  }

  const scopedUserIdCandidate =
    readRefLikeString(updateData.user_id) ??
    readRefLikeString(updateData.owner_id);

  let serviceAuthorized = false;
  try {
    serviceAuthorized = !ensureServiceRequestAuthorized(request);
  } catch {
    serviceAuthorized = false;
  }

  const apiKeyAuth = !serviceAuthorized
    ? await authenticateApiKey(request)
    : null;

  let effectiveScopedUserId: string | null = null;
  if (serviceAuthorized) {
    effectiveScopedUserId =
      scopedUserIdCandidate ?? extractGatewayUserId(request);
  } else {
    effectiveScopedUserId = apiKeyAuth?.userId ?? null;

    if (scopedUserIdCandidate && effectiveScopedUserId) {
      const resolvedScopedCandidate = await resolveOwnerId(
        scopedUserIdCandidate
      );
      if (resolvedScopedCandidate !== effectiveScopedUserId) {
        throw errors.forbidden('user_id does not match API key identity');
      }
    }
  }

  const resolvedUpdateUserId = effectiveScopedUserId
    ? await resolveOwnerId(effectiveScopedUserId, {
        gatewayEmail: serviceAuthorized
          ? extractGatewayUserEmail(request)
          : null,
        gatewayOrgxUserId: resolveGatewayOrgxUserIdHint(
          request,
          effectiveScopedUserId,
          serviceAuthorized
        ),
      })
    : null;

  if (type === 'decision' && (!serviceAuthorized || !resolvedUpdateUserId)) {
    throw errors.forbidden(
      'Decision proposal updates require a trusted service writer with an authenticated owner scope or a dedicated owner-scoped proposal command.'
    );
  }

  const { id: entityId, resolvedByReference } = await resolveEntityIdReference({
    adminClient: admin as any,
    entityType: type as string,
    inputId: requestedId,
    fieldLabel: 'id',
  });
  if (resolvedByReference) {
    logger.info('[api:entities] resolved reference id for update', {
      type,
      requestedId,
      resolvedId: entityId,
    });
  }
  let decisionProposalScope: PendingDecisionProposalUpdateScope | null = null;
  if (type === 'decision' && resolvedUpdateUserId) {
    const scopeResult = await resolvePendingDecisionProposalUpdateScope({
      client: admin as unknown as DecisionScopeClient,
      decisionId: entityId,
      ownerId: resolvedUpdateUserId,
    });
    if (!scopeResult.ok) {
      if (scopeResult.reason === 'query_failed') {
        throw errors.internal('Failed to verify Decision proposal scope');
      }
      if (scopeResult.reason === 'not_pending') {
        throw errors.conflict('Only pending Decision proposals may be edited.');
      }
      throw errors.notFound(`decision with ID ${requestedId} not found`);
    }
    decisionProposalScope = scopeResult.scope;
  }
  let streamBefore: {
    id: string;
    initiative_id: string | null;
    status: string | null;
    auto_continue: boolean | null;
    current_job_id: string | null;
    agent_domain: string | null;
  } | null = null;
  let requestedStreamDomain: (typeof STREAM_AGENT_DOMAINS)[number] | null =
    null;

  if (type === 'stream') {
    const agentDomainRaw = updateData.agent_domain ?? updateData.agentDomain;
    if (agentDomainRaw !== undefined) {
      const normalizedAgentDomain = normalizeStreamAgentDomain(agentDomainRaw);
      if (!normalizedAgentDomain) {
        throw errors.badRequest(
          `Invalid stream agent_domain. Valid values: ${STREAM_AGENT_DOMAINS.join(
            ', '
          )}`
        );
      }
      updateData.agent_domain = normalizedAgentDomain;
      requestedStreamDomain = normalizedAgentDomain;
    }
    delete updateData.agentDomain;

    const { data: existingStream, error: existingStreamError } = await admin
      .from('streams')
      .select(
        'id, initiative_id, status, auto_continue, current_job_id, agent_domain'
      )
      .eq('id', entityId)
      .maybeSingle();

    if (existingStreamError) {
      logger.error('[api:entities] failed to load stream before update', {
        error: existingStreamError.message,
        code: existingStreamError.code,
        streamId: entityId,
      });
      throw errors.internal('Failed to update stream');
    }
    if (!existingStream) {
      throw errors.notFound(`stream with ID ${requestedId} not found`);
    }
    streamBefore = existingStream as {
      id: string;
      initiative_id: string | null;
      status: string | null;
      auto_continue: boolean | null;
      current_job_id: string | null;
      agent_domain: string | null;
    };
  }

  // Validate priority field if provided
  if (updateData.priority !== undefined) {
    const validPriorities = (config as any).validPriorities as
      | string[]
      | undefined;
    if (validPriorities && validPriorities.length > 0) {
      if (!validPriorities.includes(updateData.priority as string)) {
        throw errors.badRequest(
          `Invalid priority '${
            updateData.priority
          }' for ${type}. Valid values: ${validPriorities.join(', ')}`
        );
      }
    } else {
      // Entity type doesn't support priority — strip it to avoid DB error
      delete updateData.priority;
    }
  }

  // Validate sequence field if provided
  if (updateData.sequence !== undefined) {
    if (HIERARCHY_ENTITY_TYPES.has(type as EntityType)) {
      const normalizedSequence = normalizeSequenceValue(updateData.sequence);
      if (normalizedSequence === null) {
        throw errors.badRequest(
          `Invalid sequence '${String(
            updateData.sequence
          )}' for ${type}. Sequence must be a non-negative integer.`
        );
      }
      updateData.sequence = normalizedSequence;
    } else {
      // Entity type doesn't support sequence — strip it to avoid DB error
      delete updateData.sequence;
    }
  }

  // Move Mission Control cross-entity fields into metadata so they can be
  // persisted without dedicated columns on every table.
  normalizeEconomicsColumnInputs(type as EntityType, updateData);
  const shadowMetaPatch = extractMetadataShadowFields(
    type as EntityType,
    updateData
  );

  const payload = normalizeEntityUpdatePayload(type as EntityType, updateData);

  const updateReferenceFieldsByType: Partial<Record<EntityType, string[]>> = {
    artifact: ['entity_id', 'initiative_id'],
    milestone: ['initiative_id', 'workstream_id'],
    task: ['initiative_id', 'workstream_id', 'milestone_id'],
    workstream: ['initiative_id'],
    stream: ['initiative_id', 'workstream_id'],
  };
  for (const fieldName of updateReferenceFieldsByType[type as EntityType] ??
    []) {
    const rawValue = payload[fieldName];
    const refValue = readRefLikeString(rawValue);
    if (!refValue) continue;
    const entityTypeForField =
      fieldName === 'initiative_id'
        ? 'initiative'
        : fieldName === 'workstream_id'
        ? 'workstream'
        : fieldName === 'milestone_id'
        ? 'milestone'
        : fieldName === 'entity_id'
        ? typeof payload.entity_type === 'string'
          ? payload.entity_type
          : null
        : null;
    if (!entityTypeForField) {
      payload[fieldName] = refValue;
      continue;
    }
    const resolved = await resolveEntityIdReference({
      adminClient: admin as unknown as SupabaseDbClient,
      entityType: entityTypeForField,
      inputId: refValue,
      fieldLabel: fieldName,
    });
    payload[fieldName] = resolved.id;
  }

  // Only some entities persist context attachments today.
  // Strip `context` for unsupported types to avoid schema-cache errors.
  if (!CONTEXT_SUPPORTED_TYPES.has(type as EntityType)) {
    delete payload.context;
  }
  if (payload.context !== undefined) {
    if (!Array.isArray(payload.context)) {
      throw errors.badRequest('context must be an array');
    }
    if (payload.context.length > 50) {
      throw errors.badRequest('context may have at most 50 entries');
    }
  }

  if (Object.keys(shadowMetaPatch).length > 0) {
    const { data: existingRow, error: existingError } = await admin
      .from(config.table)
      .select('metadata')
      .eq('id', entityId)
      .maybeSingle();

    if (existingError) {
      logger.error(`[api:entities] failed to load ${type} metadata`, {
        error: existingError.message,
        code: existingError.code,
      });
      throw errors.internal('Failed to update entity metadata');
    }

    const existingMeta = isObjectRecord(existingRow?.metadata)
      ? (existingRow?.metadata as Record<string, unknown>)
      : {};
    const providedMeta = isObjectRecord(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : {};
    payload.metadata = { ...existingMeta, ...providedMeta, ...shadowMetaPatch };
  }

  const requestedTaskStatus =
    type === 'task' && typeof payload.status === 'string'
      ? payload.status.trim().toLowerCase()
      : null;
  const protectCompletedTask =
    type === 'task' &&
    requestedTaskStatus !== null &&
    !isTerminalTaskStatus(requestedTaskStatus);

  assertArtifactStatusWritable(type, payload.status);

  let updateQuery = admin.from(config.table).update(payload).eq('id', entityId);
  if (decisionProposalScope) {
    updateQuery = updateQuery
      .eq('owner_id', decisionProposalScope.ownerId)
      .eq('workspace_id', decisionProposalScope.workspaceId)
      .eq('status', 'pending');
  } else if (
    !serviceAuthorized &&
    resolvedUpdateUserId &&
    OWNER_FILTER_SUPPORTED_TYPES.has(type as EntityType)
  ) {
    updateQuery = updateQuery.eq('owner_id', resolvedUpdateUserId);
  }
  if (protectCompletedTask) {
    updateQuery = updateQuery.neq('status', 'done');
  }

  const { data: updatedEntity, error } = await updateQuery
    .select(config.select)
    .single();
  let data = updatedEntity;

  if (error) {
    logger.error(`[api:entities] failed to update ${type}`, {
      error: error.message,
      code: error.code,
      details: error.details,
    });

    if (error.code === 'PGRST116' && protectCompletedTask) {
      const { data: currentTask } = await admin
        .from(config.table)
        .select('id, status')
        .eq('id', entityId)
        .maybeSingle();
      if (isTerminalTaskStatus(currentTask?.status)) {
        throw errors.conflict(
          "Completed tasks are terminal for automated updates. Use the task 'reopen' action for an intentional transition."
        );
      }
    }
    if (error.code === 'PGRST116' && decisionProposalScope) {
      throw errors.conflict(
        'The Decision proposal changed scope or is no longer pending.'
      );
    }
    if (error.code === 'PGRST116') {
      throw errors.notFound(`${type} with ID ${requestedId} not found`);
    }
    if (error.code === 'PGRST204') {
      const colMatch = error.message?.match(
        /Could not find the '(\w+)' column/
      );
      const col = colMatch?.[1] ?? 'unknown';
      throw errors.badRequest(
        `Field '${col}' is not valid for entity type '${type}'. Remove it and retry.`
      );
    }
    if (error.code === '23503') {
      const match = error.message?.match(/Key \((\w+)\)=/);
      const field = match?.[1] ?? 'foreign key';
      throw errors.badRequest(
        `Invalid ${field}: referenced record does not exist`
      );
    }
    if (error.code === '23514') {
      // Check constraint violation (e.g., invalid status value)
      const constraintMatch = error.message?.match(
        /violates check constraint "(\w+)"/
      );
      const constraint = constraintMatch?.[1] ?? '';
      // If it's a status constraint, provide valid values
      if (constraint.includes('status') && config?.validStatuses) {
        throw errors.badRequest(
          `Invalid status for ${type}. Valid values: ${config.validStatuses.join(
            ', '
          )}`
        );
      }
      throw errors.badRequest(
        `Value violates constraint for ${type}. Check that all field values are valid.`
      );
    }
    if (error.code === '22P02') {
      throw errors.badRequest(
        `Invalid id format for ${type}. Use a UUID or a known metadata reference.`
      );
    }
    throw errors.internal(
      `Failed to update ${type}. Check that all provided fields are valid for this entity type and that referenced IDs exist.`
    );
  }

  let streamReassignment: {
    stream_id: string;
    changed: boolean;
    previous_domain: string | null;
    next_domain: string | null;
    status_before: string | null;
    status_after: string | null;
    redispatched: boolean;
    reason?: string;
  } | null = null;
  let initiativeActivation: InitiativeActivationSummary | null = null;

  if (type === 'initiative') {
    const initiativeRow = data as Record<string, unknown>;
    initiativeActivation = await maybeActivateInitiative({
      admin,
      initiativeId:
        typeof initiativeRow.id === 'string' ? initiativeRow.id : entityId,
      statusHint: initiativeRow.status,
      titleHint: initiativeRow.title,
      sourceContext: 'entities.patch.initiative',
    });
  }

  if (type === 'stream' && streamBefore && requestedStreamDomain) {
    const before = streamBefore as {
      id: string;
      initiative_id: string | null;
      status: string | null;
      auto_continue: boolean | null;
      current_job_id: string | null;
      agent_domain: string | null;
    };
    const previousDomain =
      typeof before.agent_domain === 'string' ? before.agent_domain : null;
    const nextDomain =
      typeof (data as Record<string, unknown>)?.agent_domain === 'string'
        ? ((data as Record<string, unknown>).agent_domain as string)
        : requestedStreamDomain;
    const statusBefore =
      typeof before.status === 'string' ? before.status : null;
    let statusAfter =
      typeof (data as Record<string, unknown>)?.status === 'string'
        ? ((data as Record<string, unknown>).status as string)
        : statusBefore;

    const changed = previousDomain !== nextDomain;
    let redispatched = false;
    let reason: string | undefined;

    if (changed) {
      const initiativeId =
        typeof (data as Record<string, unknown>)?.initiative_id === 'string'
          ? ((data as Record<string, unknown>).initiative_id as string)
          : before.initiative_id;
      const autoContinue =
        typeof (data as Record<string, unknown>)?.auto_continue === 'boolean'
          ? ((data as Record<string, unknown>).auto_continue as boolean)
          : before.auto_continue ?? true;
      const hasActiveJob =
        typeof before.current_job_id === 'string' &&
        before.current_job_id.trim().length > 0;

      if (!autoContinue) {
        reason = 'auto_continue disabled';
      } else if (!initiativeId) {
        reason = 'missing initiative_id';
      } else if (statusAfter === 'active' && hasActiveJob) {
        reason = 'stream has active job in flight';
      } else if (statusAfter === 'active') {
        const { data: promoted, error: promoteError } = await admin
          .from('streams')
          .update({
            status: 'ready',
            current_job_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', entityId)
          .eq('status', 'active')
          .select(config.select)
          .maybeSingle();

        if (promoteError) {
          logger.warn(
            '[api:entities] failed to promote stream for redispatch',
            {
              streamId: entityId,
              error: promoteError.message,
              code: promoteError.code,
            }
          );
          reason = 'failed to promote stream to ready';
        } else if (promoted) {
          data = promoted;
          statusAfter =
            typeof (data as Record<string, unknown>)?.status === 'string'
              ? ((data as Record<string, unknown>).status as string)
              : 'ready';
        }
      }

      if (!reason && statusAfter === 'ready') {
        try {
          await publishStreamTransition(admin as any, {
            streamId: entityId,
            initiativeId,
            eventName: 'stream.ready',
            newStatus: 'ready',
            autoContinue: true,
            triggeredBy: 'user',
            data: {
              source: 'entities_reassign',
            },
          });
          redispatched = true;
        } catch (dispatchError) {
          logger.warn(
            '[api:entities] failed to enqueue stream.ready after reassignment',
            {
              streamId: entityId,
              initiativeId,
              error:
                dispatchError instanceof Error
                  ? dispatchError.message
                  : String(dispatchError),
            }
          );
          reason = 'failed to enqueue stream.ready';
        }
      } else if (!reason) {
        reason = `stream status '${
          statusAfter ?? 'unknown'
        }' not redispatchable`;
      }
    }

    streamReassignment = {
      stream_id: entityId,
      changed,
      previous_domain: previousDomain,
      next_domain: nextDomain,
      status_before: statusBefore,
      status_after: statusAfter,
      redispatched,
      ...(reason ? { reason } : {}),
    };
  }

  return NextResponse.json({
    type,
    data: attachResponseAliases(type as EntityType, data),
    ...(initiativeActivation
      ? { initiative_activation: initiativeActivation }
      : {}),
    ...(streamReassignment ? { stream_reassignment: streamReassignment } : {}),
  });
};

const compatibilityRoute = (handler: ApiHandler) => async (
  request: NextRequest,
  context: { params: Promise<Record<string, string | string[]>> }
) => {
  const unauthorized = await ensureServiceOrApiAuthorized(request);
  if (unauthorized) return markCompatibilityResponse(unauthorized);
  return markCompatibilityResponse(
    await toRoute(compose()(handler))(request, context)
  );
};

export const GET = compatibilityRoute(getHandler);
export const POST = compatibilityRoute(postHandler);
export const PATCH = compatibilityRoute(patchHandler);
