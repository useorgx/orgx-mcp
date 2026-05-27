import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';
import type { SourceClient } from './cross-pollination';

export type ScaffoldStageName =
  | 'billing_precheck'
  | 'workspace_resolution'
  | 'batch_build'
  | 'draft_response'
  | 'entity_create'
  | 'agent_assignment'
  | 'billing_consume'
  | 'credential_check'
  | 'launch'
  | 'stream_snapshot'
  | 'fallback_dispatch'
  | 'external_sync_enqueue'
  | 'response_build';

export type ScaffoldTelemetryTrace = {
  readonly startedAt: number;
  mark(stage: ScaffoldStageName): void;
  snapshot(extra?: Record<string, unknown>): Record<string, unknown>;
};

export function createScaffoldTelemetryTrace(
  now: () => number = () => Date.now()
): ScaffoldTelemetryTrace {
  const startedAt = now();
  let lastAt = startedAt;
  const stages: Record<string, number> = {};

  return {
    startedAt,
    mark(stage) {
      const current = now();
      stages[`${stage}_ms`] = Math.max(0, current - lastAt);
      lastAt = current;
    },
    snapshot(extra = {}) {
      const totalMs = Math.max(0, now() - startedAt);
      return {
        total_ms: totalMs,
        ...stages,
        ...extra,
      };
    },
  };
}

function cleanClientInfo(context: unknown): {
  clientName?: string;
  clientVersion?: string;
  conversationId?: string;
  requestId?: string;
} {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return {};
  }
  const record = context as Record<string, unknown>;
  const client =
    record.client && typeof record.client === 'object' && !Array.isArray(record.client)
      ? (record.client as Record<string, unknown>)
      : {};
  const conversation =
    record.conversation &&
    typeof record.conversation === 'object' &&
    !Array.isArray(record.conversation)
      ? (record.conversation as Record<string, unknown>)
      : {};
  const request =
    record.request &&
    typeof record.request === 'object' &&
    !Array.isArray(record.request)
      ? (record.request as Record<string, unknown>)
      : {};

  return {
    clientName: typeof client.name === 'string' ? client.name : undefined,
    clientVersion:
      typeof client.version === 'string' ? client.version : undefined,
    conversationId:
      typeof conversation.id === 'string' ? conversation.id : undefined,
    requestId: typeof request.id === 'string' ? request.id : undefined,
  };
}

export function recordDurableMcpToolInvocation(params: {
  env: OrgxApiEnv;
  toolId: string;
  status: 'success' | 'error';
  latencyMs: number;
  metadata: Record<string, unknown>;
  userId?: string | null;
  workspaceId?: string | null;
  sourceClient?: SourceClient | null;
  context?: unknown;
  errorCode?: string | null;
  serverVersion?: string;
  isWidgetTool?: boolean;
  toolFamily?: string;
  requestId?: string | null;
}): Promise<void> {
  const clientInfo = cleanClientInfo(params.context);
  return callOrgxApiJson(
    params.env,
    '/api/internal/mcp/tool-invocations',
    {
      method: 'POST',
      body: JSON.stringify({
        tool_id: params.toolId,
        status: params.status,
        latency_ms: params.latencyMs,
        source: 'mcp_worker',
        client_name: clientInfo.clientName ?? params.sourceClient ?? undefined,
        client_platform: params.sourceClient ?? undefined,
        client_version: clientInfo.clientVersion,
        tool_family: params.toolFamily ?? 'mcp_tool',
        auth_source: params.userId ? 'session' : 'none',
        error_code: params.errorCode ?? undefined,
        is_widget_tool: params.isWidgetTool ?? true,
        mcp_server_version: params.serverVersion,
        request_id: params.requestId ?? clientInfo.requestId,
        conversation_id: clientInfo.conversationId,
        user_id: params.userId ?? undefined,
        workspace_id: params.workspaceId ?? undefined,
        metadata: params.metadata,
      }),
    },
    { userId: params.userId ?? undefined }
  )
    .then(() => undefined)
    .catch((error) => {
      console.warn('[mcp:telemetry] failed to persist tool invocation', {
        toolId: params.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
