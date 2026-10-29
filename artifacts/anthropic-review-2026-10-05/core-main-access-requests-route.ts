import { NextResponse } from 'next/server';
import { z } from 'zod';

import { CreateAccessRequestSchema } from '@/lib/onboarding/accessRequestContract';
import {
  compose,
  withAuth,
  withCsrf,
  withJsonBody,
} from '@/lib/server/apiRoute';
import { resolveWorkspaceActor } from '@/lib/server/auth/resolveWorkspaceActor';
import {
  AccessRequestInputError,
  createAccessRequest,
  listAccessRequests,
} from '@/lib/server/onboarding/accessRequests';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
});

export const GET = compose(withAuth())(async (request, ctx) => {
  if (!ctx.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid access-request query', issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }
  const actor = await resolveWorkspaceActor({
    admin,
    userId: ctx.userId,
    workspaceId: parsed.data.workspaceId,
    projectId: parsed.data.projectId,
  });
  if (!actor.canReadWorkspace) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const requests = await listAccessRequests({
    admin,
    workspaceId: parsed.data.workspaceId,
    projectId: parsed.data.projectId,
  });
  return NextResponse.json({ requests });
});

export const POST = compose(
  withAuth(),
  withCsrf(),
  withJsonBody({ schema: CreateAccessRequestSchema })
)(async (_request, ctx) => {
  if (!ctx.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = ctx.body as z.infer<typeof CreateAccessRequestSchema>;
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }
  const actor = await resolveWorkspaceActor({
    admin,
    userId: ctx.userId,
    workspaceId: body.workspaceId,
    projectId: body.projectId,
  });
  if (
    !actor.canReview ||
    (body.projectId && !actor.canOperateProject) ||
    (body.initiativeId && !actor.isWorkspaceMember)
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { data: workspace } = await admin
    .from('workspaces')
    .select('owner_id')
    .eq('id', body.workspaceId)
    .maybeSingle();
  if (!workspace?.owner_id) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  let accessRequest;
  try {
    accessRequest = await createAccessRequest({
      admin,
      actorId: ctx.userId,
      workspaceOwnerId: workspace.owner_id,
      request: body,
    });
  } catch (error) {
    if (error instanceof AccessRequestInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  return NextResponse.json({ accessRequest }, { status: 201 });
});
