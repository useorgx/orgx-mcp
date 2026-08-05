export interface McpOriginValidationEnv {
  MCP_SERVER_URL?: string;
  ORGX_WEB_URL?: string;
  /** Comma- or whitespace-separated additional trusted browser origins. */
  MCP_ALLOWED_ORIGINS?: string;
}

const TRUSTED_HOSTED_CLIENT_ORIGINS = [
  'https://claude.ai',
  'https://chatgpt.com',
  'https://chat.openai.com',
] as const;

function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function addConfiguredOrigin(
  allowed: Set<string>,
  value: string | null | undefined
) {
  const origin = normalizedOrigin(value);
  if (!origin) return;
  allowed.add(origin);

  const url = new URL(origin);
  const hostParts = url.hostname.split('.');
  if (hostParts.length === 2 && !url.hostname.startsWith('www.')) {
    allowed.add(`${url.protocol}//www.${url.host}`);
  }
}

export function resolveAllowedMcpOrigins(
  env: McpOriginValidationEnv
): ReadonlySet<string> {
  const allowed = new Set<string>(TRUSTED_HOSTED_CLIENT_ORIGINS);
  addConfiguredOrigin(allowed, env.MCP_SERVER_URL);
  addConfiguredOrigin(allowed, env.ORGX_WEB_URL);

  for (const value of (env.MCP_ALLOWED_ORIGINS ?? '').split(/[\s,]+/)) {
    addConfiguredOrigin(allowed, value);
  }

  return allowed;
}

function isLocalDevelopmentPair(request: Request, origin: string): boolean {
  const requestUrl = new URL(request.url);
  const originUrl = new URL(origin);
  return (
    isLoopbackHostname(requestUrl.hostname) &&
    isLoopbackHostname(originUrl.hostname) &&
    requestUrl.protocol === 'http:' &&
    originUrl.protocol === 'http:'
  );
}

export function buildInvalidMcpOriginResponse(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Forbidden: invalid Origin header for this MCP endpoint.',
        data: { code: 'invalid_origin' },
      },
    },
    {
      status: 403,
      headers: {
        'Cache-Control': 'no-store',
        Vary: 'Origin',
        'x-orgx-mcp-error-code': 'invalid_origin',
      },
    }
  );
}

/**
 * Validate a present browser Origin before an MCP transport request reaches
 * OAuth, session state, or a tool handler. CLI/server clients commonly omit
 * Origin and remain supported. Local cross-port browser testing is allowed
 * only when both endpoints are loopback HTTP origins.
 */
export function validateMcpRequestOrigin(
  request: Request,
  env: McpOriginValidationEnv
): Response | null {
  const rawOrigin = request.headers.get('origin');
  if (rawOrigin === null) return null;

  const origin = normalizedOrigin(rawOrigin);
  if (!origin) return buildInvalidMcpOriginResponse();
  if (resolveAllowedMcpOrigins(env).has(origin)) return null;
  if (isLocalDevelopmentPair(request, origin)) return null;
  return buildInvalidMcpOriginResponse();
}
