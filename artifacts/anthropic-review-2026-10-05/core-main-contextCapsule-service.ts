import type { SupabaseClient } from '@supabase/supabase-js';
import { buildSnapshotContextCapsule } from './snapshotService';

import { errors } from '@/lib/server/apiErrors';
import { ACCEPTED_DECISION_CANDIDATE_SCAN_LIMIT } from '@/lib/server/decisions/currentAcceptedDecisions';
import { RUN_RECEIPT_COVERAGE_REGISTRY_ID } from '@/lib/server/expectations/metricExpectation';
import {
  exactOrgxRequestRef,
  isExactAutomaticSessionReceipt,
} from '@/lib/server/reporting/automaticSessionReceiptLineage';
import {
  CONTEXT_CAPSULE_LIMITS,
  CONTEXT_CAPSULE_OPEN_INITIATIVE_STATUSES,
  GENERIC_DECISION_SHAPE,
  compileWorkspaceContextCapsule,
} from './compile';
import type {
  ContextCapsule,
  ContextCapsuleDecisionRow,
  ContextCapsuleExpectationRow,
  ContextCapsuleLearningRow,
  ContextCapsuleReceiptRow,
  ContextCapsuleRiskRow,
  ContextCapsuleSessionRow,
} from './types';

type Row = Record<string, unknown>;

const RECEIPT_VALIDATION_SCAN_LIMIT = 64;
const SESSION_CONTEXT_SCAN_LIMIT = 16;

function globalSequence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function buildWorkspaceContextCapsule(input: {
  admin: SupabaseClient;
  ownerId: string;
  workspaceId: string;
  initiativeId?: string;
  workstreamId?: string;
  taskId?: string;
  generatedAt: string;
  /** Explicit legacy mode is retained for rollback and semantic parity tests. */
  consistency?: 'database_snapshot' | 'best_effort_multi_read';
}): Promise<ContextCapsule> {
  if (
    input.consistency === 'database_snapshot' ||
    (input.consistency !== 'best_effort_multi_read' &&
      process.env.ORGX_CONTEXT_SNAPSHOT_READS !== '0')
  )
    return buildSnapshotContextCapsule(input);
  const { data: workspace, error: workspaceError } = await input.admin
    .from('workspaces')
    .select('id')
    .eq('id', input.workspaceId)
    .eq('owner_id', input.ownerId)
    .maybeSingle();
  if (workspaceError) {
    throw errors.internal(
      `Failed to resolve workspace: ${workspaceError.message}`
    );
  }
  if (!workspace) throw errors.notFound('Workspace not found');

  let effectiveInitiativeId = input.initiativeId;
  let effectiveWorkstreamId = input.workstreamId;
  if (input.initiativeId && !input.taskId && !input.workstreamId) {
    const { data: initiative, error: initiativeError } = await input.admin
      .from('initiatives')
      .select('workspace_id')
      .eq('id', input.initiativeId)
      .eq('owner_id', input.ownerId)
      .maybeSingle();
    if (initiativeError) {
      throw errors.internal(
        `Failed to resolve initiative: ${initiativeError.message}`
      );
    }
    if (
      String((initiative as Row | null)?.workspace_id ?? '') !==
      input.workspaceId
    ) {
      throw errors.notFound('Initiative not found');
    }
  }
  if (input.workstreamId) {
    const { data: workstream, error: workstreamError } = await input.admin
      .from('workstreams')
      .select('id, initiative_id, workspace_id')
      .eq('id', input.workstreamId)
      .eq('owner_id', input.ownerId)
      .maybeSingle();
    if (workstreamError) {
      throw errors.internal(
        `Failed to resolve workstream: ${workstreamError.message}`
      );
    }
    if (!workstream) throw errors.notFound('Workstream not found');
    const workstreamRow = workstream as Row;
    const workstreamInitiativeId = String(workstreamRow.initiative_id ?? '');
    if (
      !workstreamInitiativeId ||
      (input.initiativeId && input.initiativeId !== workstreamInitiativeId)
    ) {
      throw errors.badRequest('Workstream and initiative scope disagree');
    }
    const { data: initiative, error: initiativeError } = await input.admin
      .from('initiatives')
      .select('workspace_id')
      .eq('id', workstreamInitiativeId)
      .eq('owner_id', input.ownerId)
      .maybeSingle();
    if (initiativeError) {
      throw errors.internal(
        `Failed to resolve workstream initiative: ${initiativeError.message}`
      );
    }
    const initiativeWorkspaceId = String(
      (initiative as Row | null)?.workspace_id ?? ''
    );
    const workstreamWorkspaceId = String(workstreamRow.workspace_id ?? '');
    if (
      !initiativeWorkspaceId ||
      (workstreamWorkspaceId &&
        workstreamWorkspaceId !== initiativeWorkspaceId) ||
      initiativeWorkspaceId !== input.workspaceId
    ) {
      throw errors.notFound('Workstream not found');
    }
    effectiveInitiativeId = workstreamInitiativeId;
  }
  if (input.taskId) {
    const { data: task, error: taskError } = await input.admin
      .from('workstream_tasks')
      .select('id, initiative_id, workstream_id, workspace_id')
      .eq('id', input.taskId)
      .eq('owner_id', input.ownerId)
      .maybeSingle();
    if (taskError) {
      throw errors.internal(`Failed to resolve task: ${taskError.message}`);
    }
    if (!task) throw errors.notFound('Task not found');
    const taskRow = task as Row;
    const taskInitiativeId = String(taskRow.initiative_id ?? '');
    const taskWorkstreamId = String(taskRow.workstream_id ?? '');
    if (
      !taskInitiativeId ||
      !taskWorkstreamId ||
      (input.initiativeId && input.initiativeId !== taskInitiativeId)
    ) {
      throw errors.badRequest('Task and initiative scope disagree');
    }
    if (input.workstreamId && input.workstreamId !== taskWorkstreamId) {
      throw errors.badRequest('Task and workstream scope disagree');
    }
    const { data: workstream, error: workstreamError } = await input.admin
      .from('workstreams')
      .select('initiative_id, workspace_id')
      .eq('id', taskWorkstreamId)
      .eq('owner_id', input.ownerId)
      .maybeSingle();
    if (workstreamError) {
      throw errors.internal(
        `Failed to resolve task workstream: ${workstreamError.message}`
      );
    }
    const workstreamRow = workstream as Row | null;
    if (String(workstreamRow?.initiative_id ?? '') !== taskInitiativeId) {
      throw errors.notFound('Task not found');
    }
    const { data: initiative, error: initiativeError } = await input.admin
      .from('initiatives')
      .select('workspace_id')
      .eq('id', taskInitiativeId)
      .eq('owner_id', input.ownerId)
      .maybeSingle();
    if (initiativeError) {
      throw errors.internal(
        `Failed to resolve task initiative: ${initiativeError.message}`
      );
    }
    const initiativeWorkspaceId = String(
      (initiative as Row | null)?.workspace_id ?? ''
    );
    const taskWorkspaceId = String(taskRow.workspace_id ?? '');
    const workstreamWorkspaceId = String(workstreamRow?.workspace_id ?? '');
    if (
      !initiativeWorkspaceId ||
      (taskWorkspaceId && taskWorkspaceId !== initiativeWorkspaceId) ||
      (workstreamWorkspaceId &&
        workstreamWorkspaceId !== initiativeWorkspaceId) ||
      initiativeWorkspaceId !== input.workspaceId
    ) {
      throw errors.notFound('Task not found');
    }
    effectiveInitiativeId = taskInitiativeId;
    effectiveWorkstreamId = taskWorkstreamId;
  }

  let decisions = input.admin
    .from('decision_requests')
    .select(
      'id, owner_id, workspace_id, initiative_id, workstream_id, title, status, resolution_summary, resolution_context, resolved_at, resolved_by, updated_at, metadata',
      { count: 'exact' }
    )
    .eq('workspace_id', input.workspaceId)
    .eq('owner_id', input.ownerId)
    .eq('status', 'approved')
    .not('resolution_summary', 'is', null)
    .not('resolved_at', 'is', null)
    .not('resolved_by', 'is', null)
    .order('resolved_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(ACCEPTED_DECISION_CANDIDATE_SCAN_LIMIT);
  if (effectiveInitiativeId)
    decisions = decisions.eq('initiative_id', effectiveInitiativeId);
  if (input.taskId) {
    decisions = decisions
      .eq('workstream_id', effectiveWorkstreamId)
      .eq('metadata->>task_id', input.taskId);
  } else if (effectiveWorkstreamId) {
    decisions = decisions
      .eq('workstream_id', effectiveWorkstreamId)
      .is('metadata->>task_id', null);
  } else if (effectiveInitiativeId) {
    decisions = decisions
      .is('workstream_id', null)
      .is('metadata->>task_id', null);
  } else {
    decisions = decisions
      .is('initiative_id', null)
      .is('workstream_id', null)
      .is('metadata->>task_id', null);
  }

  const expectations = input.admin
    .from('metric_expectations')
    .select(
      'id, metric_registry_id, predicate_operator, predicate_threshold, ' +
        'minimum_sample_size, window_ends_at, state, activated_at',
      { count: 'exact' }
    )
    .eq('workspace_id', input.workspaceId)
    .eq('owner_id', input.ownerId)
    .eq('metric_registry_id', RUN_RECEIPT_COVERAGE_REGISTRY_ID)
    .eq('state', 'pending')
    .order('activated_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(CONTEXT_CAPSULE_LIMITS.pending_expectations);

  const learnings = input.admin
    .from('learned_preferences')
    .select(
      'id, agent_slug, decision_shape, resolution, observed_count, last_observed_at',
      { count: 'exact' }
    )
    .eq('workspace_id', input.workspaceId)
    .eq('user_id', input.ownerId)
    // A generic-shape row only tallies approvals; it carries no lesson an
    // agent could apply, so it must not be presented as an applied learning.
    .neq('decision_shape', GENERIC_DECISION_SHAPE)
    .order('last_observed_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(CONTEXT_CAPSULE_LIMITS.applied_learnings);

  let risks = input.admin
    .from('initiatives')
    .select('id, title, risk_level, status, updated_at', { count: 'exact' })
    .eq('workspace_id', input.workspaceId)
    .eq('owner_id', input.ownerId)
    .in('risk_level', [
      'at_risk',
      'off_track',
      'medium',
      'key',
      'high',
      'critical',
    ])
    .in('status', [...CONTEXT_CAPSULE_OPEN_INITIATIVE_STATUSES])
    .order('updated_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(CONTEXT_CAPSULE_LIMITS.open_risks);
  if (effectiveInitiativeId) risks = risks.eq('id', effectiveInitiativeId);

  let receipts = input.admin
    .from('execution_receipts')
    .select(
      'id, workspace_id, initiative_id, receipt_type, ref_id, source_sub_type, context_used, status, completed_at',
      { count: 'exact' }
    )
    .eq('workspace_id', input.workspaceId)
    .eq('receipt_type', 'autonomous_action')
    .eq('source_sub_type', 'session_summary')
    .eq('status', 'completed')
    .eq('context_used->>admission_path', 'automatic_session_summary')
    .not('completed_at', 'is', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(RECEIPT_VALIDATION_SCAN_LIMIT);
  if (effectiveInitiativeId) {
    receipts = receipts.eq('initiative_id', effectiveInitiativeId);
  }
  if (input.taskId) {
    receipts = receipts
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>type',
        'task'
      )
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>id',
        input.taskId
      );
  } else if (effectiveWorkstreamId) {
    receipts = receipts
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>type',
        'workstream'
      )
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>id',
        effectiveWorkstreamId
      );
  } else if (effectiveInitiativeId) {
    receipts = receipts
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>type',
        'initiative'
      )
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>id',
        effectiveInitiativeId
      );
  } else {
    receipts = receipts
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>type',
        'workspace'
      )
      .eq(
        'context_used->agent_work_receipt->intent->request_ref->>id',
        input.workspaceId
      );
  }

  let sessions = input.admin
    .from('conversation_sessions')
    .select('id, session_summary, last_activity_at, updated_at', {
      count: 'exact',
    })
    .eq('workspace_id', input.workspaceId)
    .eq('owner_id', input.ownerId)
    .eq('interaction_context->>admission_state', 'admitted');
  sessions = input.taskId
    ? sessions.eq('interaction_context->>task_id', input.taskId)
    : sessions.is('interaction_context->>task_id', null);
  sessions = effectiveWorkstreamId
    ? sessions.eq('interaction_context->>workstream_id', effectiveWorkstreamId)
    : sessions.is('interaction_context->>workstream_id', null);
  sessions = effectiveInitiativeId
    ? sessions.eq('initiative_id', effectiveInitiativeId)
    : sessions.is('initiative_id', null);
  sessions = sessions
    .order('last_activity_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(SESSION_CONTEXT_SCAN_LIMIT);

  const [
    decisionResult,
    learningResult,
    expectationResult,
    receiptResult,
    sessionResult,
    riskResult,
    sequenceResult,
  ] = await Promise.all([
    decisions,
    learnings,
    expectations,
    receipts,
    sessions,
    risks,
    input.admin
      .from('org_events')
      .select('global_sequence')
      .eq('workspace_id', input.workspaceId)
      .order('global_sequence', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const result of [
    decisionResult,
    learningResult,
    expectationResult,
    receiptResult,
    sessionResult,
    riskResult,
    sequenceResult,
  ]) {
    if (result.error) {
      throw errors.internal(
        `Failed to compile context capsule: ${result.error.message}`
      );
    }
  }

  const receiptCandidates = (receiptResult.data as Row[] | null) ?? [];
  const riskRows = Array.isArray(riskResult.data)
    ? (riskResult.data as ContextCapsuleRiskRow[])
    : riskResult.data
    ? ([riskResult.data] as ContextCapsuleRiskRow[])
    : [];
  const receiptSessionIds = [
    ...new Set(
      receiptCandidates.flatMap((row) =>
        typeof row.ref_id === 'string' && row.ref_id ? [row.ref_id] : []
      )
    ),
  ];
  let receiptSessions: Row[] = [];
  if (receiptSessionIds.length > 0) {
    const { data, error } = await input.admin
      .from('conversation_sessions')
      .select(
        'id, owner_id, workspace_id, initiative_id, primary_client, client_conversation_ids, interaction_context'
      )
      .in('id', receiptSessionIds)
      .eq('workspace_id', input.workspaceId)
      .eq('owner_id', input.ownerId)
      .eq('interaction_context->>admission_state', 'admitted');
    if (error) {
      throw errors.internal(
        `Failed to compile context capsule: ${error.message}`
      );
    }
    receiptSessions = (data as Row[] | null) ?? [];
  }
  const receiptSessionById = new Map(
    receiptSessions.flatMap((row) =>
      typeof row.id === 'string' ? [[row.id, row] as const] : []
    )
  );
  const requestRef = exactOrgxRequestRef({
    workspaceId: input.workspaceId,
    initiativeId: effectiveInitiativeId,
    workstreamId: effectiveWorkstreamId,
    taskId: input.taskId,
  });
  const exactReceiptRows = receiptCandidates.filter((row) => {
    const session =
      typeof row.ref_id === 'string'
        ? receiptSessionById.get(row.ref_id)
        : undefined;
    return isExactAutomaticSessionReceipt({
      row,
      session,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      initiativeId: effectiveInitiativeId,
      workstreamId: effectiveWorkstreamId,
      taskId: input.taskId,
      requestRef,
    });
  });

  return compileWorkspaceContextCapsule({
    workspaceId: input.workspaceId,
    ...(effectiveInitiativeId ? { initiativeId: effectiveInitiativeId } : {}),
    ...(effectiveWorkstreamId ? { workstreamId: effectiveWorkstreamId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    generatedAt: input.generatedAt,
    observedGlobalSequence: globalSequence(
      (sequenceResult.data as Row | null)?.global_sequence
    ),
    decisionRows:
      (decisionResult.data as ContextCapsuleDecisionRow[] | null) ?? [],
    decisionCount: decisionResult.count,
    learningRows:
      (learningResult.data as ContextCapsuleLearningRow[] | null) ?? [],
    learningCount: learningResult.count,
    expectationRows:
      (expectationResult.data as ContextCapsuleExpectationRow[] | null) ?? [],
    expectationCount: expectationResult.count,
    receiptRows: exactReceiptRows as unknown as ContextCapsuleReceiptRow[],
    receiptCount: exactReceiptRows.length,
    receiptCandidatesUnvalidated: Math.max(
      0,
      (receiptResult.count ?? receiptCandidates.length) -
        receiptCandidates.length
    ),
    receiptCandidatesWithheld: Math.max(
      0,
      receiptCandidates.length - exactReceiptRows.length
    ),
    sessionRows:
      (sessionResult.data as ContextCapsuleSessionRow[] | null) ?? [],
    sessionCandidatesUnvalidated: Math.max(
      0,
      (sessionResult.count ??
        ((sessionResult.data as ContextCapsuleSessionRow[] | null) ?? [])
          .length) -
        ((sessionResult.data as ContextCapsuleSessionRow[] | null) ?? []).length
    ),
    riskRows,
    riskCount: riskResult.count,
  });
}
