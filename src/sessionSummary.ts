import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ReportingSourceClient } from './cross-pollination';

/**
 * Session Summary — best-effort session-end flush.
 *
 * MCP sessions end without a close signal on streamable HTTP, so the Durable
 * Object arms an idle alarm (via the agents SDK schedule API) that fires after
 * a quiet period and flushes a compact summary: session id, handshake
 * clientInfo, per-tool call counts, first/last activity, and the bound
 * workspace/initiative. Bound sessions post to the existing activity endpoint;
 * unbound sessions fall back to the durable telemetry path with a
 * session_summary marker so nothing is silently dropped.
 */

export type SessionToolStats = {
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  toolCounts: Record<string, number>;
};

export const SESSION_TOOL_STATS_STORAGE_KEY = 'session_tool_stats_v1';
export const SESSION_FLUSH_SCHEDULE_STORAGE_KEY = 'session_flush_schedule_v1';

/** Idle quiet period before a session is considered ended. */
export const SESSION_SUMMARY_IDLE_FLUSH_SECONDS = 30 * 60;

/** Callback method name the idle schedule invokes on the Durable Object. */
export const SESSION_SUMMARY_FLUSH_CALLBACK = 'flushSessionSummary';

export function createEmptySessionToolStats(): SessionToolStats {
  return { firstActivityAt: null, lastActivityAt: null, toolCounts: {} };
}

export function applySessionToolObservation(
  stats: SessionToolStats,
  toolName: string,
  now: number = Date.now()
): SessionToolStats {
  return {
    firstActivityAt: stats.firstActivityAt ?? now,
    lastActivityAt: now,
    toolCounts: {
      ...stats.toolCounts,
      [toolName]: (stats.toolCounts[toolName] ?? 0) + 1,
    },
  };
}

export function totalSessionToolCalls(stats: SessionToolStats): number {
  return Object.values(stats.toolCounts).reduce((sum, count) => sum + count, 0);
}

export function parseStoredSessionToolStats(
  stored: unknown
): SessionToolStats | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return null;
  }
  const record = stored as Record<string, unknown>;
  const rawCounts =
    record.toolCounts && typeof record.toolCounts === 'object' &&
    !Array.isArray(record.toolCounts)
      ? (record.toolCounts as Record<string, unknown>)
      : {};
  const toolCounts: Record<string, number> = {};
  for (const [tool, count] of Object.entries(rawCounts)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      toolCounts[tool] = Math.floor(count);
    }
  }
  const firstActivityAt =
    typeof record.firstActivityAt === 'number' &&
    Number.isFinite(record.firstActivityAt)
      ? record.firstActivityAt
      : null;
  const lastActivityAt =
    typeof record.lastActivityAt === 'number' &&
    Number.isFinite(record.lastActivityAt)
      ? record.lastActivityAt
      : null;
  if (Object.keys(toolCounts).length === 0 && !firstActivityAt) return null;
  return { firstActivityAt, lastActivityAt, toolCounts };
}

export type SessionSummary = {
  session_summary: true;
  session_id: string;
  client_name: string | null;
  client_version: string | null;
  tool_call_count: number;
  unique_tool_count: number;
  tool_counts: Record<string, number>;
  first_activity_at: string | null;
  last_activity_at: string | null;
  workspace_id: string | null;
  initiative_id: string | null;
};

export function buildSessionSummary(params: {
  sessionId: string;
  clientName?: string | null;
  clientVersion?: string | null;
  stats: SessionToolStats;
  workspaceId?: string | null;
  initiativeId?: string | null;
}): SessionSummary {
  const toIso = (value: number | null) =>
    value === null ? null : new Date(value).toISOString();
  return {
    session_summary: true,
    session_id: params.sessionId,
    client_name: params.clientName ?? null,
    client_version: params.clientVersion ?? null,
    tool_call_count: totalSessionToolCalls(params.stats),
    unique_tool_count: Object.keys(params.stats.toolCounts).length,
    tool_counts: params.stats.toolCounts,
    first_activity_at: toIso(params.stats.firstActivityAt),
    last_activity_at: toIso(params.stats.lastActivityAt),
    workspace_id: params.workspaceId ?? null,
    initiative_id: params.initiativeId ?? null,
  };
}

/**
 * Initiative-OPTIONAL durable home for a session summary.
 *
 * The activity endpoint below can only take a summary that is bound to an
 * initiative, and almost no real session is — so unbound summaries fell back
 * to durable telemetry and never reached an operator surface. This endpoint
 * lands them in a workspace-scoped inbox with an attribution stamp instead.
 */
export const SESSION_SUMMARY_INGEST_PATH = '/api/v1/sessions/summary';

/**
 * Bounds copied from sessionSummaryRequestSchema. Overrunning any of them
 * fails validation for the whole post, so they are enforced here rather than
 * discovered as a 400 at flush time.
 */
export const SESSION_SUMMARY_INGEST_MAX_TOOL_KEYS = 200;
const MAX_SESSION_ID_LENGTH = 255;
const MAX_SOURCE_CLIENT_LENGTH = 60;
const MAX_TOOL_NAME_LENGTH = 120;

/** The endpoint's uuid-typed fields must not receive a non-uuid string. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuid(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined;
}

/**
 * Keep the largest counts — the histogram is what the endpoint merges, and a
 * truncated-but-representative histogram beats a rejected 400.
 */
function capToolHistogram(
  toolCounts: Record<string, number>
): Record<string, number> | undefined {
  const entries = Object.entries(toolCounts).filter(
    ([tool]) => tool.length > 0 && tool.length <= MAX_TOOL_NAME_LENGTH
  );
  if (entries.length === 0) return undefined;
  if (entries.length <= SESSION_SUMMARY_INGEST_MAX_TOOL_KEYS) {
    return Object.fromEntries(entries);
  }
  return Object.fromEntries(
    entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, SESSION_SUMMARY_INGEST_MAX_TOOL_KEYS)
  );
}

/**
 * Body for POST /api/v1/sessions/summary (flat form; the endpoint also accepts
 * a `{ session, initiative_id }` envelope and normalizes both to this shape).
 *
 * `session_id` + `source_client` are the only required fields, and
 * `source_client` is a FREE string there rather than the reporting enum: an
 * unrecognized client is recorded verbatim rather than dropped. So the
 * normalized reporting value is preferred when the client is known, and the
 * raw handshake name is used when it is not.
 */
export function buildSessionSummaryIngestBody(
  summary: SessionSummary,
  sourceClient: ReportingSourceClient | null
): Record<string, unknown> {
  const startedAt = summary.first_activity_at;
  const endedAt = summary.last_activity_at;
  const durationMin =
    startedAt && endedAt
      ? Math.max(
          0,
          (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000
        )
      : undefined;
  const tools = capToolHistogram(summary.tool_counts);

  return {
    source: 'orgx-mcp-worker',
    session_id: summary.session_id.slice(0, MAX_SESSION_ID_LENGTH),
    source_client: (sourceClient ?? summary.client_name ?? 'api').slice(
      0,
      MAX_SOURCE_CLIENT_LENGTH
    ),
    ...(asUuid(summary.initiative_id)
      ? { initiative_id: asUuid(summary.initiative_id) }
      : {}),
    ...(asUuid(summary.workspace_id)
      ? { workspace_id: asUuid(summary.workspace_id) }
      : {}),
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(durationMin === undefined
      ? {}
      : { duration_min: Math.round(durationMin * 100) / 100 }),
    tool_calls: summary.tool_call_count,
    ...(tools ? { tools } : {}),
    metadata: {
      mcp_session_summary: true,
      unique_tool_count: summary.unique_tool_count,
      ...(summary.client_name ? { client_name: summary.client_name } : {}),
      ...(summary.client_version
        ? { client_version: summary.client_version }
        : {}),
      ...(summary.workspace_id ? { workspace_id: summary.workspace_id } : {}),
      ...(summary.initiative_id
        ? { initiative_id: summary.initiative_id }
        : {}),
    },
  };
}

/**
 * Body for POST /api/client/live/activity. correlation_id and source_client
 * are required when run_id is absent, so the summary always carries both
 * ('api' is the neutral fallback when the client could not be identified).
 */
export function buildSessionSummaryActivityBody(
  summary: SessionSummary,
  sourceClient: ReportingSourceClient | null
): Record<string, unknown> {
  const clientLabel = summary.client_name ?? 'unidentified client';
  return {
    initiative_id: summary.initiative_id,
    message: `MCP session ended · ${summary.tool_call_count} tool call${
      summary.tool_call_count === 1 ? '' : 's'
    } across ${summary.unique_tool_count} tool${
      summary.unique_tool_count === 1 ? '' : 's'
    } from ${clientLabel}`,
    correlation_id: `mcp-session-${summary.session_id}`,
    source_client: sourceClient ?? 'api',
    phase: 'completed',
    level: 'info',
    metadata: summary,
  };
}

/**
 * Monkey-patch `server.registerTool` (same seam as the guidance wrapper) so
 * every tool invocation — including registerAppTool widget tools, which route
 * through registerTool — reports to the observer before the handler runs.
 * The observer must never throw; failures are contained here regardless.
 */
export function installSessionToolObservationWrapper(
  mcpServer: McpServer,
  observe: (toolName: string) => void
) {
  const server = mcpServer as unknown as {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: (...args: unknown[]) => unknown
    ) => unknown;
  };
  const original = server.registerTool.bind(server);

  server.registerTool = ((
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown
  ) => {
    const wrappedHandler = (...args: unknown[]) => {
      try {
        observe(name);
      } catch (error) {
        console.warn('[mcp:session-summary] tool observation failed', {
          toolName: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return handler(...args);
    };
    return original(name, config, wrappedHandler);
  }) as typeof server.registerTool;
}
