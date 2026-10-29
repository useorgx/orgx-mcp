import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseAdmin } from '@/lib/supabase';
import { ensureServiceRequestAuthorized } from '@/lib/server/auth/serviceKey';
import { logger } from '@/lib/logger';
import {
  isLegacyBulkResolvableBlocker,
  resolveLegacyAgentRunBlockers,
} from '@/lib/server/agentRuns/blockerLifecycleAdapters';

/**
 * POST /api/agent-runs/:id/resume
 *
 * Flip a paused agent_run back to `running` and clear the auto-close
 * metadata tags applied by the TTL cron (`auto_closed_at`,
 * `auto_close_reason`, `auto_close_prior_status`, `auto_close_ttl_hours`).
 *
 * This is the complementary action to the TTL cron: a user can always
 * bring an auto-closed reporting session back to life with a single call.
 * It's also safe to call on a manually-paused run — the result is the
 * same: status = running, heartbeat bumped, auto-close tags cleared.
 *
 * Refuses runs that are stopped by an activated canonical Blocker or approval
 * Decision. Those states must use their run-scoped lifecycle command so the
 * stop, bound Decision, and execution claim converge together.
 *
 * Body (optional): { note?: string } — stored on metadata.resume_notes
 * for audit trail.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESUMABLE_STATUSES = ['paused', 'queued', 'pending'] as const;

interface ResumeBody {
  note?: string;
  /**
   * How to resolve an `awaiting_approval` run parked on "Continue required"
   * (metadata.continueRequired, set when the turn cap is hit):
   *   - 'continue': clear the park and flip the run back to running so the
   *     next dispatch pass picks it up with existing context.
   *   - 'accept': the delivered artifacts are enough — complete the run,
   *     stamp completed_at, and resolve the open approval blockers. This is
   *     the same transition autopilot's auto-clear performs, exposed for
   *     gated/manual runs (the park's suggested actions previously had no
   *     handler anywhere in the product).
   * Ignored for ordinary paused/blocked resumes.
   */
  action?: 'continue' | 'accept';
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const unauthorized = ensureServiceRequestAuthorized(request);
  if (unauthorized) return unauthorized;

  const { id: runId } = await context.params;
  if (!runId || typeof runId !== 'string') {
    return NextResponse.json({ error: 'run id is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Database unavailable' },
      { status: 503 }
    );
  }

  let body: ResumeBody = {};
  try {
    const raw = await request.text();
    if (raw.trim().length > 0) body = JSON.parse(raw) as ResumeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { data: runRow, error: fetchError } = await admin
    .from('agent_runs')
    .select('id, status, metadata, title, initiative_id, completed_at')
    .eq('id', runId)
    .maybeSingle();

  if (fetchError) {
    logger.error('[agent-runs/resume] fetch failed', {
      runId,
      error: fetchError.message,
    });
    return NextResponse.json(
      { error: 'Failed to load run', details: fetchError.message },
      { status: 500 }
    );
  }
  if (!runRow) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const priorStatus = (runRow as { status: string }).status;
  if (priorStatus === 'running') {
    return NextResponse.json({
      ok: true,
      noop: true,
      run_id: runId,
      status: 'running',
      message: 'Run is already running',
    });
  }

  const runMetadata =
    ((runRow as { metadata?: Record<string, unknown> }).metadata as
      | Record<string, unknown>
      | undefined) ?? {};
  const isContinueRequiredPark =
    priorStatus === 'awaiting_approval' &&
    Boolean(runMetadata.continueRequired);

  if (priorStatus === 'awaiting_approval') {
    return NextResponse.json(
      {
        error:
          'Awaiting-approval runs must be resolved through their canonical Decision lifecycle.',
      },
      { status: 409 }
    );
  }

  if (isContinueRequiredPark) {
    const action = body.action === 'accept' ? 'accept' : 'continue';
    const nowIso = new Date().toISOString();
    const nextMetadata: Record<string, unknown> = { ...runMetadata };
    delete nextMetadata.continueRequired;
    nextMetadata.continueResolved = {
      action,
      at: nowIso,
      note: typeof body.note === 'string' ? body.note.trim() || null : null,
      source: 'agent-runs/resume',
    };

    const nextStatus = action === 'accept' ? 'completed' : 'running';
    const { data: approvalBlockers, error: blockerFetchError } = await admin
      .from('agent_run_blockers')
      .select(
        'id, run_id, step_id, status, lifecycle_version, attention_mode, decision_id'
      )
      .eq('run_id', runId)
      .eq('status', 'open')
      .eq('type', 'approval');
    if (blockerFetchError) {
      return NextResponse.json(
        {
          error: 'Failed to load continue-required blockers',
          details: blockerFetchError.message,
        },
        { status: 500 }
      );
    }

    const protectedBlockers = (approvalBlockers ?? []).filter(
      (blocker: { attention_mode?: string | null }) =>
        !isLegacyBulkResolvableBlocker(blocker)
    );
    if (protectedBlockers.length > 0) {
      return NextResponse.json(
        {
          error:
            'This run is bound to a human Decision. Resolve that Decision before continuing the run.',
          blocker_ids: protectedBlockers.map(
            (blocker: { id: string }) => blocker.id
          ),
        },
        { status: 409 }
      );
    }

    const { data: updatedRun, error: parkUpdateError } = await admin
      .from('agent_runs')
      .update({
        status: nextStatus,
        updated_at: nowIso,
        metadata: nextMetadata,
        ...(action === 'accept' ? { completed_at: nowIso } : {}),
      })
      .eq('id', runId)
      .eq('status', 'awaiting_approval')
      .select('id, status, completed_at')
      .maybeSingle();

    if (parkUpdateError || !updatedRun) {
      return NextResponse.json(
        {
          error: 'Failed to resolve continue-required park',
          details: parkUpdateError?.message ?? 'status changed concurrently',
        },
        { status: parkUpdateError ? 500 : 409 }
      );
    }

    try {
      await resolveLegacyAgentRunBlockers({
        client: admin,
        blockers: approvalBlockers ?? [],
        actor: { type: 'service', id: 'api:agent-runs-resume' },
        resolution:
          action === 'accept'
            ? 'Operator accepted the current run deliverables'
            : 'Operator continued the run with its current context',
        occurredAt: nowIso,
      });
    } catch (blockerError) {
      const compensation = await restoreRunAfterTransitionFailure({
        admin,
        runId,
        expectedStatus: nextStatus,
        restoreStatus: 'awaiting_approval',
        metadata: runMetadata,
        completedAt:
          (runRow as { completed_at?: string | null }).completed_at ?? null,
      });
      logger.error('[agent-runs/resume] blocker resolve failed', {
        runId,
        compensated: compensation.ok,
        compensationError: compensation.error,
        error:
          blockerError instanceof Error
            ? blockerError.message
            : String(blockerError),
      });
      return NextResponse.json(
        {
          error: 'Failed to resolve continue-required blockers',
          compensated: compensation.ok,
          ...(compensation.error
            ? { compensation_error: compensation.error }
            : {}),
        },
        { status: 500 }
      );
    }

    logger.info('[agent-runs/resume] resolved continue-required park', {
      runId,
      action,
      nextStatus,
    });

    return NextResponse.json({
      ok: true,
      run_id: runId,
      prior_status: priorStatus,
      status: nextStatus,
      continue_action: action,
      completed_at:
        (updatedRun as { completed_at?: string | null }).completed_at ?? null,
    });
  }

  if (
    !RESUMABLE_STATUSES.includes(
      priorStatus as (typeof RESUMABLE_STATUSES)[number]
    )
  ) {
    return NextResponse.json(
      {
        error: `Cannot resume run in status '${priorStatus}'. Resumable statuses: ${RESUMABLE_STATUSES.join(
          ', '
        )}.`,
      },
      { status: 409 }
    );
  }

  const priorMetadata =
    ((runRow as { metadata?: Record<string, unknown> }).metadata as
      | Record<string, unknown>
      | undefined) ?? {};
  const nowIso = new Date().toISOString();

  // Clear auto-close tags; preserve a resume audit trail.
  const nextMetadata: Record<string, unknown> = { ...priorMetadata };
  delete nextMetadata.auto_closed_at;
  delete nextMetadata.auto_close_reason;
  delete nextMetadata.auto_close_prior_status;
  delete nextMetadata.auto_close_ttl_hours;

  const priorResumes = Array.isArray(nextMetadata.resume_history)
    ? (nextMetadata.resume_history as unknown[])
    : [];
  const resumeEntry: Record<string, unknown> = {
    at: nowIso,
    from_status: priorStatus,
  };
  if (typeof body.note === 'string' && body.note.trim().length > 0) {
    resumeEntry.note = body.note.trim();
  }
  nextMetadata.resume_history = [...priorResumes, resumeEntry];

  const { data: updated, error: updateError } = await admin
    .from('agent_runs')
    .update({
      status: 'running',
      updated_at: nowIso,
      metadata: nextMetadata,
    })
    .eq('id', runId)
    // Guard against concurrent writes flipping this to a terminal state.
    .in('status', RESUMABLE_STATUSES as unknown as string[])
    .select('id, status, updated_at, metadata')
    .maybeSingle();

  if (updateError) {
    logger.error('[agent-runs/resume] update failed', {
      runId,
      error: updateError.message,
    });
    return NextResponse.json(
      { error: 'Failed to resume run', details: updateError.message },
      { status: 500 }
    );
  }
  if (!updated) {
    return NextResponse.json(
      { error: 'Run status changed before resume could complete' },
      { status: 409 }
    );
  }

  logger.info('[agent-runs/resume] resumed', {
    runId,
    from_status: priorStatus,
    was_auto_closed: priorMetadata.auto_close_reason === 'stale_ttl',
  });

  return NextResponse.json({
    ok: true,
    run_id: runId,
    prior_status: priorStatus,
    status: 'running',
    was_auto_closed: priorMetadata.auto_close_reason === 'stale_ttl',
    updated_at: (updated as { updated_at?: string }).updated_at,
  });
}

async function restoreRunAfterTransitionFailure(params: {
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
  runId: string;
  expectedStatus: string;
  restoreStatus: string;
  metadata: Record<string, unknown>;
  completedAt: string | null;
}): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await params.admin
    .from('agent_runs')
    .update({
      status: params.restoreStatus,
      metadata: params.metadata,
      completed_at: params.completedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.runId)
    .eq('status', params.expectedStatus)
    .select('id')
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'run status changed concurrently' };
  return { ok: true, error: null };
}
