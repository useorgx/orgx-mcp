import { NextResponse } from 'next/server';

import {
  compose,
  withAuth,
  toRoute,
  type ApiContext,
} from '@/lib/server/apiRoute';
import { logger } from '@/lib/logger';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  getActiveFixtureConfig,
  getFixtureWorkspaceRows,
  isOfflineFixtureMode,
} from '@/lib/server/fixtureData';

/**
 * GET /api/v1/workspaces/current
 *
 * Returns the current user's default workspace.
 * Used by the bootstrap system for critical initial data.
 */
const handler = async (_req: Request, ctx: ApiContext): Promise<Response> => {
  const userId = ctx.userId;

  const fixtureMode =
    process.env.TEST_FIXTURES === '1' ||
    process.env.NEXT_PUBLIC_TEST_FIXTURES === '1';

  if (!userId) {
    if (fixtureMode) {
      return NextResponse.json(
        {
          id: 'fixture-workspace',
          name: 'Fixture Workspace',
          createdAt: new Date().toISOString(),
          ownerId: 'fixture-user',
        },
        { status: 200 }
      );
    }
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      { status: 401 }
    );
  }

  // Offline fixtures have a signed-in user but no database: answer with the
  // fixture profile's default workspace instead of failing the lookup.
  if (isOfflineFixtureMode()) {
    const rows = getFixtureWorkspaceRows(await getActiveFixtureConfig());
    const workspace = rows.find((row) => row.is_default) ?? rows[0];
    if (workspace) {
      return NextResponse.json({
        id: workspace.id,
        name: workspace.name ?? 'Untitled workspace',
        createdAt: new Date().toISOString(),
        ownerId: userId,
      });
    }
  }

  const startTime = performance.now();

  try {
    const admin = getSupabaseAdmin();

    // Try to get user's default workspace
    const { data: defaultWorkspace } = await admin
      .from('workspaces')
      .select('id, name, created_at')
      .eq('owner_id', userId)
      .eq('is_default', true)
      .maybeSingle();

    let workspace = defaultWorkspace;

    // If no default, try to get any workspace
    if (!workspace) {
      const { data: anyCenter } = await admin
        .from('workspaces')
        .select('id, name, created_at')
        .eq('owner_id', userId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      workspace = anyCenter;
    }

    // If still no workspace, create a virtual one based on user ID
    if (!workspace) {
      workspace = {
        id: `user_${userId}`,
        name: 'Default Workspace',
        created_at: new Date().toISOString(),
      };
    }

    const duration = Math.round(performance.now() - startTime);
    logger.debug('[v1/workspaces/current] workspace fetched', {
      userId,
      workspaceId: workspace.id,
      durationMs: duration,
    });

    return NextResponse.json(
      {
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.created_at,
        ownerId: userId,
      },
      {
        status: 200,
        headers: {
          'X-Response-Time': `${duration}ms`,
          'Cache-Control': 'private, max-age=300',
        },
      }
    );
  } catch (error) {
    logger.error('[v1/workspaces/current] failed to fetch workspace', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        error: { code: 'internal_error', message: 'Failed to fetch workspace' },
      },
      { status: 500 }
    );
  }
};

export const GET = toRoute(compose(withAuth({ optional: true }))(handler));
