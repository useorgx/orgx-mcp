import {
  DEPRECATION_SUNSET_AT_ISO,
  DEPRECATION_WINDOW_DAYS,
  resolveDeprecatedToolCall,
  withDeprecatedToolWarningHeaders,
  type DeprecatedToolWarning,
} from './deprecatedTools';
import {
  captureWorkerPosthogEvent,
  resolveAnonymousDistinctId,
  type PosthogTelemetryEnv,
} from './posthogTelemetry';
import { recordDurableMcpToolInvocation } from './mcpInvocationTelemetry';
import type { OrgxApiEnv } from './orgxApi';
import type { SourceClient } from './cross-pollination';
import {
  getSessionClientInfo,
  parseInitializeClientInfo,
  putSessionClientInfo,
  resolveSessionClientInfoKv,
  type McpHandshakeClientInfo,
} from './sessionClientInfo';
import { resolveToolProfile } from './toolProfiles';
import {
  validateMcpRequestOrigin,
  type McpOriginValidationEnv,
} from './mcpOriginValidation';

export type ExecutionContextWithProps<Props> = ExecutionContext & {
  props?: Props;
};

export type AgentHandler<Env, Props> = {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContextWithProps<Props>
  ): Promise<Response>;
};

export type AuthResult = {
  userId?: string;
  scope?: string;
  email?: string;
  response?: Response;
};

type McpToolCallTelemetry = {
  jsonrpcId?: string | number;
  toolName: string;
  args: Record<string, unknown>;
  context?: unknown;
};

type McpJourneyTimings = {
  requestStartedAt: number;
  authMs: number;
  normalizationMs: number;
  handlerMs: number;
  responseHeadersMs: number;
  profile?: string;
  sessionPresent: boolean;
};

type McpLogicalResult = {
  isError: boolean;
  errorCode?: string;
  errorKind?: string;
};

type McpResponseObservation = McpLogicalResult & {
  firstByteMs?: number;
  fullResponseMs: number;
  responseBytes?: number;
  responseSizeSource: 'body_clone' | 'content_length' | 'unavailable';
  responseReadError: boolean;
  responseParseTruncated: boolean;
};

const MAX_TELEMETRY_RESPONSE_PARSE_BYTES = 2 * 1024 * 1024;
const MAX_TELEMETRY_RESPONSE_READ_MS = 30_000;

export type AuthenticateRequest<Env> = (
  request: Request,
  env: Env
) => Promise<AuthResult>;

type McpTransportExceptionOptions = {
  stage?: string;
  status?: number;
};

/**
 * Normalize tool names by stripping server namespace prefixes.
 * MCP clients may call tools as "ServerName:tool_name" but our tools
 * are registered without prefixes. This strips common patterns:
 * - "Orgx:spawn_agent_task" → "spawn_agent_task"
 * - "orgx-mcp:spawn_agent_task" → "spawn_agent_task"
 * - "OrgX:spawn_agent_task" → "spawn_agent_task"
 */
function normalizeToolName(name: string): string {
  // Strip common server name prefixes (case-insensitive match)
  const prefixPatterns = [
    /^mcp__orgx-mcp__/i, // mcp__orgx-mcp__spawn_agent_task
    /^mcp__orgx__/i, // mcp__orgx__spawn_agent_task
    /^orgx-mcp[._:/-]/i, // orgx-mcp: / orgx-mcp. / orgx-mcp/
    /^orgx-mcp[_:-]/i, // orgx-mcp:, orgx-mcp-
    /^orgx[.:/-]/i, // orgx: / orgx. / orgx/
    /^orgx[:-]/i, // Orgx:, orgx-
    /^OrgX[:-]/, // Exact case OrgX:
  ];

  for (const pattern of prefixPatterns) {
    if (pattern.test(name)) {
      const normalized = name.replace(pattern, '');
      console.info('[mcp] Normalized tool name', {
        original: name,
        normalized,
      });
      return normalized;
    }
  }

  return name;
}

/**
 * Normalize MCP request body if it's a tools/call request.
 * This ensures tool names work regardless of namespace prefixes.
 */
async function normalizeRequestBody(request: Request): Promise<{
  request: Request;
  warning?: DeprecatedToolWarning;
  toolCall?: McpToolCallTelemetry;
  initializeClientInfo?: McpHandshakeClientInfo;
}> {
  // Only process POST requests with JSON body
  if (request.method !== 'POST') return { request };

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return { request };

  try {
    const body = (await request.clone().json()) as {
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    // The initialize handshake is the one place MCP clients self-identify.
    // Surface clientInfo so the transport can persist it per session.
    const initializeClientInfo = parseInitializeClientInfo(body) ?? undefined;
    if (initializeClientInfo) {
      return { request, initializeClientInfo };
    }

    // Only normalize tools/call requests
    if (body.method !== 'tools/call' || !body.params?.name) {
      return { request };
    }

    const originalName = body.params.name;
    const normalizedName = normalizeToolName(originalName);
    const originalArgs =
      body.params.arguments && typeof body.params.arguments === 'object'
        ? body.params.arguments
        : {};
    const { resolvedToolId, resolvedArgs, warning } = resolveDeprecatedToolCall(
      normalizedName,
      originalArgs
    );
    const toolCall = buildMcpToolCallTelemetry(
      body.id,
      resolvedToolId,
      resolvedArgs
    );

    // If nothing changed and there is no warning, return the original request.
    if (
      resolvedToolId === originalName &&
      resolvedArgs === originalArgs &&
      !warning
    ) {
      return { request, toolCall };
    }

    // Create new request with normalized tool name
    const newBody = {
      ...body,
      params: { ...body.params, name: resolvedToolId, arguments: resolvedArgs },
    };
    return {
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(newBody),
      }),
      warning,
      toolCall,
    };
  } catch {
    // If parsing fails, return original request
    return { request };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function buildMcpToolCallTelemetry(
  jsonrpcId: string | number | undefined,
  toolName: string,
  args: Record<string, unknown>
): McpToolCallTelemetry {
  return {
    jsonrpcId,
    toolName,
    args,
    context: args._context,
  };
}

function classifyToolFamily(toolName: string): string {
  if (toolName === 'orgx_emit_activity') return 'activity';
  if (
    toolName === 'orgx_request_attention' ||
    toolName === 'orgx_poll_attention' ||
    toolName === 'orgx_ack_attention' ||
    toolName === 'orgx_request_question' ||
    toolName === 'orgx_poll_question'
  ) {
    return 'decision';
  }
  if (toolName === 'orgx_write') return 'entity_write';
  if (toolName === 'orgx_act' || toolName === 'entity_action') {
    return 'entity_action';
  }
  if (toolName === 'orgx_spawn' || toolName === 'spawn_agent_task') {
    return 'agent_dispatch';
  }
  if (toolName === 'orgx_decide' || toolName.includes('decision')) {
    return 'decision';
  }
  if (toolName === 'orgx_submit_receipt') return 'receipt';
  if (
    toolName.startsWith('get_') ||
    toolName.startsWith('list_') ||
    toolName.startsWith('query_') ||
    toolName.startsWith('recall_') ||
    toolName === 'orgx_search' ||
    toolName === 'orgx_inspect' ||
    toolName === 'orgx_recommend'
  ) {
    return 'read';
  }
  return 'mcp_tool';
}

function extractClientContext(context: unknown): {
  clientName?: string;
  clientPlatform?: string;
  clientVersion?: string;
  conversationId?: string;
  stepId?: string;
  stepIndex?: number;
  previousToolId?: string;
  expectedNextToolId?: string;
  previousExpectedNextToolId?: string;
  workingDirectoryPresent: boolean;
} {
  const record = asRecord(context);
  const client = asRecord(record.client);
  const conversation = asRecord(record.conversation);
  const user = asRecord(record.user);
  const request = asRecord(record.request);
  const journey = asRecord(record.journey);
  const session = asRecord(record.session);
  const stepIndex = [
    journey.stepIndex,
    journey.step_index,
    request.stepIndex,
    request.step_index,
    session.stepIndex,
    session.step_index,
  ].find((value) => typeof value === 'number' && Number.isFinite(value));
  return {
    clientName: pickString(client.name),
    clientPlatform: pickString(client.platform),
    clientVersion: pickString(client.version),
    conversationId: pickString(conversation.id),
    stepId: pickString(
      journey.stepId,
      journey.step_id,
      request.stepId,
      request.step_id,
      session.stepId,
      session.step_id
    ),
    stepIndex: typeof stepIndex === 'number' ? stepIndex : undefined,
    previousToolId: pickString(
      journey.previousTool,
      journey.previous_tool,
      journey.previousToolId,
      journey.previous_tool_id,
      request.previousTool,
      request.previous_tool
    ),
    expectedNextToolId: pickString(
      journey.expectedNextTool,
      journey.expected_next_tool,
      journey.nextTool,
      journey.next_tool
    ),
    previousExpectedNextToolId: pickString(
      journey.previousExpectedNextTool,
      journey.previous_expected_next_tool,
      request.previousExpectedNextTool,
      request.previous_expected_next_tool
    ),
    workingDirectoryPresent: Boolean(pickString(user.workingDirectory)),
  };
}

function isOrgxApiTelemetryConfigured(env: unknown): env is OrgxApiEnv {
  const record = asRecord(env);
  return Boolean(
    pickString(record.ORGX_API_URL) &&
      pickString(record.ORGX_SERVICE_KEY)?.startsWith('oxk-')
  );
}

function sanitizeToolCallMetadata(toolCall: McpToolCallTelemetry): {
  metadata: Record<string, unknown>;
  workspaceId?: string;
  sourceClient?: SourceClient;
} {
  const args = toolCall.args;
  const context = extractClientContext(toolCall.context);
  const workspaceId = pickString(args.workspace_id, args.workspaceId);
  const initiativeId = pickString(args.initiative_id, args.initiativeId);
  const workstreamId = pickString(args.workstream_id, args.workstreamId);
  const taskId = pickString(args.task_id, args.taskId);
  const entityType = pickString(args.type, args.entity_type, args.entityType);
  const action = pickString(args.action, args.operation, args.phase);
  const sourceClient = normalizeTelemetrySourceClient(
    pickString(
      asRecord(asRecord(toolCall.context).client).name,
      args.source_client,
      args.sourceClient
    )
  );

  return {
    workspaceId,
    sourceClient,
    metadata: {
      tool_family: classifyToolFamily(toolCall.toolName),
      entity_type: entityType,
      action,
      argument_count: Object.keys(args).filter((key) => key !== '_context')
        .length,
      estimated_argument_bytes: JSON.stringify(args).length,
      has_workspace_id: Boolean(workspaceId),
      has_initiative_id: Boolean(initiativeId),
      has_workstream_id: Boolean(workstreamId),
      has_task_id: Boolean(taskId),
      argument_keys: Object.keys(args)
        .filter((key) => key !== '_context')
        .sort()
        .slice(0, 40),
      client_name: context.clientName,
      client_platform: context.clientPlatform,
      client_version: context.clientVersion,
      conversation_id: context.conversationId,
      step_id: pickString(args.step_id, args.stepId, context.stepId),
      step_index: context.stepIndex,
      previous_tool_id: pickString(
        args.previous_tool,
        args.previousTool,
        context.previousToolId
      ),
      expected_next_tool_id: pickString(
        args.expected_next_tool,
        args.expectedNextTool,
        context.expectedNextToolId
      ),
      previous_expected_next_tool_id: context.previousExpectedNextToolId,
      followed_expected_next_tool:
        context.previousExpectedNextToolId === undefined
          ? undefined
          : context.previousExpectedNextToolId === toolCall.toolName,
      has_conversation_id: Boolean(context.conversationId),
      has_working_directory: context.workingDirectoryPresent,
    },
  };
}

function normalizeTelemetryCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return normalized || undefined;
}

function logicalResultFromRecord(value: unknown): McpLogicalResult {
  const envelope = asRecord(value);
  const jsonRpcError = asRecord(envelope.error);
  const jsonRpcErrorData = asRecord(jsonRpcError.data);
  const result = Object.keys(asRecord(envelope.result)).length
    ? asRecord(envelope.result)
    : envelope;
  const structured = asRecord(result.structuredContent);
  const structuredErrorValue = structured.error;
  const structuredError = asRecord(structuredErrorValue);
  const hasStructuredError =
    (typeof structuredErrorValue === 'string' &&
      structuredErrorValue.trim().length > 0) ||
    Object.keys(structuredError).length > 0;
  const meta = asRecord(structured.meta);
  const isJsonRpcError = Object.keys(jsonRpcError).length > 0;
  const isError =
    isJsonRpcError ||
    result.isError === true ||
    result.is_error === true ||
    structured.ok === false ||
    (structured.ok !== true && hasStructuredError);

  if (!isError) return { isError: false };

  const errorCode = normalizeTelemetryCode(
    jsonRpcErrorData.code ??
      jsonRpcError.code ??
      structuredError.code ??
      structured.error_code ??
      structured.code ??
      meta.error_code
  );
  const errorKind = normalizeTelemetryCode(
    jsonRpcErrorData.error_kind ??
      jsonRpcErrorData.kind ??
      structuredError.kind ??
      structuredError.error_kind ??
      structured.error_kind ??
      meta.error_kind ??
      errorCode
  );

  return {
    isError: true,
    errorCode: errorCode ?? (isJsonRpcError ? 'jsonrpc_error' : 'mcp_tool_error'),
    errorKind: errorKind ?? (isJsonRpcError ? 'jsonrpc_error' : 'mcp_tool_error'),
  };
}

function parseLogicalMcpResult(text: string): McpLogicalResult {
  const candidates: unknown[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { isError: false };

  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // Ignore keepalives and non-JSON SSE data.
      }
    }
  }

  for (const candidate of candidates) {
    const logical = logicalResultFromRecord(candidate);
    if (logical.isError) return logical;
  }
  return { isError: false };
}

async function observeMcpResponse(
  response: Response,
  requestStartedAt: number,
  now: () => number = () => Date.now()
): Promise<McpResponseObservation> {
  const contentLengthValue = response.headers.get('content-length');
  const contentLength = contentLengthValue === null
    ? Number.NaN
    : Number(contentLengthValue);
  const headerBytes = Number.isFinite(contentLength) && contentLength >= 0
    ? contentLength
    : undefined;
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return {
      ...logicalResultFromRecord({}),
      fullResponseMs: Math.max(0, now() - requestStartedAt),
      responseBytes: headerBytes,
      responseSizeSource: headerBytes === undefined ? 'unavailable' : 'content_length',
      responseReadError: true,
      responseParseTruncated: false,
    };
  }

  if (!clone.body) {
    return {
      isError: false,
      fullResponseMs: Math.max(0, now() - requestStartedAt),
      responseBytes: headerBytes ?? 0,
      responseSizeSource: headerBytes === undefined ? 'body_clone' : 'content_length',
      responseReadError: false,
      responseParseTruncated: false,
    };
  }

  const reader = clone.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  let capturedBytes = 0;
  let firstByteMs: number | undefined;
  let responseReadError = false;
  const responseReadDeadline = Date.now() + MAX_TELEMETRY_RESPONSE_READ_MS;

  try {
    while (true) {
      const remainingMs = responseReadDeadline - Date.now();
      if (remainingMs <= 0) {
        responseReadError = true;
        await reader.cancel('telemetry response observation timed out');
        break;
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(null), remainingMs);
        }),
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
      if (read === null) {
        responseReadError = true;
        await reader.cancel('telemetry response observation timed out');
        break;
      }
      const { done, value } = read;
      if (done) break;
      if (!value) continue;
      if (firstByteMs === undefined) {
        firstByteMs = Math.max(0, now() - requestStartedAt);
      }
      responseBytes += value.byteLength;
      if (capturedBytes < MAX_TELEMETRY_RESPONSE_PARSE_BYTES) {
        const remaining = MAX_TELEMETRY_RESPONSE_PARSE_BYTES - capturedBytes;
        const captured = value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(captured);
        capturedBytes += captured.byteLength;
      }
    }
  } catch {
    responseReadError = true;
  } finally {
    reader.releaseLock();
  }

  const parseBuffer = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    parseBuffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const logical = parseLogicalMcpResult(new TextDecoder().decode(parseBuffer));

  return {
    ...logical,
    firstByteMs,
    fullResponseMs: Math.max(0, now() - requestStartedAt),
    responseBytes: responseReadError && responseBytes === 0 ? headerBytes : responseBytes,
    responseSizeSource:
      responseReadError && responseBytes === 0
        ? headerBytes === undefined
          ? 'unavailable'
          : 'content_length'
        : 'body_clone',
    responseReadError,
    responseParseTruncated: responseBytes > capturedBytes,
  };
}

function normalizeTelemetrySourceClient(
  value: string | undefined
): SourceClient | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'claude-code' || normalized === 'claude_code')
    return 'claude';
  if (normalized === 'chatgpt' || normalized === 'openai') return 'chatgpt';
  if (normalized === 'codex') return 'codex';
  if (normalized === 'opencode' || normalized === 'open-code') return 'opencode';
  if (normalized === 'openclaw' || normalized === 'openclaw-plugin')
    return 'openclaw';
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'vscode' || normalized === 'vs-code') return 'vscode';
  if (normalized === 'goose') return 'goose';
  if (normalized === 'api') return 'api';
  if (
    normalized === 'web' ||
    normalized === 'web-ui' ||
    normalized === 'webapp'
  ) {
    return 'webapp';
  }
  return 'other';
}

async function captureMcpToolCallVisibility<Env>(
  env: Env,
  ctx: ExecutionContextWithProps<unknown>,
  auth: AuthResult,
  toolCall: McpToolCallTelemetry | undefined,
  response: Response,
  journey: McpJourneyTimings,
  errorCode?: string | null,
  sessionId?: string | null
): Promise<void> {
  if (!toolCall) return;

  const observation = await observeMcpResponse(
    response,
    journey.requestStartedAt
  );
  const headerErrorKind = normalizeTelemetryCode(
    response.headers.get('x-orgx-mcp-error-kind')
  );
  const headerErrorCode = normalizeTelemetryCode(
    response.headers.get('x-orgx-mcp-error-code')
  );
  const resolvedErrorCode = normalizeTelemetryCode(errorCode) ??
    headerErrorCode ??
    observation.errorCode;
  const resolvedErrorKind = headerErrorKind ?? observation.errorKind ??
    (response.status >= 400 ? `http_${response.status}` : undefined);
  const status =
    resolvedErrorCode || observation.isError || response.status >= 400
      ? 'error'
      : 'success';
  const distinctId = auth.userId ?? resolveAnonymousDistinctId(ctx);
  const { metadata, workspaceId, sourceClient } =
    sanitizeToolCallMetadata(toolCall);

  // Agents rarely repeat their identity in _context, so fall back to the
  // clientInfo captured from this session's initialize handshake. Explicit
  // agent-supplied context always wins.
  let handshakeClientInfo: McpHandshakeClientInfo | null = null;
  if ((!sourceClient || !metadata.client_name) && sessionId) {
    const kv = resolveSessionClientInfoKv(env);
    if (kv) {
      handshakeClientInfo = await getSessionClientInfo(kv, sessionId);
    }
  }
  const handshakeSourceClient = handshakeClientInfo
    ? normalizeTelemetrySourceClient(handshakeClientInfo.name)
    : undefined;
  const effectiveSourceClient = sourceClient ?? handshakeSourceClient;
  if (handshakeClientInfo && !metadata.client_name) {
    metadata.client_name = handshakeClientInfo.name;
    metadata.client_version =
      metadata.client_version ?? handshakeClientInfo.version;
    metadata.client_name_source = 'initialize_handshake';
  }

  const toolFamily = classifyToolFamily(toolCall.toolName);
  const contentLengthHeader = response.headers.get('content-length');
  const responseSizeHeader =
    contentLengthHeader === null ? null : Number(contentLengthHeader);
  const serverTiming = response.headers.get('server-timing') ?? '';
  const knownServerTimings = new Map(
    serverTiming.split(',').flatMap((entry) => {
      const match = entry
        .trim()
        .match(/^([a-z0-9_-]+)(?:;dur=([0-9]+(?:\.[0-9]+)?))?/i);
      if (!match?.[1] || !match[2]) return [];
      return [[match[1].toLowerCase(), Number(match[2])] as const];
    })
  );
  const rateLimitStrategy = response.headers.get(
    'x-orgx-rate-limit-strategy'
  );
  const transportMetadata = {
    ...metadata,
    http_status: response.status,
    journey_phase: 'complete',
    auth_ms: journey.authMs,
    session_ms: knownServerTimings.get('session'),
    request_normalization_ms: journey.normalizationMs,
    handler_ms: journey.handlerMs,
    response_headers_ms: journey.responseHeadersMs,
    response_shaping_ms:
      knownServerTimings.get('response_shaping') ??
      knownServerTimings.get('response_build'),
    first_response_byte_ms: observation.firstByteMs,
    full_response_ms: observation.fullResponseMs,
    response_size_bytes: observation.responseBytes,
    response_size_source: observation.responseSizeSource,
    response_read_error: observation.responseReadError,
    response_parse_truncated: observation.responseParseTruncated,
    mcp_logical_error: observation.isError,
    error_kind: resolvedErrorKind,
    profile: journey.profile,
    session_present: journey.sessionPresent,
    response_measurement_point: 'worker_response_clone',
    response_size_header_bytes:
      responseSizeHeader !== null && Number.isFinite(responseSizeHeader)
        ? responseSizeHeader
        : undefined,
    edge_rate_limit_ms: knownServerTimings.get('edge_rate_limit'),
    edge_rate_limit_backend_ms:
      knownServerTimings.get('rate_limit_backend'),
    edge_rate_limit_identity_ms:
      knownServerTimings.get('rate_limit_identity'),
    edge_rate_limit_billing_ms:
      knownServerTimings.get('rate_limit_billing'),
    edge_rate_limit_strategy:
      rateLimitStrategy && /^[a-z_]+$/.test(rateLimitStrategy)
        ? rateLimitStrategy
        : undefined,
  };
  const requestId =
    typeof toolCall.jsonrpcId === 'string' ||
    typeof toolCall.jsonrpcId === 'number'
      ? String(toolCall.jsonrpcId)
      : undefined;

  const deliveries: Promise<unknown>[] = [];
  captureWorkerPosthogEvent({
    env: env as PosthogTelemetryEnv,
    ctx: {
      waitUntil(promise) {
        deliveries.push(Promise.resolve(promise));
      },
    },
    event: 'mcp_tool_invocation',
    distinctId,
    properties: {
      ...transportMetadata,
      tool_id: toolCall.toolName,
      status,
      latency_ms: observation.fullResponseMs,
      tool_family: toolFamily,
      auth_scope: auth.scope,
      error_code: resolvedErrorCode,
      error_kind: resolvedErrorKind,
      has_user_id: Boolean(auth.userId),
      workspace_id: workspaceId,
      source_client: effectiveSourceClient,
      request_id: requestId,
    },
  });

  if (isOrgxApiTelemetryConfigured(env)) {
    deliveries.push(recordDurableMcpToolInvocation({
      env,
      toolId: toolCall.toolName,
      status,
      latencyMs: observation.fullResponseMs,
      metadata: transportMetadata,
      userId: auth.userId ?? null,
      workspaceId: workspaceId ?? null,
      sourceClient: effectiveSourceClient ?? null,
      context: toolCall.context,
      fallbackClient: handshakeClientInfo,
      errorCode: resolvedErrorCode ??
        (status === 'error' ? resolvedErrorKind ?? `http_${response.status}` : null),
      isWidgetTool: false,
      toolFamily,
      requestId,
    }));
  }

  await Promise.allSettled(deliveries);
}

function captureDeprecatedToolTelemetry<Env>(
  env: Env,
  ctx: ExecutionContextWithProps<unknown>,
  auth: AuthResult,
  warning?: DeprecatedToolWarning
): void {
  if (!warning) return;

  const distinctId = auth.userId ?? resolveAnonymousDistinctId(ctx);
  captureWorkerPosthogEvent({
    env: env as PosthogTelemetryEnv,
    ctx,
    event: 'mcp_deprecated_tool_called',
    distinctId,
    properties: {
      deprecated_tool_id: warning.deprecatedToolId,
      replacement_tool_id: warning.replacementToolId,
      replacement_action: warning.replacementAction,
      routed: warning.routed,
      auth_scope: auth.scope,
      has_user_id: Boolean(auth.userId),
      deprecation_sunset_at: DEPRECATION_SUNSET_AT_ISO,
      deprecation_window_days: DEPRECATION_WINDOW_DAYS,
    },
  });
}

function classifyMcpToolError(error: unknown): string {
  if (!(error instanceof Error) || !error.name) return 'exception';
  const normalized = error.name
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .slice(0, 64);
  return normalized ? `exception_${normalized}` : 'exception';
}

async function readJsonRpcId(request: Request): Promise<string | number | null> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;

  try {
    const body = (await request.clone().json()) as { id?: unknown };
    if (typeof body.id === 'string' || typeof body.id === 'number') {
      return body.id;
    }
  } catch {
    // If the request body cannot be read, return a valid JSON-RPC error id.
  }

  return null;
}

export async function buildMcpTransportExceptionResponse(
  request: Request,
  error: unknown,
  options: McpTransportExceptionOptions = {}
): Promise<Response> {
  const status = options.status ?? 200;
  const errorKind = classifyMcpToolError(error);
  const url = new URL(request.url);
  const healthCheckUrl = new URL('/healthz?check=upstream', url.origin);
  const id = await readJsonRpcId(request);
  const stage = options.stage ?? 'mcp_transport';

  const payload = {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603,
      message:
        'OrgX MCP hit a transport failure before the tool could return a structured result.',
      data: {
        code: 'mcp_transport_exception',
        error_kind: errorKind,
        stage,
        retryable: true,
        health_check_url: healthCheckUrl.toString(),
        next_steps: [
          'Retry the tool call once.',
          'If it repeats, reconnect the OrgX MCP OAuth session.',
          'Check /healthz?check=upstream to separate upstream health from an authenticated-session failure.',
        ],
      },
    },
  };

  return Response.json(payload, {
    status,
    headers: {
      'x-orgx-mcp-error-code': 'mcp_transport_exception',
      'x-orgx-mcp-error-kind': errorKind,
      'x-orgx-mcp-error-stage': stage,
      'x-orgx-retryable': 'true',
    },
  });
}

export async function handleMcpRequest<Env, Props>(
  request: Request,
  env: Env,
  ctx: ExecutionContextWithProps<Props>,
  handler: AgentHandler<Env, Props>,
  authenticateRequest: AuthenticateRequest<Env>
) {
  const invalidOrigin = validateMcpRequestOrigin(
    request,
    env as McpOriginValidationEnv
  );
  if (invalidOrigin) return invalidOrigin;

  const requestStartedAt = Date.now();
  const connectionProfile = resolveToolProfile(
    new URL(request.url).searchParams.get('profile') ??
      pickString(asRecord(ctx.props).profile)
  ).name;
  if (request.method === 'OPTIONS') {
    return withCors(
      new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,DELETE',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, X-Access-Token, Mcp-Session-Id',
        },
      }),
      request
    );
  }
  const authStartedAt = Date.now();
  const auth = await authenticateRequest(request, env);
  const authMs = Math.max(0, Date.now() - authStartedAt);
  if ('response' in auth && auth.response) return withCors(auth.response, request);
  const existingProps = asRecord(ctx.props);
  (ctx as ExecutionContextWithProps<Props>).props = {
    ...existingProps,
    userId: auth.userId,
    scope: auth.scope,
    email: auth.email,
    profile: connectionProfile,
  } as unknown as Props;

  // Normalize tool names in the request body (strips server prefixes like "Orgx:")
  const normalizationStartedAt = Date.now();
  const { request: normalizedRequest, warning, toolCall, initializeClientInfo } =
    await normalizeRequestBody(request);
  const normalizationMs = Math.max(0, Date.now() - normalizationStartedAt);
  captureDeprecatedToolTelemetry(env, ctx as ExecutionContextWithProps<unknown>, auth, warning);

  const requestSessionId = request.headers.get('mcp-session-id')?.trim() || null;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await handler.fetch(normalizedRequest, env, ctx);
  } catch (error) {
    const handlerMs = Math.max(0, Date.now() - startedAt);
    ctx.waitUntil?.(captureMcpToolCallVisibility(
      env,
      ctx as ExecutionContextWithProps<unknown>,
      auth,
      toolCall,
      new Response(null, { status: 500 }),
      {
        requestStartedAt,
        authMs,
        normalizationMs,
        handlerMs,
        responseHeadersMs: Math.max(0, Date.now() - requestStartedAt),
        profile: connectionProfile,
        sessionPresent: Boolean(requestSessionId),
      },
      classifyMcpToolError(error),
      requestSessionId
    ));
    throw error;
  }
  const handlerMs = Math.max(0, Date.now() - startedAt);

  // Persist the handshake identity per MCP session. The server assigns the
  // session id on the initialize response, so prefer the response header.
  if (initializeClientInfo) {
    const kv = resolveSessionClientInfoKv(env);
    const sessionId =
      response.headers.get('mcp-session-id')?.trim() || requestSessionId;
    if (kv && sessionId) {
      ctx.waitUntil?.(
        putSessionClientInfo(kv, sessionId, initializeClientInfo)
      );
    }
  }

  ctx.waitUntil?.(captureMcpToolCallVisibility(
    env,
    ctx as ExecutionContextWithProps<unknown>,
    auth,
    toolCall,
    response,
    {
      requestStartedAt,
      authMs,
      normalizationMs,
      handlerMs,
      responseHeadersMs: Math.max(0, Date.now() - requestStartedAt),
      profile: connectionProfile,
      sessionPresent: Boolean(requestSessionId),
    },
    undefined,
    requestSessionId
  ));
  return withCors(
    withDeprecatedToolWarningHeaders(response, warning),
    request
  );
}

export function withSseKeepAlive(
  response: Response,
  intervalMs = 15000
): Response {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body)
    return response;

  const encoder = new TextEncoder();
  const reader = response.body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Send an initial comment so clients see data immediately.
      controller.enqueue(encoder.encode(':\n\n'));

      const timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(':\n\n'));
        } catch {
          // ignore
        }
      }, intervalMs);

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } catch {
          // ignore stream errors (client disconnects, etc.)
        } finally {
          clearInterval(timer);
          try {
            controller.close();
          } catch {
            // ignore
          }
        }
      };

      void pump();
    },
  });

  return new Response(stream, response);
}

export async function handleMcpWebSocket<Env, Props>(
  request: Request,
  env: Env,
  ctx: ExecutionContextWithProps<Props>,
  handler: AgentHandler<Env, Props>,
  authenticateRequest: AuthenticateRequest<Env>
) {
  const invalidOrigin = validateMcpRequestOrigin(
    request,
    env as McpOriginValidationEnv
  );
  if (invalidOrigin) return invalidOrigin;

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Upgrade Required', { status: 426 });
  }

  const auth = await authenticateRequest(request, env);
  if ('response' in auth && auth.response) {
    return withCors(auth.response, request);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const props = { userId: auth.userId, scope: auth.scope, email: auth.email } as Props;
  const ctxWithProps = ctx as ExecutionContextWithProps<Props>;
  ctxWithProps.props = props;
  // Preserve existing session IDs from reconnecting clients so auth/context
  // survives transient disconnects (deploys, network blips).
  const sessionHeader = request.headers.get('mcp-session-id');
  const session: { id: string | null } = {
    id:
      typeof sessionHeader === 'string' && sessionHeader.trim().length > 0
        ? sessionHeader.trim()
        : null,
  };
  const socketState = { closed: false };

  server.accept();

  server.addEventListener('message', (event) => {
    const data =
      typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
    ctx.waitUntil(
      forwardMcpMessage(
        data,
        request,
        env,
        ctxWithProps,
        handler,
        session,
        server,
        socketState
      ).catch((error) => {
        if (!socketState.closed) {
          console.error('[mcp] websocket bridge error', error);
        }
      })
    );
  });

  // Intentionally no auto-DELETE on close: clients may reconnect and resume
  // the same MCP session ID after transient disconnects.
  server.addEventListener('close', () => {
    socketState.closed = true;
  });
  server.addEventListener('error', (error) => {
    socketState.closed = true;
    console.error('[mcp] websocket error', error);
  });

  return new Response(null, { status: 101, webSocket: client });
}

function setCorsOrigin(headers: Headers, request?: Request) {
  const rawOrigin = request?.headers.get('origin');
  let allowOrigin = '*';
  if (rawOrigin) {
    try {
      allowOrigin = new URL(rawOrigin).origin;
    } catch {
      allowOrigin = 'null';
    }
  }
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  if (rawOrigin) {
    const vary = headers.get('Vary');
    const values = (vary ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (!values.some((value) => value.toLowerCase() === 'origin')) {
      values.push('Origin');
    }
    headers.set('Vary', values.join(', '));
  }
}

function withCors(response: Response, request?: Request) {
  const headers = new Headers(response.headers);
  setCorsOrigin(headers, request);
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Access-Token, Mcp-Session-Id'
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Apply CORS headers and additional headers (e.g., rate limit headers)
 */
export function withCorsAndHeaders(
  response: Response,
  extraHeaders: Record<string, string>,
  request?: Request
) {
  const headers = new Headers(response.headers);
  setCorsOrigin(headers, request);
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Access-Token, Mcp-Session-Id'
  );

  // Add extra headers (rate limit info)
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (key.toLowerCase() === 'server-timing' && headers.has(key)) {
      headers.append(key, value);
    } else {
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export { withCors };

async function forwardMcpMessage<Env, Props>(
  body: string,
  originalRequest: Request,
  env: Env,
  ctx: ExecutionContextWithProps<Props>,
  handler: AgentHandler<Env, Props>,
  session: { id: string | null },
  ws: WebSocket,
  socketState: { closed: boolean }
) {
  let parsedBody: { method?: string; params?: { name?: string } };
  try {
    parsedBody = JSON.parse(body);
  } catch {
    sendWebSocketPayload(
      ws,
      socketState,
      JSON.stringify({
        event: 'error',
        data: { message: 'Invalid JSON-RPC payload' },
      })
    );
    return;
  }

  // Normalize tool names for tools/call requests (strip server prefixes like "Orgx:")
  let normalizedBody = body;
  if (parsedBody.method === 'tools/call' && parsedBody.params?.name) {
    const originalName = parsedBody.params.name;
    const normalizedName = normalizeToolName(originalName);
    if (normalizedName !== originalName) {
      parsedBody.params.name = normalizedName;
      normalizedBody = JSON.stringify(parsedBody);
    }
  }

  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  });
  const authorization = originalRequest.headers.get('authorization');
  if (authorization) {
    headers.set('authorization', authorization);
  }
  if (session.id) {
    headers.set('mcp-session-id', session.id);
  }

  const target = new URL('/mcp', originalRequest.url);
  const response = await handler.fetch(
    new Request(target.toString(), {
      method: 'POST',
      headers,
      body: normalizedBody,
    }),
    env,
    ctx
  );

  if (response.status >= 400) {
    const text = await response
      .text()
      .catch(() => 'Failed to execute MCP request');
    sendWebSocketPayload(
      ws,
      socketState,
      JSON.stringify({
        event: 'error',
        data: { status: response.status, message: text },
      })
    );
    return;
  }

  const returnedSession = response.headers.get('mcp-session-id');
  if (returnedSession) {
    session.id = returnedSession;
  }

  if (!response.body) {
    return;
  }

  await pumpSseToWebSocket(response, ws, socketState);
}

async function pumpSseToWebSocket(
  response: Response,
  ws: WebSocket,
  socketState: { closed: boolean }
) {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (socketState.closed) {
      await reader.cancel().catch(() => undefined);
      return;
    }

    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const eventName =
        rawEvent
          .split('\n')
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          ?.trim() ?? 'message';
      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length > 0) {
        const payloadText = dataLines.join('\n');
        let data: unknown = payloadText;
        try {
          data = JSON.parse(payloadText);
        } catch {
          // keep as string
        }
        if (
          !sendWebSocketPayload(
            ws,
            socketState,
            JSON.stringify({ event: eventName, data })
          )
        ) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
}

function sendWebSocketPayload(
  ws: WebSocket,
  socketState: { closed: boolean },
  payload: string
) {
  if (socketState.closed) {
    return false;
  }

  try {
    ws.send(payload);
    return true;
  } catch {
    socketState.closed = true;
    return false;
  }
}
