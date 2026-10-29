import { NextResponse } from 'next/server';
import {
  compose,
  withAuth,
  toRoute,
  type ApiContext,
} from '@/lib/server/apiRoute';
import {
  getSupabaseAdmin,
  resolveSupabaseUserIdForExternal,
} from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { authenticateApiKey } from '@/lib/server/auth/apiKeyAuth';
import {
  ensureServiceRequestAuthorized,
  extractGatewayUserId,
} from '@/lib/server/auth/serviceKey';
import { isDoneStatus, isInProgressStatus } from '@/lib/shared/status';
import {
  DONE_LIKE_STATUSES,
  IN_PROGRESS_LIKE_STATUSES,
} from '@/types/domain/status';
import type { ConsolidationDensityKpi } from '@/lib/daily-brief/types';
import { loadConsolidationDensityKpi } from '@/lib/server/daily-brief/consolidationDensity';

type InitiativeRow = {
  id: string;
  title: string;
  status: string;
  progress: number | null;
  risk_level?: string | null;
  milestones?: Array<{
    id: string;
    title: string;
    target_date: string | null;
    status: string;
  }>;
};

type DecisionRow = {
  id: string;
  title: string;
  priority?: string | null;
  created_at: string;
  metadata?: { agentType?: string };
};

type AgentRunRow = {
  id: string;
  primary_agent_id?: string | null;
  title?: string | null;
  status: string;
  started_at: string | null;
  metadata?: { task?: string; progress?: number | null } | null;
};

type ActivityRow = {
  id: string;
  title: string;
  updated_at: string;
};

type IntegrationConnectionRow = {
  provider: string | null;
  status: string | null;
  last_synced_at: string | null;
  workspace_id: string | null;
};

/**
 * Dashboard Pulse Response
 *
 * Aggregates multiple data sources into a single response for the dashboard.
 * Replaces 5+ individual API calls with a single aggregated call.
 *
 * Based on patterns from ChatGPT's sidebar aggregation and Claude's bootstrap.
 */
interface DashboardPulse {
  // Summary statistics
  stats: {
    activeInitiatives: number;
    pendingDecisions: number;
    runningAgents: number;
    completedThisWeek: number;
    pullRequestsThisWeek: number;
    healthScore: number; // 0-100
    consolidationDensity: ConsolidationDensityKpi | null;
  };

  // Top initiatives (max 5)
  initiatives: Array<{
    id: string;
    title: string;
    status: 'on_track' | 'at_risk' | 'off_track' | 'completed';
    progress: number; // 0-100
    nextMilestone: {
      title: string;
      dueDate: string;
      daysRemaining: number;
    } | null;
    blockers: number;
  }>;

  // Pending decisions (max 5)
  decisions: Array<{
    id: string;
    title: string;
    priority: 'high' | 'medium' | 'low';
    agentType: string | null;
    createdAt: string;
    waitingFor: string; // Human-readable duration
  }>;

  // Active agent sessions (max 3)
  agents: Array<{
    id: string;
    type: string;
    task: string;
    status: 'running' | 'waiting_approval' | 'paused';
    progress: number;
    startedAt: string;
  }>;

  // Recent activity (max 10)
  activity: Array<{
    id: string;
    type:
      | 'decision_approved'
      | 'milestone_completed'
      | 'agent_finished'
      | 'initiative_created'
      | 'task_completed';
    title: string;
    timestamp: string;
    actor: {
      type: 'user' | 'agent';
      name: string;
    };
  }>;

  // Integration status
  integrations: {
    linear: { connected: boolean; lastSync: string | null };
    github: { connected: boolean; lastSync: string | null };
  };

  // Metadata
  generatedAt: string;
  cacheHit: boolean;
  nextRefresh: string;
}

function warnPulseQueryFailure(
  source: string,
  workspaceId: string,
  userId: string,
  error: { message?: string | null } | null | undefined
): void {
  logger.warn('[dashboard/pulse] source degraded', {
    workspaceId,
    userId,
    source,
    error: error?.message ?? 'unknown error',
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveInternalUserId(input: string): Promise<string | null> {
  const value = input.trim();
  if (!value) return null;
  if (UUID_PATTERN.test(value)) return value;
  if (value.startsWith('user_')) {
    return await resolveSupabaseUserIdForExternal(value, {
      createIfMissing: false,
    });
  }
  return null;
}

/**
 * Calculate human-readable duration
 */
function formatDuration(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''}`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
  if (diffMins > 0) return `${diffMins} minute${diffMins > 1 ? 's' : ''}`;
  return 'Just now';
}

/**
 * Calculate days remaining until a date
 */
function daysUntil(date: Date): number {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Map status to health score contribution
 */
function statusToHealthScore(status: string): number {
  switch (status) {
    case 'on_track':
      return 100;
    case 'completed':
      return 100;
    case 'at_risk':
      return 50;
    case 'off_track':
      return 0;
    default:
      return 50;
  }
}

function mapInitiativeStatus(
  initiative: InitiativeRow
): 'on_track' | 'at_risk' | 'off_track' | 'completed' {
  const normalizedStatus = initiative.status.toLowerCase();
  const normalizedRisk = (initiative.risk_level ?? '').toLowerCase();

  if (isDoneStatus(normalizedStatus)) {
    return 'completed';
  }
  if (normalizedStatus === 'paused') {
    return 'at_risk';
  }
  if (normalizedRisk === 'critical') {
    return 'off_track';
  }
  if (normalizedRisk === 'high') {
    return 'at_risk';
  }
  return 'on_track';
}

function isWorkspaceScopedConnection(
  row: IntegrationConnectionRow,
  workspaceId: string
): boolean {
  return !row.workspace_id || row.workspace_id === workspaceId;
}

function getLatestSync(rows: IntegrationConnectionRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => {
    if (!row.last_synced_at) return latest;
    if (!latest) return row.last_synced_at;
    return new Date(row.last_synced_at).getTime() > new Date(latest).getTime()
      ? row.last_synced_at
      : latest;
  }, null);
}

/**
 * GET /api/v1/workspaces/{wsId}/dashboard/pulse
 *
 * Returns aggregated dashboard data in a single response.
 * Designed for < 500ms response time.
 */
export async function generateDashboardPulseResponse({
  req,
  workspaceId,
  initialUserId,
}: {
  req: Request;
  workspaceId: string;
  initialUserId: string | null;
}): Promise<Response> {
  let userId: string | null = initialUserId;
  if (!workspaceId) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Workspace ID required' } },
      { status: 400 }
    );
  }
  if (!UUID_PATTERN.test(workspaceId)) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Invalid workspace ID' } },
      { status: 400 }
    );
  }

  const startTime = performance.now();

  try {
    if (!userId) {
      // Allow internal calls from the MCP gateway (service key + X-Orgx-User-Id)
      let serviceAuthorized = false;
      try {
        serviceAuthorized = !ensureServiceRequestAuthorized(req);
      } catch {
        serviceAuthorized = false;
      }

      if (serviceAuthorized) {
        const gatewayUserId = extractGatewayUserId(req);
        if (!gatewayUserId) {
          return NextResponse.json(
            {
              error: {
                code: 'bad_request',
                message: 'X-Orgx-User-Id is required for service requests',
              },
            },
            { status: 400 }
          );
        }
        userId = await resolveInternalUserId(gatewayUserId);
      } else {
        const apiKeyAuth = await authenticateApiKey(req);
        userId = apiKeyAuth?.userId ?? null;
      }
    }

    if (!userId) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        { status: 401 }
      );
    }

    if (!UUID_PATTERN.test(userId)) {
      return NextResponse.json(
        { error: { code: 'bad_request', message: 'Invalid user identity' } },
        { status: 400 }
      );
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      throw new Error('Database unavailable');
    }

    // Verify this workspace exists and belongs to the authenticated user.
    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id')
      .eq('id', workspaceId)
      .eq('owner_id', userId)
      .maybeSingle();

    if (workspaceError) {
      logger.error('[dashboard/pulse] workspace lookup failed', {
        workspaceId,
        userId,
        error: workspaceError.message,
      });
      throw new Error('Failed to resolve workspace access');
    }
    // The lookup above is already filtered by owner_id, so this covers both
    // "no such workspace" and "not yours" — one 404 for both, never 403.
    // See design rule 2 in lib/server/routeAuthz.ts.
    if (!workspace) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Workspace not found' } },
        { status: 404 }
      );
    }

    const resolvedUserId = userId;
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    // Parallel fetch all data sources
    const [
      initiativesResult,
      activeInitiativeCountResult,
      decisionsResult,
      pendingDecisionCountResult,
      agentRunsResult,
      runningAgentCountResult,
      recentActivityResult,
      completedThisWeekResult,
      pullRequestsThisWeekResult,
      linearConnectionResult,
      consolidationDensityResult,
    ] = await Promise.all([
      // Top initiatives
      supabase
        .from('initiatives')
        .select(
          `
          id,
          title,
          status,
          progress,
          risk_level,
          milestones (
            id,
            title,
            target_date,
            status
          )
        `
        )
        .eq('workspace_id', workspaceId)
        .neq('status', 'archived')
        .order('updated_at', { ascending: false })
        .limit(5),

      // Active initiative count for workspace
      supabase
        .from('initiatives')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .in('status', [...IN_PROGRESS_LIKE_STATUSES]),

      // Pending decisions
      supabase
        .from('decision_requests')
        .select('id, title, priority, status, created_at, metadata')
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(5),

      // Pending decision count for workspace
      supabase
        .from('decision_requests')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending'),

      // Running agent runs
      supabase
        .from('agent_runs')
        .select('id, primary_agent_id, title, status, started_at, metadata')
        .eq('workspace_id', workspaceId)
        .in('status', ['running', 'awaiting_approval', 'paused'])
        .order('started_at', { ascending: false })
        .limit(3),

      // Running agent count for workspace
      supabase
        .from('agent_runs')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .in('status', ['running', 'awaiting_approval', 'paused']),

      // Recent completed tasks (activity feed)
      supabase
        .from('workstream_tasks')
        .select('id, title, updated_at')
        .eq('workspace_id', workspaceId)
        .in('status', [...DONE_LIKE_STATUSES])
        .order('updated_at', { ascending: false })
        .limit(10),

      // Completed tasks this week
      supabase
        .from('workstream_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .in('status', [...DONE_LIKE_STATUSES])
        .gte('updated_at', weekAgo.toISOString()),

      // Pull request receipts this week; de-emphasized alongside quality KPIs.
      // Receipts are identified by the metadata.kind marker every writer
      // stamps ('github_pull_request_receipt'), not artifact_type, which
      // differs between the webhook/CI path ('pull_request') and
      // MCP-submitted receipts ('eng.pull_request'). Some receipts carry no
      // metadata.workspace_id (backfills attributed only to an initiative);
      // those count for their owner rather than silently reading as zero.
      // workspaceId is UUID-validated above, so the .or() filter is safe.
      supabase
        .from('work_artifacts')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', resolvedUserId)
        .contains('metadata', { kind: 'github_pull_request_receipt' })
        .or(
          `metadata->>workspace_id.eq.${workspaceId},metadata->>workspace_id.is.null`
        )
        .gte('created_at', weekAgo.toISOString()),

      // Workspace-scoped integration connection check
      supabase
        .from('integration_connections')
        .select('provider, status, last_synced_at, workspace_id')
        .eq('owner_id', resolvedUserId),

      loadConsolidationDensityKpi({
        db: supabase,
        workspaceId,
        ownerId: resolvedUserId,
        briefDate: new Date().toISOString().slice(0, 10),
      }).catch((error) => {
        warnPulseQueryFailure(
          'consolidation_density',
          workspaceId,
          resolvedUserId,
          {
            message: error instanceof Error ? error.message : String(error),
          }
        );
        return null;
      }),
    ]);
    const initiativesRows = initiativesResult.error
      ? (warnPulseQueryFailure(
          'initiatives',
          workspaceId,
          userId,
          initiativesResult.error
        ),
        [])
      : ((initiativesResult.data ?? []) as InitiativeRow[]);
    const decisionsRows = decisionsResult.error
      ? (warnPulseQueryFailure(
          'decision_requests',
          workspaceId,
          userId,
          decisionsResult.error
        ),
        [])
      : ((decisionsResult.data ?? []) as DecisionRow[]);
    const agentRunRows = agentRunsResult.error
      ? (warnPulseQueryFailure(
          'agent_runs',
          workspaceId,
          userId,
          agentRunsResult.error
        ),
        [])
      : ((agentRunsResult.data ?? []) as AgentRunRow[]);
    const activityRows = recentActivityResult.error
      ? (warnPulseQueryFailure(
          'workstream_tasks.activity',
          workspaceId,
          userId,
          recentActivityResult.error
        ),
        [])
      : ((recentActivityResult.data ?? []) as ActivityRow[]);
    const completedThisWeekCount = completedThisWeekResult.error
      ? (warnPulseQueryFailure(
          'workstream_tasks.completed_count',
          workspaceId,
          userId,
          completedThisWeekResult.error
        ),
        0)
      : completedThisWeekResult.count ?? 0;
    const pullRequestsThisWeekCount = pullRequestsThisWeekResult.error
      ? (warnPulseQueryFailure(
          'work_artifacts.pull_request_count',
          workspaceId,
          userId,
          pullRequestsThisWeekResult.error
        ),
        0)
      : pullRequestsThisWeekResult.count ?? 0;
    const activeInitiativeCount = activeInitiativeCountResult.error
      ? (warnPulseQueryFailure(
          'initiatives.active_count',
          workspaceId,
          userId,
          activeInitiativeCountResult.error
        ),
        initiativesRows.filter((item) => isInProgressStatus(item.status))
          .length)
      : activeInitiativeCountResult.count ?? initiativesRows.length;
    const pendingDecisionCount = pendingDecisionCountResult.error
      ? (warnPulseQueryFailure(
          'decision_requests.pending_count',
          workspaceId,
          userId,
          pendingDecisionCountResult.error
        ),
        decisionsRows.length)
      : pendingDecisionCountResult.count ?? decisionsRows.length;
    const runningAgentCount = runningAgentCountResult.error
      ? (warnPulseQueryFailure(
          'agent_runs.running_count',
          workspaceId,
          userId,
          runningAgentCountResult.error
        ),
        agentRunRows.length)
      : runningAgentCountResult.count ?? agentRunRows.length;
    const integrationConnections = linearConnectionResult.error
      ? (warnPulseQueryFailure(
          'integration_connections',
          workspaceId,
          userId,
          linearConnectionResult.error
        ),
        [])
      : ((linearConnectionResult.data ?? []) as IntegrationConnectionRow[]);

    const initiativeIds = initiativesRows.map((initiative) => initiative.id);
    const blockersByInitiative = new Map<string, number>();
    if (initiativeIds.length > 0) {
      const workstreamsResult = await supabase
        .from('workstreams')
        .select('initiative_id, blockers_count')
        .in('initiative_id', initiativeIds);

      if (workstreamsResult.error) {
        warnPulseQueryFailure(
          'workstreams.blockers',
          workspaceId,
          userId,
          workstreamsResult.error
        );
      } else {
        for (const row of workstreamsResult.data ?? []) {
          const initiativeId = String(row.initiative_id ?? '');
          if (!initiativeId) continue;
          const blockersCount =
            typeof row.blockers_count === 'number' ? row.blockers_count : 0;
          blockersByInitiative.set(
            initiativeId,
            (blockersByInitiative.get(initiativeId) ?? 0) + blockersCount
          );
        }
      }
    }

    const scopedConnections = integrationConnections.filter((row) =>
      isWorkspaceScopedConnection(row, workspaceId)
    );
    const activeConnections = scopedConnections.filter(
      (row) => row.status?.trim().toLowerCase() === 'active'
    );
    const linearConnections = activeConnections.filter(
      (row) => row.provider?.trim().toLowerCase() === 'linear'
    );
    const githubConnections = activeConnections.filter(
      (row) => row.provider?.trim().toLowerCase() === 'github'
    );

    // Process initiatives
    const initiatives = initiativesRows.map((init: InitiativeRow) => {
      const milestones = init.milestones || [];
      const nextMilestone = milestones
        .filter(
          (m: { status: string; target_date: string | null }) =>
            !isDoneStatus(m.status) && Boolean(m.target_date)
        )
        .sort(
          (
            a: { target_date: string | null },
            b: { target_date: string | null }
          ) =>
            new Date(a.target_date as string).getTime() -
            new Date(b.target_date as string).getTime()
        )[0];

      return {
        id: init.id,
        title: init.title,
        status: mapInitiativeStatus(init),
        progress: init.progress || 0,
        nextMilestone: nextMilestone
          ? {
              title: nextMilestone.title,
              dueDate: nextMilestone.target_date as string,
              daysRemaining: daysUntil(
                new Date(nextMilestone.target_date as string)
              ),
            }
          : null,
        blockers: blockersByInitiative.get(init.id) ?? 0,
      };
    });

    // Process decisions
    const decisions: DashboardPulse['decisions'] = decisionsRows.map(
      (dec: DecisionRow) => ({
        id: dec.id,
        title: dec.title,
        priority:
          dec.priority === 'high' || dec.priority === 'urgent'
            ? 'high'
            : dec.priority === 'low'
            ? 'low'
            : 'medium',
        agentType: dec.metadata?.agentType || null,
        createdAt: dec.created_at,
        waitingFor: formatDuration(new Date(dec.created_at)),
      })
    );

    // Process agent runs
    const agents: DashboardPulse['agents'] = agentRunRows.map(
      (run: AgentRunRow) => ({
        id: run.id,
        type: run.primary_agent_id || 'orchestrator-agent',
        task: run.metadata?.task || run.title || 'Processing...',
        status:
          run.status === 'awaiting_approval'
            ? 'waiting_approval'
            : run.status === 'running'
            ? 'running'
            : 'paused',
        progress:
          typeof run.metadata?.progress === 'number'
            ? run.metadata.progress
            : 0,
        startedAt: run.started_at || new Date().toISOString(),
      })
    );

    // Process recent activity
    const activity: DashboardPulse['activity'] = activityRows.map(
      (item: ActivityRow) => ({
        id: item.id,
        type: 'task_completed' as const,
        title: item.title,
        timestamp: item.updated_at,
        actor: {
          type: 'agent' as const,
          name: 'OrgX Agent',
        },
      })
    );

    // Keep most recent first (defensive in case data source order changes).
    activity.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Calculate stats
    const activeInitiatives = activeInitiativeCount;
    const pendingDecisions = pendingDecisionCount;
    const runningAgents = runningAgentCount;

    // Health score is average of initiative statuses
    const healthScore =
      initiatives.length > 0
        ? Math.round(
            initiatives.reduce(
              (sum: number, init: (typeof initiatives)[number]) =>
                sum + statusToHealthScore(init.status),
              0
            ) / initiatives.length
          )
        : 100;

    const pulse: DashboardPulse = {
      stats: {
        activeInitiatives,
        pendingDecisions,
        runningAgents,
        completedThisWeek: completedThisWeekCount,
        pullRequestsThisWeek: pullRequestsThisWeekCount,
        healthScore,
        consolidationDensity: consolidationDensityResult,
      },
      initiatives,
      decisions,
      agents,
      activity,
      integrations: {
        linear: {
          connected: linearConnections.length > 0,
          lastSync: getLatestSync(linearConnections),
        },
        github: {
          connected: githubConnections.length > 0,
          lastSync: getLatestSync(githubConnections),
        },
      },
      generatedAt: new Date().toISOString(),
      cacheHit: false,
      nextRefresh: new Date(Date.now() + 30000).toISOString(), // 30 seconds
    };

    // Backward-compatible top-level fields for older MCP clients.
    const payload: DashboardPulse & {
      initiatives_count: number;
      pending_decisions: number;
      active_agents: number;
      pull_requests_this_week: number;
      consolidation_density: ConsolidationDensityKpi | null;
    } = {
      ...pulse,
      initiatives_count: pulse.stats.activeInitiatives,
      pending_decisions: pulse.stats.pendingDecisions,
      active_agents: pulse.stats.runningAgents,
      pull_requests_this_week: pulse.stats.pullRequestsThisWeek,
      consolidation_density: pulse.stats.consolidationDensity,
    };

    const duration = Math.round(performance.now() - startTime);
    logger.debug('[dashboard/pulse] Generated', {
      workspaceId,
      userId,
      durationMs: duration,
      stats: pulse.stats,
    });

    return NextResponse.json(payload, {
      status: 200,
      headers: {
        'Cache-Control': 'private, max-age=30, stale-while-revalidate=10',
        'Content-Type': 'application/json',
        'X-Response-Time': `${duration}ms`,
      },
    });
  } catch (error) {
    logger.error('[dashboard/pulse] Failed to generate', {
      workspaceId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: 'Failed to generate dashboard',
        },
      },
      { status: 500 }
    );
  }
}

const handler = async (req: Request, ctx: ApiContext): Promise<Response> => {
  return generateDashboardPulseResponse({
    req,
    workspaceId: ctx.params?.wsId as string,
    initialUserId: ctx.userId,
  });
};

export const GET = toRoute(compose(withAuth({ optional: true }))(handler));
