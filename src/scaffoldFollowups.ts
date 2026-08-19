import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';
import { canLaunchWithCredentialStatus } from './scaffoldControl';
import type { ScaffoldStageName } from './mcpInvocationTelemetry';

export type ScaffoldAgentAssignment = {
  attempted: boolean;
  ok: boolean;
  status?: 'queued_async';
  assigned_count?: number;
  total_workstreams?: number;
  assignments?: Array<{
    workstream_id: string;
    domain?: string | null;
    agent_id: string;
    agent_name?: string | null;
  }>;
  error?: string;
};

export type ScaffoldUsageResult = {
  attempted: boolean;
  ok: boolean;
  status?: 'queued_async';
  error?: string;
  usage?: unknown;
};

export type ScaffoldCredentialStatusResult = {
  checked: boolean;
  status?: 'queued_async';
  has_credentials: boolean;
  has_execution_credentials: boolean;
  has_subscription_accounts: boolean;
  can_execute: boolean;
  setup_url?: string;
};

export type ScaffoldLaunchResult = {
  attempted: boolean;
  ok: boolean;
  queued_async?: boolean;
  message?: string;
  transition?: { from: string; to: string };
  initiative_activation?: {
    created_stream_count: number;
    redispatched_stream_count: number;
    error?: string;
  };
  error?: string;
  error_kind?: string;
  needs_credentials?: boolean;
  next_steps?: string[];
  start_agents_hint?: string;
};

export type ScaffoldStreamSnapshot = {
  total: number;
  by_status: Record<string, number>;
  workstream_to_stream_id: Record<string, string>;
  items: Array<{
    id: string;
    workstream_id: string | null;
    status: string | null;
    auto_continue: boolean | null;
    agent_domain: string | null;
    progress_pct: number | null;
    current_job_id: string | null;
  }>;
};

export type ScaffoldFallbackAgentDispatch = {
  attempted: boolean;
  ok: boolean;
  status?: 'queued_async';
  agent?: string;
  message?: string;
  error?: string;
  tool_result?: unknown;
};

export type ScaffoldFollowupResult = {
  agent_assignment?: ScaffoldAgentAssignment;
  scaffold_usage?: ScaffoldUsageResult;
  credential_status?: ScaffoldCredentialStatusResult;
  launch?: ScaffoldLaunchResult;
  streams?: ScaffoldStreamSnapshot;
  fallback_agent_dispatch?: ScaffoldFallbackAgentDispatch;
};

type FollowupStageName = Extract<
  ScaffoldStageName,
  | 'agent_assignment'
  | 'billing_consume'
  | 'credential_check'
  | 'launch'
  | 'stream_snapshot'
  | 'fallback_dispatch'
>;

export function buildQueuedScaffoldFollowups(params: {
  createdInitiativeId?: string | null;
  launchAfterCreate: boolean;
}): ScaffoldFollowupResult {
  if (!params.createdInitiativeId) return {};

  return {
    agent_assignment: {
      attempted: false,
      ok: false,
      status: 'queued_async',
    },
    scaffold_usage: {
      attempted: false,
      ok: false,
      status: 'queued_async',
    },
    credential_status: params.launchAfterCreate
      ? {
          checked: false,
          status: 'queued_async',
          has_credentials: false,
          has_execution_credentials: false,
          has_subscription_accounts: false,
          can_execute: false,
        }
      : undefined,
    launch: params.launchAfterCreate
      ? {
          attempted: false,
          ok: false,
          queued_async: true,
          message:
            'Launch follow-ups were queued after the scaffold response returned.',
          start_agents_hint:
            'Open the live view to watch progress. If agents do not start automatically, say "start agents".',
        }
      : { attempted: false, ok: false },
  };
}

export async function runScaffoldPostCreateFollowups(params: {
  env: OrgxApiEnv;
  createdInitiativeId?: string | null;
  launchAfterCreate: boolean;
  effectiveCommandCenterId?: string | null;
  /**
   * Acting identity for every follow-up API call. SECURITY: this must be the
   * authenticated session user (or the API's own resolution of it) — never a
   * caller-supplied owner_id, which would let a session act as another user.
   */
  actorUserId?: string | null;
  hierarchy: unknown;
  resolveUserEmail: () => string | null | undefined;
  onStage?: (stage: FollowupStageName) => void;
}): Promise<ScaffoldFollowupResult> {
  const userEmail = params.resolveUserEmail();
  const createdInitiativeId = params.createdInitiativeId ?? null;
  const actorUserId = params.actorUserId ?? null;
  const effectiveCommandCenterId = params.effectiveCommandCenterId ?? null;

  let agent_assignment: ScaffoldAgentAssignment | undefined;
  if (createdInitiativeId) {
    try {
      agent_assignment = { attempted: true, ok: false };
      const assignResp = await callOrgxApiJson(
        params.env,
        `/api/entities/initiative/${createdInitiativeId}/assign-agents`,
        { method: 'POST' },
        {
          userId: actorUserId ?? undefined,
          userEmail,
        }
      );
      const assignPayload = (await assignResp.json()) as {
        ok?: boolean;
        data?: {
          assignments?: Array<Record<string, unknown>>;
          summary?: string;
        };
      };
      const parsedAssignments = Array.isArray(assignPayload?.data?.assignments)
        ? assignPayload.data.assignments
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const workstreamId =
                typeof item.workstream_id === 'string'
                  ? item.workstream_id
                  : null;
              const agentId =
                typeof item.agent_id === 'string' ? item.agent_id : null;
              if (!workstreamId || !agentId) return null;
              return {
                workstream_id: workstreamId,
                domain: typeof item.domain === 'string' ? item.domain : null,
                agent_id: agentId,
                agent_name:
                  typeof item.agent_name === 'string'
                    ? item.agent_name
                    : null,
              };
            })
            .filter(
              (
                entry
              ): entry is {
                workstream_id: string;
                domain: string | null;
                agent_id: string;
                agent_name: string | null;
              } => Boolean(entry)
            )
        : [];
      agent_assignment = {
        attempted: true,
        ok: Boolean(assignPayload?.ok),
        assigned_count: parsedAssignments.length,
        assignments: parsedAssignments,
      };
    } catch (error) {
      agent_assignment = {
        attempted: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  params.onStage?.('agent_assignment');

  let scaffold_usage: ScaffoldUsageResult | undefined;
  if (createdInitiativeId) {
    try {
      scaffold_usage = { attempted: true, ok: false };
      const consumeResp = await callOrgxApiJson(
        params.env,
        '/api/billing/scaffolds/consume',
        {
          method: 'POST',
          body: JSON.stringify({ initiative_id: createdInitiativeId }),
        },
        {
          userId: actorUserId ?? undefined,
          userEmail,
        }
      );
      const consumePayload = (await consumeResp.json()) as any;
      scaffold_usage = {
        attempted: true,
        ok: Boolean(consumePayload?.ok),
        usage: consumePayload?.data?.usage,
      };
    } catch (error) {
      scaffold_usage = {
        attempted: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  params.onStage?.('billing_consume');

  let credential_status: ScaffoldCredentialStatusResult | undefined;
  if (createdInitiativeId && params.launchAfterCreate) {
    try {
      const credentialStatusPath = effectiveCommandCenterId
        ? `/api/client/credentials/status?workspace_id=${encodeURIComponent(effectiveCommandCenterId)}`
        : '/api/client/credentials/status';
      const credResp = await callOrgxApiJson(
        params.env,
        credentialStatusPath,
        undefined,
        {
          userId: actorUserId ?? undefined,
          userEmail,
        }
      );
      const credPayload = (await credResp.json()) as {
        ok?: boolean;
        data?: {
          has_credentials?: boolean;
          has_execution_credentials?: boolean;
          has_subscription_accounts?: boolean;
          can_execute?: boolean;
          setup_url?: string;
        };
      };
      credential_status = {
        checked: true,
        has_credentials: Boolean(credPayload?.data?.has_credentials),
        has_execution_credentials: Boolean(
          credPayload?.data?.has_execution_credentials
        ),
        has_subscription_accounts: Boolean(
          credPayload?.data?.has_subscription_accounts
        ),
        can_execute: Boolean(credPayload?.data?.can_execute),
        setup_url: credPayload?.data?.setup_url,
      };
    } catch {
      credential_status = {
        checked: false,
        has_credentials: false,
        has_execution_credentials: false,
        has_subscription_accounts: false,
        can_execute: false,
      };
    }
  }
  params.onStage?.('credential_check');

  let launch: ScaffoldLaunchResult | undefined;
  if (
    createdInitiativeId &&
    params.launchAfterCreate &&
    credential_status?.checked &&
    !canLaunchWithCredentialStatus(credential_status)
  ) {
    launch = {
      attempted: false,
      ok: false,
      error_kind: 'credential_missing',
      needs_credentials: true,
      error:
        'No execution account is active. Agents need a live subscription runner or API key to execute.',
      next_steps: [
        `Configure execution at ${credential_status.setup_url ?? '/settings/execution'}`,
        'Connect a Codex or Claude runner, or add an Anthropic/OpenAI API key',
        'Then say "start agents" to launch execution',
      ],
      start_agents_hint:
        'After configuring credentials, say "start agents" to begin.',
    };
  } else if (createdInitiativeId && params.launchAfterCreate) {
    try {
      const launchResponse = await callOrgxApiJson(
        params.env,
        `/api/entities/initiative/${createdInitiativeId}/launch`,
        {
          method: 'POST',
          body: JSON.stringify({
            note: 'Auto-launched after scaffold_initiative',
          }),
        },
        {
          userId: actorUserId ?? undefined,
          userEmail,
        }
      );
      const launchPayload = (await launchResponse.json()) as {
        message?: string;
        transition?: { from: string; to: string };
        initiative_activation?: {
          created_stream_count: number;
          redispatched_stream_count: number;
          error?: string;
        };
      };
      launch = {
        attempted: true,
        ok: true,
        message: launchPayload.message ?? 'Initiative launched',
        transition: launchPayload.transition,
        initiative_activation: launchPayload.initiative_activation,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isSpawnGuard =
        errorMessage.includes('spawn') ||
        errorMessage.includes('guard') ||
        errorMessage.includes('quality');
      const isStreamError =
        errorMessage.includes('stream') || errorMessage.includes('activation');
      launch = {
        attempted: true,
        ok: false,
        error: errorMessage,
        error_kind: isSpawnGuard
          ? 'spawn_guard_blocked'
          : isStreamError
          ? 'stream_creation_failed'
          : 'launch_failed',
        next_steps: isSpawnGuard
          ? [
              'Check agent quality scores',
              'Approve pending decisions to unblock',
              'Then say "start agents" to retry',
            ]
          : [
              'Try re-running the same prompt (transient failures happen)',
              'Say "start agents" to retry launch',
            ],
        start_agents_hint:
          'Say "start agents" to retry launching this initiative.',
      };
    }
  } else if (createdInitiativeId) {
    launch = { attempted: false, ok: false };
  }
  params.onStage?.('launch');

  let streams: ScaffoldStreamSnapshot | undefined;
  if (createdInitiativeId) {
    try {
      const searchParams = new URLSearchParams();
      searchParams.set('type', 'stream');
      searchParams.set('initiative_id', createdInitiativeId);
      searchParams.set('limit', '50');

      const streamsResponse = await callOrgxApiJson(
        params.env,
        `/api/entities?${searchParams.toString()}`,
        undefined,
        {
          userId: actorUserId ?? undefined,
          userEmail,
        }
      );
      const streamsPayload = (await streamsResponse.json()) as {
        data?: Array<Record<string, unknown>>;
      };
      const rawItems = Array.isArray(streamsPayload.data)
        ? streamsPayload.data
        : [];

      const byStatus: Record<string, number> = {};
      const workstreamToStreamId: Record<string, string> = {};
      const items = rawItems
        .map((row) => {
          const id = typeof row.id === 'string' ? row.id : null;
          if (!id) return null;
          const workstreamId =
            typeof row.workstream_id === 'string' ? row.workstream_id : null;
          const status = typeof row.status === 'string' ? row.status : null;
          const autoContinue =
            typeof row.auto_continue === 'boolean' ? row.auto_continue : null;
          const agentDomain =
            typeof row.agent_domain === 'string' ? row.agent_domain : null;
          const progressPct =
            typeof row.progress_pct === 'number' ? row.progress_pct : null;
          const currentJobId =
            typeof row.current_job_id === 'string'
              ? row.current_job_id
              : null;

          if (status) byStatus[status] = (byStatus[status] ?? 0) + 1;
          if (workstreamId) workstreamToStreamId[workstreamId] = id;

          return {
            id,
            workstream_id: workstreamId,
            status,
            auto_continue: autoContinue,
            agent_domain: agentDomain,
            progress_pct: progressPct,
            current_job_id: currentJobId,
          };
        })
        .filter(
          (
            value
          ): value is {
            id: string;
            workstream_id: string | null;
            status: string | null;
            auto_continue: boolean | null;
            agent_domain: string | null;
            progress_pct: number | null;
            current_job_id: string | null;
          } => Boolean(value)
        );

      streams = {
        total: items.length,
        by_status: byStatus,
        workstream_to_stream_id: workstreamToStreamId,
        items,
      };
    } catch {
      // Best-effort: scaffolding should not fail just because stream snapshot
      // retrieval failed after the records were created.
    }
  }
  params.onStage?.('stream_snapshot');

  let fallback_agent_dispatch: ScaffoldFallbackAgentDispatch | undefined;
  if (
    createdInitiativeId &&
    params.launchAfterCreate &&
    launch?.attempted &&
    launch.ok &&
    (streams?.total ?? 0) === 0
  ) {
    const workstreams = Array.isArray((params.hierarchy as any)?.workstreams)
      ? ((params.hierarchy as any).workstreams as Array<Record<string, unknown>>)
      : [];

    const firstWs = workstreams[0] ?? null;
    const wsLabel =
      firstWs &&
      (typeof firstWs.title === 'string'
        ? firstWs.title
        : typeof firstWs.name === 'string'
        ? firstWs.name
        : null);

    const wsHint =
      firstWs &&
      (typeof (firstWs as any).domain === 'string'
        ? String((firstWs as any).domain)
        : typeof (firstWs as any).persona === 'string'
        ? String((firstWs as any).persona)
        : wsLabel);
    const normalizedHint = typeof wsHint === 'string' ? wsHint.toLowerCase() : '';

    const assignedAgent =
      Array.isArray(agent_assignment?.assignments) &&
      agent_assignment.assignments.length > 0
        ? agent_assignment.assignments[0]?.agent_id
        : null;

    const agent =
      typeof assignedAgent === 'string' && assignedAgent.length > 0
        ? assignedAgent
        : normalizedHint.includes('engineering') ||
          normalizedHint.includes('build') ||
          normalizedHint.includes('dev')
        ? 'engineering-agent'
        : normalizedHint.includes('product')
        ? 'product-agent'
        : normalizedHint.includes('design') ||
          normalizedHint.includes('brand')
        ? 'design-agent'
        : normalizedHint.includes('sales')
        ? 'sales-agent'
        : normalizedHint.includes('ops') ||
          normalizedHint.includes('operation')
        ? 'operations-agent'
        : 'operations-agent';

    try {
      fallback_agent_dispatch = { attempted: true, ok: false, agent };
      const task = wsLabel
        ? `Start work on the "${wsLabel}" workstream.`
        : 'Start work on the first workstream in this initiative.';
      const toolExecResponse = await callOrgxApiJson(
        params.env,
        `/api/tools/execute`,
        {
          method: 'POST',
          body: JSON.stringify({
            tool_id: 'spawn_agent_task',
            user_id: actorUserId ?? undefined,
            args: {
              agent,
              task,
              initiative_id: createdInitiativeId,
              context:
                'Auto-started after scaffold as a fallback path when stream dispatch is unavailable.',
              wait_for_completion: false,
            },
          }),
        },
        {
          userId: actorUserId ?? undefined,
          userEmail,
        }
      );
      const toolExecPayload = (await toolExecResponse.json()) as any;
      fallback_agent_dispatch = {
        attempted: true,
        ok: Boolean(toolExecPayload?.ok),
        agent,
        message:
          typeof toolExecPayload?.data?.message === 'string'
            ? toolExecPayload.data.message
            : undefined,
        tool_result: toolExecPayload,
      };
    } catch (error) {
      fallback_agent_dispatch = {
        attempted: true,
        ok: false,
        agent,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  params.onStage?.('fallback_dispatch');

  return {
    agent_assignment,
    scaffold_usage,
    credential_status,
    launch,
    streams,
    fallback_agent_dispatch,
  };
}
