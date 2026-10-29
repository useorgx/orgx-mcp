import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  OnboardingInteractionRequestSchema,
  OnboardingInteractionTransitionRequestSchema,
} from '@/lib/onboarding/interactionContract';
import { verifyCsrf } from '@/lib/csrf';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resolveWorkspaceActor } from '@/lib/server/auth/resolveWorkspaceActor';
import {
  createOnboardingInteraction,
  InteractionConflictError,
  transitionOnboardingInteraction,
} from '@/lib/server/onboarding/interactionService';
import { InteractionScopeError } from '@/lib/server/onboarding/interactionScopeRepository';
import {
  ensureSupabaseIdentity,
  getUserContext,
} from '@/lib/server/userContext';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    if (!(await verifyCsrf(request))) {
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }
    const body = OnboardingInteractionRequestSchema.parse(await request.json());
    const scope = await resolveRequestScope(
      body.context.workspaceId,
      body.context.projectId,
      body.context.projectId ? 'operate' : 'review'
    );
    const result = await createOnboardingInteraction({
      request: body,
      ownerId: scope.ownerId,
      actorId: scope.actorId,
    });
    return NextResponse.json(result, {
      status: result.deduplicated ? 200 : 201,
    });
  } catch (error) {
    return interactionError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!(await verifyCsrf(request))) {
      return NextResponse.json(
        { error: 'Invalid CSRF token' },
        { status: 403 }
      );
    }
    const body = OnboardingInteractionTransitionRequestSchema.parse(
      await request.json()
    );
    const projectId =
      body.transition.type === 'attach_project' ||
      body.transition.type === 'detach_project'
        ? body.transition.projectId
        : undefined;
    const consequential = ['commit', 'promote', 'cancel', 'reopen'].includes(
      body.transition.type
    );
    const scope = await resolveRequestScope(
      body.workspaceId,
      projectId,
      consequential ? 'approve' : projectId ? 'operate' : 'review'
    );
    const result = await transitionOnboardingInteraction({
      request: body,
      ownerId: scope.ownerId,
      actorId: scope.actorId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return interactionError(error);
  }
}

async function resolveRequestScope(
  requestedWorkspaceId: string,
  projectId: string | undefined,
  permission: 'review' | 'operate' | 'approve'
) {
  const user = await getUserContext();
  const actorId = await ensureSupabaseIdentity(user);
  if (!actorId) throw new Error('Unauthorized');
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Onboarding persistence unavailable');
  const { data: workspace, error } = await admin
    .from('workspaces')
    .select('id,owner_id')
    .eq('id', requestedWorkspaceId)
    .maybeSingle();
  if (error || !workspace?.owner_id) throw new InteractionScopeError();
  const actor = await resolveWorkspaceActor({
    admin,
    userId: actorId,
    workspaceId: requestedWorkspaceId,
    projectId,
  });
  const permitted =
    permission === 'approve'
      ? actor.canApproveConsequentialActions
      : permission === 'operate'
      ? actor.canOperateProject
      : actor.canReview;
  if (!permitted) throw new InteractionScopeError();
  return { ownerId: workspace.owner_id as string, actorId };
}

function interactionError(error: unknown) {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: 'Interaction request is invalid', issues: error.issues },
      { status: 400 }
    );
  }
  if (error instanceof InteractionScopeError) {
    return NextResponse.json(
      { error: 'Interaction scope was not found' },
      { status: 404 }
    );
  }
  const message = error instanceof Error ? error.message : 'Interaction failed';
  if (/unauthorized/i.test(message)) {
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 });
  }
  if (
    error instanceof InteractionConflictError ||
    /conflict|ambiguous|reused|different work|already linked|cannot be|only cancelled/i.test(
      message
    )
  ) {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  return NextResponse.json({ error: message }, { status: 500 });
}
