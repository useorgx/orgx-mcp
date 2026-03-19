/**
 * Auth Handler for OAuthProvider's defaultHandler
 *
 * Handles:
 * - Clerk auth flow: /authorize → Clerk sign-in → /oauth/callback → consent page → /oauth/consent-callback
 * - Non-API routes: health checks, landing page, WebSocket, Codex/Claude Code configs, registry auth
 *
 * This replaces the OAuth flow + routing from the old mcpWorker.fetch() handler.
 * The OAuthProvider wraps this handler and auto-generates:
 *   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
 *   /token, /register
 */

import type {
  OAuthHelpers,
  AuthRequest,
} from '@cloudflare/workers-oauth-provider';
import {
  handleMcpRequest,
  handleMcpWebSocket,
  withCors,
  withSseKeepAlive,
  type ExecutionContextWithProps,
} from './mcpTransport';
import { authenticateRequest } from './requestAuth';
import { OAUTH_SCOPES_SUPPORTED } from './toolDefinitions';

// Re-export type for use in index.ts
export type { OAuthHelpers };

interface AuthHandlerEnv {
  ORGX_API_URL: string;
  ORGX_WEB_URL: string;
  MCP_SERVER_URL: string;
  AUTH_SERVER_URL: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_REGISTRY_PUBKEY?: string;
  DEV_USER_ID?: string;
  MCP_JWT_SECRET: string;
  ORGX_SERVICE_KEY: string;
  OAUTH_STATE: DurableObjectNamespace;
}

/**
 * Redirect to the error page for user-facing OAuth errors
 */
function errorRedirect(
  error: string,
  description: string,
  serverUrl: string
): Response {
  const errorUrl = new URL(`${serverUrl}/error.html`);
  errorUrl.searchParams.set('error', error);
  errorUrl.searchParams.set('error_description', description);
  return Response.redirect(errorUrl.toString(), 302);
}

/**
 * Auth handler — serves as the `defaultHandler` for OAuthProvider.
 * Receives all requests that are NOT matched by apiHandlers (i.e., not /mcp or /sse).
 */
export const authHandler = {
  async fetch(
    request: Request,
    rawEnv: any,
    ctx: ExecutionContext
  ): Promise<Response> {
    const env: AuthHandlerEnv = rawEnv;
    const url = new URL(request.url);
    const serverUrl = env.MCP_SERVER_URL ?? 'https://mcp.useorgx.com';
    const webUrl = env.ORGX_WEB_URL ?? 'https://useorgx.com';

    // =========================================================================
    // Health Check
    // =========================================================================
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      return withCors(new Response('ok'));
    }

    // =========================================================================
    // Protected Resource Metadata (RFC 9728)
    // MCP clients need this to discover that OAuth is required and where
    // the authorization server lives. Without this, clients connect anonymously.
    // Path variants: /mcp, /sse get resource field matching their path.
    // =========================================================================
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname.startsWith('/.well-known/oauth-protected-resource/')
    ) {
      // Per RFC 9728 §3: resource must match the path the client asked about
      const pathSuffix = url.pathname.replace(
        '/.well-known/oauth-protected-resource',
        ''
      );
      const resource = pathSuffix ? `${serverUrl}${pathSuffix}` : serverUrl;

      console.info('[auth:discovery] Protected resource metadata requested', {
        path: url.pathname,
        resource,
        userAgent: request.headers.get('user-agent')?.substring(0, 80),
      });

      const metadata = {
        resource,
        authorization_servers: [serverUrl],
        scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
        bearer_methods_supported: ['header'],
        resource_documentation: 'https://docs.useorgx.com',
      };
      return withCors(
        Response.json(metadata, {
          headers: { 'Cache-Control': 'public, max-age=3600' },
        })
      );
    }

    // =========================================================================
    // Authorization Server Metadata — path variants (RFC 8414)
    // The OAuthProvider auto-serves /.well-known/oauth-authorization-server
    // (exact match), but path variants like /mcp and /sse fall through here.
    // =========================================================================
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server/')) {
      console.info('[auth:discovery] Auth server metadata (path variant)', {
        path: url.pathname,
        userAgent: request.headers.get('user-agent')?.substring(0, 80),
      });

      const metadata = {
        issuer: serverUrl,
        authorization_endpoint: `${serverUrl}/authorize`,
        token_endpoint: `${serverUrl}/token`,
        registration_endpoint: `${serverUrl}/register`,
        scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
          'none',
        ],
        revocation_endpoint: `${serverUrl}/token`,
        code_challenge_methods_supported: ['plain', 'S256'],
      };
      return withCors(
        Response.json(metadata, {
          headers: { 'Cache-Control': 'public, max-age=3600' },
        })
      );
    }

    // =========================================================================
    // OAuth Authorization Flow (Clerk integration)
    // =========================================================================

    // Step 1: /authorize — parse OAuth request, store state in KV, redirect to Clerk
    if (url.pathname === '/authorize' && request.method === 'GET') {
      return handleAuthorize(request, env, serverUrl, webUrl);
    }

    // Step 2: /oauth/callback — Clerk returns user info, redirect to consent page
    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      return handleOAuthCallback(request, env, serverUrl);
    }

    // Step 3: /oauth/consent-callback — user approved scopes, complete authorization
    if (
      url.pathname === '/oauth/consent-callback' &&
      request.method === 'GET'
    ) {
      return handleConsentCallback(request, env, serverUrl);
    }

    // =========================================================================
    // Root URL routing (content negotiation)
    // Clients that use https://mcp.useorgx.com as the MCP URL without /mcp or /sse.
    // These arrive at defaultHandler (no provider token validation).
    // We rewrite to /mcp or /sse and forward — the MCP handler uses DO session auth.
    // =========================================================================
    if (url.pathname === '/') {
      const accept = request.headers.get('accept') ?? '';
      const contentType = request.headers.get('content-type') ?? '';
      const hasAuth = !!request.headers.get('authorization');

      // Determine destination for logging
      const isJsonPost =
        request.method === 'POST' && contentType.includes('application/json');
      const isDelete = request.method === 'DELETE';
      const isSse =
        request.method === 'GET' &&
        (accept.includes('text/event-stream') ||
          !!request.headers.get('mcp-session-id'));
      const destination =
        isJsonPost || isDelete ? 'mcp' : isSse ? 'sse' : 'landing';

      console.info('[auth:root] Content negotiation', {
        method: request.method,
        destination,
        hasAuth,
        accept: accept.substring(0, 60),
        contentType: contentType.substring(0, 60),
        userAgent: request.headers.get('user-agent')?.substring(0, 80),
      });

      // POST / with JSON → rewrite to /mcp (Streamable HTTP transport)
      if (
        request.method === 'POST' &&
        contentType.includes('application/json')
      ) {
        const { getHttpHandler } = await import('./index');
        const rewritten = new URL(request.url);
        rewritten.pathname = '/mcp';
        const mcpReq = new Request(rewritten.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        return handleMcpRequest(
          mcpReq,
          env as any,
          ctx as ExecutionContextWithProps<any>,
          getHttpHandler(),
          authenticateRequest
        );
      }

      // DELETE / → rewrite to /mcp (session cleanup)
      if (request.method === 'DELETE') {
        const { getHttpHandler } = await import('./index');
        const rewritten = new URL(request.url);
        rewritten.pathname = '/mcp';
        const mcpReq = new Request(rewritten.toString(), {
          method: request.method,
          headers: request.headers,
        });
        return handleMcpRequest(
          mcpReq,
          env as any,
          ctx as ExecutionContextWithProps<any>,
          getHttpHandler(),
          authenticateRequest
        );
      }

      // GET / with SSE accept or session ID → rewrite to /sse
      if (
        request.method === 'GET' &&
        (accept.includes('text/event-stream') ||
          request.headers.get('mcp-session-id'))
      ) {
        const { getSseHandler } = await import('./index');
        const rewritten = new URL(request.url);
        rewritten.pathname = '/sse';
        const sseReq = new Request(rewritten.toString(), {
          method: request.method,
          headers: request.headers,
        });
        const resp = await handleMcpRequest(
          sseReq,
          env as any,
          ctx as ExecutionContextWithProps<any>,
          getSseHandler(),
          authenticateRequest
        );
        return withSseKeepAlive(resp);
      }

      // GET / from browser → landing page
      if (request.method === 'GET') {
        return Response.redirect(
          new URL('/index.html', url.origin).toString(),
          302
        );
      }
    }

    // =========================================================================
    // WebSocket per-server connections
    // =========================================================================
    const wsMatch = url.pathname.match(/^\/v1\/([^/]+)\/servers\/([^/]+)\/?$/);
    if (wsMatch) {
      // WebSocket connections use DO session auth (not OAuth tokens)
      // Import httpHandler dynamically to avoid circular dependency
      const { getHttpHandler } = await import('./index');
      return handleMcpWebSocket(
        request,
        env as any,
        ctx as ExecutionContextWithProps<any>,
        getHttpHandler(),
        authenticateRequest
      );
    }

    // =========================================================================
    // MCP Registry Authentication (custom logic, not auto-generated)
    // =========================================================================
    if (url.pathname === '/.well-known/mcp-registry-auth') {
      const pubkey = env.MCP_REGISTRY_PUBKEY;
      if (!pubkey) {
        return withCors(
          new Response(
            'MCP Registry auth not configured. Set MCP_REGISTRY_PUBKEY environment variable.',
            { status: 503 }
          )
        );
      }
      const authRecord = `v=MCPv1; k=ed25519; p=${pubkey}`;
      return withCors(
        new Response(authRecord, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        })
      );
    }

    // =========================================================================
    // Codex CLI Integration Endpoints
    // =========================================================================
    if (url.pathname === '/codex' || url.pathname === '/codex/mcp') {
      const codexMetadata = {
        name: 'orgx',
        version: '1.0.0',
        description:
          'OrgX platform - AI-powered initiative management, decisions, and org memory',
        homepage: 'https://useorgx.com',
        documentation: 'https://docs.useorgx.com/integrations/codex',
        capabilities: { tools: true, resources: true, prompts: true },
        tools: [
          {
            name: 'get_pending_decisions',
            description: 'Get pending decisions awaiting approval',
            readOnly: true,
          },
          {
            name: 'approve_decision',
            description: 'Approve a pending decision',
          },
          {
            name: 'reject_decision',
            description: 'Reject a pending decision with reason',
          },
          {
            name: 'get_initiative_pulse',
            description: 'Get health metrics for initiatives',
            readOnly: true,
          },
          {
            name: 'list_entities',
            description: 'List any entity type with pagination',
            readOnly: true,
          },
          {
            name: 'create_entity',
            description: 'Create initiatives, tasks, milestones',
          },
          {
            name: 'batch_create_entities',
            description: 'Create multiple entities in one call',
          },
          {
            name: 'scaffold_initiative',
            description:
              'Create an initiative with nested workstreams/milestones/tasks in one call',
          },
          {
            name: 'get_task_with_context',
            description: 'Fetch a task plus hydrated context pointers',
            readOnly: true,
          },
          { name: 'entity_action', description: 'Execute lifecycle action on entity (launch, pause, complete, etc.)' },
          {
            name: 'verify_entity_completion',
            description: 'Run hierarchy completion checks before complete',
            readOnly: true,
          },
          {
            name: 'batch_delete_entities',
            description: 'Delete multiple entities in one call',
          },
          {
            name: 'get_agent_status',
            description: 'Check agent availability and health',
            readOnly: true,
          },
          {
            name: 'spawn_agent_task',
            description: 'Delegate task to specialized agent',
          },
          {
            name: 'query_org_memory',
            description: 'Search organizational knowledge base',
            readOnly: true,
          },
          {
            name: 'start_plan_session',
            description: 'Begin feature planning session',
          },
          { name: 'improve_plan', description: 'Get AI suggestions for plan' },
          {
            name: 'complete_plan',
            description: 'Finish plan and extract skills',
          },
        ],
        auth: {
          type: 'oauth2',
          authorizationUrl: `${serverUrl}/authorize`,
          tokenUrl: `${serverUrl}/token`,
          scopes: ['read', 'write', 'admin'],
        },
        endpoints: {
          mcp: `${serverUrl}/mcp`,
          sse: `${serverUrl}/sse`,
        },
      };
      return withCors(
        Response.json(codexMetadata, {
          headers: { 'Cache-Control': 'public, max-age=3600' },
        })
      );
    }

    if (url.pathname === '/codex/config') {
      const tomlConfig = `# OrgX MCP Server Configuration for Codex CLI
# Add this to your ~/.codex/config.toml

[mcp_servers.orgx]
url = "${serverUrl}/mcp"
bearer_token_env_var = "ORGX_API_TOKEN"
startup_timeout_sec = 30
tool_timeout_sec = 60
# Optional: limit to specific tools
# enabled_tools = ["get_pending_decisions", "query_org_memory", "list_entities"]

# To authenticate, set your token:
# export ORGX_API_TOKEN="your-token-here"
# Get your token at: https://app.useorgx.com/settings/api
`;
      return withCors(
        new Response(tomlConfig, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="orgx-mcp.toml"',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      );
    }

    if (url.pathname === '/claude-code/config') {
      const claudeConfig = {
        mcpServers: {
          orgx: {
            type: 'http',
            url: `${serverUrl}/mcp`,
            description: 'OrgX platform - initiatives, decisions, org memory',
          },
        },
      };
      return withCors(
        Response.json(claudeConfig, {
          headers: {
            'Content-Disposition': 'inline; filename="orgx-mcp.json"',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      );
    }

    // =========================================================================
    // 404 for everything else
    // =========================================================================
    return withCors(
      Response.json(
        {
          error: 'not_found',
          error_description: `Route ${url.pathname} not found`,
        },
        { status: 404 }
      )
    );
  },
};

// =============================================================================
// OAuth Flow Handlers (Clerk integration)
// =============================================================================

/**
 * GET /authorize — Parse OAuth request, store state in KV, redirect to Clerk
 */
async function handleAuthorize(
  request: Request,
  env: AuthHandlerEnv,
  serverUrl: string,
  webUrl: string
): Promise<Response> {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    console.error('[auth] Failed to parse auth request:', error);
    return errorRedirect(
      'invalid_request',
      'The application made an invalid request. Please contact the app developer.',
      serverUrl
    );
  }

  // Validate PKCE is S256 (required by MCP spec)
  if (
    oauthReqInfo.codeChallengeMethod &&
    oauthReqInfo.codeChallengeMethod !== 'S256'
  ) {
    return errorRedirect(
      'invalid_request',
      'The application must use PKCE (S256) for secure authorization.',
      serverUrl
    );
  }

  // Store oauthReqInfo in KV with a random state key (TTL: 20 min)
  const stateKey = crypto.randomUUID();
  try {
    await env.OAUTH_KV.put(
      `auth_state:${stateKey}`,
      JSON.stringify(oauthReqInfo),
      { expirationTtl: 1200 } // 20 minutes
    );
  } catch (error) {
    console.error('[auth] Failed to store OAuth state in KV:', error);
    return errorRedirect(
      'server_error',
      'Failed to initialize authorization. Please try again.',
      serverUrl
    );
  }

  // Redirect to Clerk sign-in on the OrgX web app
  const clerkRedirectUrl = `${webUrl}/auth/mcp/callback?state_key=${encodeURIComponent(
    stateKey
  )}`;
  const signInUrl = new URL(`${webUrl}/sign-in`);
  signInUrl.searchParams.set('redirect_url', clerkRedirectUrl);

  console.info('[auth] Redirecting to Clerk sign-in', {
    clientId: oauthReqInfo.clientId,
    scope: oauthReqInfo.scope,
  });

  return Response.redirect(signInUrl.toString(), 302);
}

/**
 * GET /oauth/callback — Clerk returns user info, redirect to consent page
 */
async function handleOAuthCallback(
  request: Request,
  env: AuthHandlerEnv,
  serverUrl: string
): Promise<Response> {
  const url = new URL(request.url);

  const stateKey = url.searchParams.get('state_key');
  const userId = url.searchParams.get('user_id');
  const userEmail = url.searchParams.get('user_email');
  const orgName = url.searchParams.get('org_name') ?? 'Personal account';
  const error = url.searchParams.get('error');

  if (error) {
    return errorRedirect('access_denied', error, serverUrl);
  }

  if (!userId) {
    return errorRedirect(
      'invalid_request',
      'Missing authentication data. Please try signing in again.',
      serverUrl
    );
  }

  if (!stateKey) {
    return errorRedirect(
      'invalid_request',
      'Missing or expired authorization session. Please start over.',
      serverUrl
    );
  }

  // Consume state from KV (read + delete = single-use) and auto-approve all
  // requested scopes. This eliminates the consent page — users get connected
  // immediately after signing in, reducing friction for first-time MCP users.
  let oauthReqInfo: AuthRequest;
  try {
    const stored = await env.OAUTH_KV.get(`auth_state:${stateKey}`);
    if (!stored) {
      return errorRedirect(
        'invalid_request',
        'Authorization session expired. Please start over.',
        serverUrl
      );
    }
    oauthReqInfo = JSON.parse(stored);
    // Delete after successful read (single-use)
    await env.OAUTH_KV.delete(`auth_state:${stateKey}`);
  } catch (error) {
    console.error('[auth] Failed to read state from KV:', error);
    return errorRedirect(
      'invalid_request',
      'Invalid authorization data. Please start over.',
      serverUrl
    );
  }

  // Auto-approve all requested scopes (no consent page needed)
  const scope = oauthReqInfo.scope ?? [];

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId,
      metadata: { label: userEmail ?? userId },
      scope,
      props: {
        userId,
        scope: scope.join(' '),
        email: userEmail ?? '',
      },
    });

    console.info('[auth] Authorization auto-approved', {
      userId,
      scope: scope.join(' '),
      clientId: oauthReqInfo.clientId,
    });

    return Response.redirect(redirectTo, 302);
  } catch (error) {
    console.error('[auth] Failed to complete authorization:', error);
    return errorRedirect(
      'server_error',
      "We couldn't complete your authorization. This is usually temporary — please try again.",
      serverUrl
    );
  }
}

/**
 * GET /oauth/consent-callback — User approved scopes, complete authorization via provider
 */
async function handleConsentCallback(
  request: Request,
  env: AuthHandlerEnv,
  serverUrl: string
): Promise<Response> {
  const url = new URL(request.url);

  const stateKey = url.searchParams.get('state_key');
  const finalScope = url.searchParams.get('final_scope');
  const userId = url.searchParams.get('user_id');
  const userEmail = url.searchParams.get('user_email');

  if (!stateKey || !userId) {
    return errorRedirect(
      'invalid_request',
      'Your authorization session has expired. Please start over.',
      serverUrl
    );
  }

  // Consume state from KV (read + delete = single-use)
  let oauthReqInfo: AuthRequest;
  try {
    const stored = await env.OAUTH_KV.get(`auth_state:${stateKey}`);
    if (!stored) {
      return errorRedirect(
        'invalid_request',
        'Authorization session expired or already used. Please start over.',
        serverUrl
      );
    }
    oauthReqInfo = JSON.parse(stored);
    // Delete after successful read (single-use)
    await env.OAUTH_KV.delete(`auth_state:${stateKey}`);
  } catch (error) {
    console.error('[auth] Failed to consume state from KV:', error);
    return errorRedirect(
      'invalid_request',
      'Invalid authorization data. Please start over.',
      serverUrl
    );
  }

  // Use user-selected scope from consent page, or fall back to requested scope
  const scope = finalScope
    ? finalScope.split(' ').filter(Boolean)
    : oauthReqInfo.scope ?? [];

  // Complete authorization via the OAuthProvider
  // This creates a grant, issues an auth code, and returns the redirect URL
  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId,
      metadata: { label: userEmail ?? userId },
      scope,
      props: {
        userId,
        scope: scope.join(' '),
        email: userEmail ?? '',
      },
    });

    console.info('[auth] Authorization completed', {
      userId,
      scope: scope.join(' '),
      redirectTo: redirectTo.substring(0, 80),
    });

    // Redirect DIRECTLY to the client's callback URL (standard OAuth 2.1 flow).
    // Intermediary pages (success.html) break some clients' OAuth state tracking
    // because they expect a direct 302 from the authorization server.
    return Response.redirect(redirectTo, 302);
  } catch (error) {
    console.error('[auth] Failed to complete authorization:', error);
    return errorRedirect(
      'server_error',
      "We couldn't complete your authorization. This is usually temporary — please try again.",
      serverUrl
    );
  }
}
