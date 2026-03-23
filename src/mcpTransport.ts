import {
  resolveDeprecatedToolCall,
  withDeprecatedToolWarningHeaders,
  type DeprecatedToolWarning,
} from './deprecatedTools';

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
    /^orgx[._:/-]/i, // orgx: / orgx. / orgx/
    /^orgx[_:-]/i, // Orgx:, orgx-, orgx_
    /^OrgX[_:-]/, // Exact case OrgX:
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
}> {
  // Only process POST requests with JSON body
  if (request.method !== 'POST') return { request };

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return { request };

  try {
    const body = (await request.clone().json()) as {
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

    // If nothing changed and there is no warning, return the original request.
    if (
      resolvedToolId === originalName &&
      resolvedArgs === originalArgs &&
      !warning
    ) {
      return { request };
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
    };
  } catch {
    // If parsing fails, return original request
    return { request };
  }
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
  const { request: normalizedRequest, warning } = await normalizeRequestBody(
    request
  );

  const response = await handler.fetch(normalizedRequest, env, ctx);
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
        server
      )
    );
  });

  // Intentionally no auto-DELETE on close: clients may reconnect and resume
  // the same MCP session ID after transient disconnects.
  server.addEventListener('error', (error) => {
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
  ws: WebSocket
) {
  let parsedBody: { method?: string; params?: { name?: string } };
  try {
    parsedBody = JSON.parse(body);
  } catch {
    ws.send(
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
    ws.send(
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

  await pumpSseToWebSocket(response, ws);
}

async function pumpSseToWebSocket(response: Response, ws: WebSocket) {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
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
        ws.send(JSON.stringify({ event: eventName, data }));
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
}
