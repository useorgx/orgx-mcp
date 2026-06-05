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

export type AuthenticateRequest<Env> = (
  request: Request,
  env: Env
) => Promise<AuthResult>;

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
  workingDirectoryPresent: boolean;
} {
  const record = asRecord(context);
  const client = asRecord(record.client);
  const conversation = asRecord(record.conversation);
  const user = asRecord(record.user);
  return {
    clientName: pickString(client.name),
    clientPlatform: pickString(client.platform),
    clientVersion: pickString(client.version),
    conversationId: pickString(conversation.id),
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
      has_conversation_id: Boolean(context.conversationId),
      has_working_directory: context.workingDirectoryPresent,
    },
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

function captureMcpToolCallVisibility<Env>(
  env: Env,
  ctx: ExecutionContextWithProps<unknown>,
  auth: AuthResult,
  toolCall: McpToolCallTelemetry | undefined,
  response: Response,
  latencyMs: number,
  errorCode?: string | null
): void {
  if (!toolCall) return;

  const status = errorCode || response.status >= 400 ? 'error' : 'success';
  const distinctId = auth.userId ?? resolveAnonymousDistinctId(ctx);
  const { metadata, workspaceId, sourceClient } =
    sanitizeToolCallMetadata(toolCall);
  const toolFamily = classifyToolFamily(toolCall.toolName);
  const responseSizeHeader = Number(response.headers.get('content-length'));
  const transportMetadata = {
    ...metadata,
    http_status: response.status,
    response_size_header_bytes: Number.isFinite(responseSizeHeader)
      ? responseSizeHeader
      : undefined,
  };
  const requestId =
    typeof toolCall.jsonrpcId === 'string' ||
    typeof toolCall.jsonrpcId === 'number'
      ? String(toolCall.jsonrpcId)
      : undefined;

  captureWorkerPosthogEvent({
    env: env as PosthogTelemetryEnv,
    ctx,
    event: 'mcp_tool_invocation',
    distinctId,
    properties: {
      tool_id: toolCall.toolName,
      status,
      latency_ms: latencyMs,
      tool_family: toolFamily,
      auth_scope: auth.scope,
      error_code: errorCode ?? undefined,
      has_user_id: Boolean(auth.userId),
      workspace_id: workspaceId,
      source_client: sourceClient,
      request_id: requestId,
      ...transportMetadata,
    },
  });

  if (!isOrgxApiTelemetryConfigured(env)) return;

  ctx.waitUntil?.(
    recordDurableMcpToolInvocation({
      env,
      toolId: toolCall.toolName,
      status,
      latencyMs,
      metadata: transportMetadata,
      userId: auth.userId ?? null,
      workspaceId: workspaceId ?? null,
      sourceClient: sourceClient ?? null,
      context: toolCall.context,
      errorCode:
        errorCode ?? (status === 'error' ? `http_${response.status}` : null),
      isWidgetTool: false,
      toolFamily,
      requestId,
    })
  );
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

export async function handleMcpRequest<Env, Props>(
  request: Request,
  env: Env,
  ctx: ExecutionContextWithProps<Props>,
  handler: AgentHandler<Env, Props>,
  authenticateRequest: AuthenticateRequest<Env>
) {
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
      })
    );
  }
  const auth = await authenticateRequest(request, env);
  if ('response' in auth && auth.response) return withCors(auth.response);
  (ctx as ExecutionContextWithProps<Props>).props = {
    userId: auth.userId,
    scope: auth.scope,
    email: auth.email,
  } as unknown as Props;

  // Normalize tool names in the request body (strips server prefixes like "Orgx:")
  const { request: normalizedRequest, warning, toolCall } =
    await normalizeRequestBody(request);
  captureDeprecatedToolTelemetry(env, ctx as ExecutionContextWithProps<unknown>, auth, warning);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await handler.fetch(normalizedRequest, env, ctx);
  } catch (error) {
    captureMcpToolCallVisibility(
      env,
      ctx as ExecutionContextWithProps<unknown>,
      auth,
      toolCall,
      new Response(null, { status: 500 }),
      Date.now() - startedAt,
      classifyMcpToolError(error)
    );
    throw error;
  }
  captureMcpToolCallVisibility(
    env,
    ctx as ExecutionContextWithProps<unknown>,
    auth,
    toolCall,
    response,
    Date.now() - startedAt
  );
  return withCors(withDeprecatedToolWarningHeaders(response, warning));
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
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Upgrade Required', { status: 426 });
  }

  const auth = await authenticateRequest(request, env);
  if ('response' in auth && auth.response) {
    return withCors(auth.response);
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

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
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
  extraHeaders: Record<string, string>
) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Access-Token, Mcp-Session-Id'
  );

  // Add extra headers (rate limit info)
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
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
