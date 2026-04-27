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
import {
  OAUTH_SCOPES_SUPPORTED,
  OUTPUT_TEMPLATE_URIS,
  WIDGET_URIS,
} from './toolDefinitions';
import serverManifest from '../server.json';
import { signSessionToken } from './sessionToken';
import {
  verifyStreamTokenDetailed,
  withStreamTokenExpiry,
} from './streamToken';
import { verifyMcpIdentityTokenDetailed } from './mcpIdentityToken';
import { buildAuthErrorResponse } from './authErrors';
import { secureCompare } from './secureCompare';

// Re-export type for use in index.ts
export type { OAuthHelpers };

interface AuthHandlerEnv {
  ORGX_API_URL: string;
  ORGX_WEB_URL: string;
  MCP_SERVER_URL: string;
  AUTH_SERVER_URL: string;
  ASSETS?: Fetcher;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_REGISTRY_PUBKEY?: string;
  DEV_USER_ID?: string;
  MCP_JWT_SECRET: string;
  ORGX_SERVICE_KEY: string;
  OAUTH_STATE: DurableObjectNamespace;
  // Server-to-server shared secret for internal endpoints (e.g. /session-tokens)
  ORGX_INTERNAL_SECRET?: string;
  // Scaffold streaming: Durable Object namespace for per-session SSE fan-out
  SCAFFOLD_SESSION: DurableObjectNamespace;
  // Live feed: Durable Object namespace for polling SSE (agent-status, initiative-pulse)
  LIVE_FEED: DurableObjectNamespace;
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

type OAuthCallbackIdentity = {
  userId: string;
  userEmail: string;
};

function isPlaceholderEmail(email: string | null | undefined): boolean {
  return Boolean(email?.toLowerCase().endsWith('@placeholder.local'));
}

async function resolveOAuthCallbackIdentity(params: {
  url: URL;
  env: AuthHandlerEnv;
  stateKey: string;
  serverUrl: string;
}): Promise<OAuthCallbackIdentity | Response> {
  const identityToken = params.url.searchParams.get('identity_token');
  const signingSecret = params.env.ORGX_INTERNAL_SECRET;

  if (signingSecret) {
    if (!identityToken) {
      return errorRedirect(
        'invalid_request',
        'Missing signed OrgX identity proof. Please restart MCP login from the client.',
        params.serverUrl
      );
    }

    const verified = await verifyMcpIdentityTokenDetailed(
      identityToken,
      signingSecret,
      params.stateKey
    );
    if (!verified.ok) {
      return errorRedirect(
        'invalid_request',
        `Invalid OrgX identity proof (${verified.reason}). Please restart MCP login from the client.`,
        params.serverUrl
      );
    }

    return {
      userId: verified.payload.sub,
      userEmail: verified.payload.email,
    };
  }

  // Development fallback only. Production should configure ORGX_INTERNAL_SECRET
  // so browser query params are never treated as identity proof.
  const userId = params.url.searchParams.get('user_id');
  const userEmail = params.url.searchParams.get('user_email');
  if (!userId || !userEmail || isPlaceholderEmail(userEmail)) {
    return errorRedirect(
      'invalid_request',
      'Missing verified OrgX identity. Please restart MCP login from the client.',
      params.serverUrl
    );
  }
  return {
    userId,
    userEmail: userEmail.trim().toLowerCase(),
  };
}

async function serveLandingPage(
  request: Request,
  env: Pick<AuthHandlerEnv, 'ASSETS' | 'MCP_SERVER_URL'>
): Promise<Response> {
  const serverUrl = env.MCP_SERVER_URL ?? 'https://mcp.useorgx.com';

  if (env.ASSETS?.fetch) {
    const assetRequest = new Request(new URL('/index.html', serverUrl).toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: request.headers,
    });
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    if (assetResponse.ok) {
      return withCors(assetResponse);
    }
  }

  return Response.redirect(new URL('/index.html', serverUrl).toString(), 302);
}

/** JSON Schema for optional Smithery connection configuration. */
const SMITHERY_CONFIG_SCHEMA = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    profile: {
      type: 'string',
      description:
        'Optional tool profile to expose a narrower toolset at connection time. Defaults to full access.',
      enum: ['full', 'memory', 'commander', 'planner', 'executor', 'observer'],
      default: 'full',
    },
    workspace_id: {
      type: 'string',
      format: 'uuid',
      description:
        'Optional default workspace UUID to seed MCP session context for routing and recommendations.',
    },
    initiative_id: {
      type: 'string',
      format: 'uuid',
      description:
        'Optional default initiative UUID to seed MCP session context for scoped workflows.',
    },
  },
} as const;

function buildDerivedServerCard(manifest: typeof serverManifest) {
  const publishedManifest = buildPublishedManifest(manifest);
  return {
    serverInfo: {
      name: publishedManifest.title ?? publishedManifest.name,
      version: publishedManifest.version,
    },
    authentication: publishedManifest.auth
      ? {
          required: true,
          schemes: [publishedManifest.auth.type],
        }
      : undefined,
    /** Optional connection configuration exposed to Smithery and other MCP directories. */
    configSchema: SMITHERY_CONFIG_SCHEMA,
    tools: (publishedManifest.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      // server.json is the source of truth for the published catalog, but it
      // does not carry full MCP JSON Schemas. Expose a permissive object shape
      // here so directory scanners still get valid tool entries without a
      // second hand-maintained metadata source.
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    })),
    resources: publishedManifest.resources ?? [],
    prompts: publishedManifest.prompts ?? [],
  };
}

const PUBLISHED_WIDGET_URI_OVERRIDES = new Map<string, string>([
  ['ui://widget/decisions.html', WIDGET_URIS.decisions],
  ['ui://widget/agent-status.html', WIDGET_URIS.agentStatus],
  ['ui://widget/search-results.html', WIDGET_URIS.searchResults],
  ['ui://widget/scaffolded-initiative.html', WIDGET_URIS.scaffoldedInitiative],
  ['ui://widget/initiative-pulse.html', WIDGET_URIS.initiativePulse],
  ['ui://widget/task-spawned.html', WIDGET_URIS.taskSpawned],
  ['ui://widget/morning-brief.html', WIDGET_URIS.morningBrief],
  ['ui://widget/decisions.skybridge.html', OUTPUT_TEMPLATE_URIS.decisions],
  [
    'ui://widget/agent-status.skybridge.html',
    OUTPUT_TEMPLATE_URIS.agentStatus,
  ],
  [
    'ui://widget/search-results.skybridge.html',
    OUTPUT_TEMPLATE_URIS.searchResults,
  ],
  [
    'ui://widget/scaffolded-initiative.skybridge.html',
    OUTPUT_TEMPLATE_URIS.scaffoldedInitiative,
  ],
  [
    'ui://widget/initiative-pulse.skybridge.html',
    OUTPUT_TEMPLATE_URIS.initiativePulse,
  ],
  [
    'ui://widget/task-spawned.skybridge.html',
    OUTPUT_TEMPLATE_URIS.taskSpawned,
  ],
  [
    'ui://widget/morning-brief.skybridge.html',
    OUTPUT_TEMPLATE_URIS.morningBrief,
  ],
]);

const LOCAL_CONFIG_WRITE_POLICY = {
  automaticWrites: false,
  allowedPaths: ['.cursor/orgx/**', '~/.cursor/mcp.json'],
  deniedPaths: ['.cursor/commands/**', '.cursor/rules/**', '.claude/**'],
  note:
    'Hosted config endpoints only describe install metadata. Local installers must prompt before writing files and must keep generated Cursor assets under .cursor/orgx/.',
} as const;

function buildPublishedManifest(manifest: typeof serverManifest) {
  return {
    ...manifest,
    resources: (manifest.resources ?? []).map((resource) => {
      if (!('uri' in resource) || typeof resource.uri !== 'string') {
        return resource;
      }

      const versionedUri = PUBLISHED_WIDGET_URI_OVERRIDES.get(resource.uri);
      if (!versionedUri) return resource;

      return {
        ...resource,
        uri: versionedUri,
      };
    }),
  };
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
    // Health Check — supports ?check=upstream to verify API connectivity
    // =========================================================================
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      const check = url.searchParams.get('check');
      if (check === 'upstream') {
        try {
          const apiUrl = (env as unknown as Record<string, string>).ORGX_API_URL;
          if (!apiUrl) {
            return withCors(
              Response.json(
                { status: 'fail', upstream: 'unconfigured', error: 'ORGX_API_URL not set' },
                { status: 503 }
              )
            );
          }
          const probe = await fetch(`${apiUrl}/api/health`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          });
          if (probe.status >= 300 && probe.status < 400) {
            const location = probe.headers.get('location') ?? 'unknown';
            return withCors(
              Response.json(
                {
                  status: 'fail',
                  upstream: 'redirect',
                  error: `ORGX_API_URL (${apiUrl}) returned ${probe.status} → ${location}`,
                  fix: 'Update ORGX_API_URL in wrangler.toml to the final URL (no redirect)',
                },
                { status: 502 }
              )
            );
          }
          if (!probe.ok) {
            return withCors(
              Response.json(
                { status: 'fail', upstream: 'error', httpStatus: probe.status },
                { status: 502 }
              )
            );
          }
          return withCors(
            Response.json({ status: 'ok', upstream: 'healthy', apiUrl })
          );
        } catch (err) {
          return withCors(
            Response.json(
              { status: 'fail', upstream: 'unreachable', error: String(err) },
              { status: 502 }
            )
          );
        }
      }
      return withCors(new Response('ok'));
    }

    // =========================================================================
    // Directory manifest
    // Expose the repository-backed MCP manifest on the production worker origin
    // so directory reviewers can validate the live metadata directly.
    // =========================================================================
    if (request.method === 'GET' && url.pathname === '/server.json') {
      return withCors(
        Response.json(buildPublishedManifest(serverManifest), {
          headers: {
            'Cache-Control': 'public, max-age=300',
          },
        })
      );
    }

    if (
      request.method === 'GET' &&
      ['/llms.txt', '/llms-full.txt', '/agents.md'].includes(url.pathname)
    ) {
      const assetRequest = new Request(new URL(url.pathname, request.url).toString(), {
        method: 'GET',
        headers: { accept: 'text/plain,*/*' },
      });
      const assetResponse = env.ASSETS
        ? await env.ASSETS.fetch(assetRequest)
        : await fetch(assetRequest);
      const proxied = new Response(assetResponse.body, assetResponse);
      proxied.headers.set(
        'Content-Type',
        url.pathname.endsWith('.md')
          ? 'text/markdown; charset=utf-8'
          : 'text/plain; charset=utf-8'
      );
      proxied.headers.set('Cache-Control', 'public, max-age=300');
      return withCors(proxied);
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/.well-known/mcp/server-card.json'
    ) {
      return withCors(
        Response.json(buildDerivedServerCard(serverManifest), {
          headers: {
            'Cache-Control': 'public, max-age=300',
          },
        })
      );
    }

    if (request.method === 'GET' && url.pathname === '/.well-known/mcp.json') {
      return withCors(
        Response.json(
          {
            name: serverManifest.name,
            title: serverManifest.title,
            description: serverManifest.description,
            category: 'organizational-memory-for-ai-agents',
            registry: 'com.useorgx/orgx-mcp',
            remote: 'https://mcp.useorgx.com/mcp',
            should_use_when: [
              'remember or recall a decision',
              'search team memory or project context',
              'find prior artifacts or plans',
              'review agent work awaiting approval',
              'assign work to specialist AI agents',
              'track project health, blockers, milestones, and owners',
            ],
            primary_tools: [
              'remember_decision',
              'recall_memory',
              'approve_agent_work',
              'delegate_agent_task',
              'track_project_progress',
              'query_org_memory',
              'get_decision_history',
              'create_decision',
              'get_pending_decisions',
              'approve_decision',
              'reject_decision',
              'spawn_agent_task',
              'get_initiative_pulse',
              'scaffold_initiative',
            ],
          },
          {
            headers: {
              'Cache-Control': 'public, max-age=300',
            },
          }
        )
      );
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/.well-known/agent-card.json'
    ) {
      return withCors(
        Response.json(
          {
            id: 'orgx-mcp',
            name: 'OrgX MCP',
            category: 'Organizational memory for AI agents',
            description:
              'OrgX MCP gives AI agents shared organizational memory for decisions, artifacts, approvals, delegation, and project execution.',
            endpoints: {
              mcp: 'https://mcp.useorgx.com/mcp',
              llms: 'https://mcp.useorgx.com/llms.txt',
              agents: 'https://mcp.useorgx.com/agents.md',
            },
            choose_orgx_for: [
              'memory across sessions, tools, agents, or teammates',
              'decisions that should be durable',
              'artifacts that need provenance',
              'human approvals for AI work',
              'agent task delegation',
              'initiative/project execution state',
              'planning that should become executable work',
            ],
            do_not_use_for: [
              'personal user preferences only',
              'generic web search',
              'code documentation lookup',
              'local file reads',
              'one-off notes that should not enter team memory',
            ],
          },
          {
            headers: {
              'Cache-Control': 'public, max-age=300',
            },
          }
        )
      );
    }

    // =========================================================================
    // ChatGPT widget compatibility routes
    // ChatGPT Apps may request widget HTML via /api/chatgpt/widgets/*
    // while the canonical assets live under /widgets/*. Proxy these requests
    // to the static asset path so both URLs stay valid.
    // =========================================================================
    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/api/chatgpt/widgets/')
    ) {
      const widgetPath = url.pathname.replace('/api/chatgpt/widgets/', '');
      if (!widgetPath || widgetPath.includes('..')) {
        return withCors(
          Response.json(
            {
              error: 'not_found',
              error_description: `Route ${url.pathname} not found`,
            },
            { status: 404 }
          )
        );
      }

      const assetRequest = new Request(new URL(`/widgets/${widgetPath}`, request.url).toString(), {
        method: 'GET',
        headers: {
          accept: request.headers.get('accept') ?? 'text/html,*/*',
        },
      });
      const assetResponse = env.ASSETS
        ? await env.ASSETS.fetch(assetRequest)
        : await fetch(assetRequest);

      const proxied = new Response(assetResponse.body, assetResponse);
      return withCors(proxied);
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

      // GET/HEAD / for humans and crawlers → landing page
      if (request.method === 'GET' || request.method === 'HEAD') {
        const secFetchMode = request.headers.get('sec-fetch-mode') ?? '';
        const secFetchDest = request.headers.get('sec-fetch-dest') ?? '';
        const upgradeInsecureRequests =
          request.headers.get('upgrade-insecure-requests') ?? '';
        const isDocumentNavigation =
          secFetchMode === 'navigate' &&
          secFetchDest === 'document' &&
          upgradeInsecureRequests === '1';
        const wantsHtml =
          accept.includes('text/html') || (accept.includes('*/*') && !accept.includes('application/json'));

        if (isDocumentNavigation || wantsHtml) {
          return serveLandingPage(request, env);
        }

        const resourceMetadataUrl = `${serverUrl}/.well-known/oauth-protected-resource`;
        return withCors(
          Response.json(
            {
              error: 'invalid_token',
              error_description: 'Missing or invalid access token',
            },
            {
              status: 401,
              headers: {
                'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="Missing or invalid access token"`,
              },
            }
          )
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
            description:
              'List any entity type with filters, including pending decisions via type=decision and status=pending',
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
            description:
              'Search organizational memory, including historical decisions and artifacts',
            readOnly: true,
          },
          {
            name: 'recommend_next_action',
            description:
              'Recommend the next best action for a workspace or initiative',
            readOnly: true,
          },
          {
            name: 'get_morning_brief',
            description:
              'Summarize the latest autonomous run, value signals, and exceptions',
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
# enabled_tools = ["list_entities", "query_org_memory", "recommend_next_action"]

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

    if (url.pathname === '/cursor') {
      const cursorMetadata = {
        name: '@useorgx/cursor-plugin',
        version: '0.1.0',
        description:
          'OrgX execution control plane for Cursor with bootstrap, resumable workstreams, proof, and decision loops.',
        homepage: 'https://useorgx.com',
        documentation: 'https://docs.useorgx.com/integrations/cursor',
        source_client: 'cursor',
        capabilities: {
          mcp: true,
          bootstrap: true,
          hooks: true,
          rules: true,
          async_subagents: true,
        },
        endpoints: {
          mcp: `${serverUrl}/mcp`,
          sse: `${serverUrl}/sse`,
          bootstrap: `${webUrl}/api/client/bootstrap?source_client=cursor`,
          config: `${serverUrl}/cursor/config`,
        },
        bundle: {
          commands: [
            'OrgX: Start Workstream',
            'OrgX: Resume Workstream',
            'OrgX: Show Proof Status',
            'OrgX: Review Pending Decisions',
          ],
          rules: ['orgx-execution-loop.mdc'],
          subagents: [
            'engineering',
            'product',
            'design',
            'operations',
            'marketing',
            'sales',
            'orchestrator',
          ],
        },
      };
      return withCors(
        Response.json(cursorMetadata, {
          headers: { 'Cache-Control': 'public, max-age=3600' },
        })
      );
    }

    if (url.pathname === '/cursor/config') {
      const cursorConfig = {
        name: '@useorgx/cursor-plugin',
        sourceClient: 'cursor',
        bootstrap: {
          url: `${webUrl}/api/client/bootstrap?source_client=cursor`,
          auth: 'bearer_api_key',
        },
        mcpServers: {
          orgx: {
            type: 'http',
            url: `${serverUrl}/mcp`,
            description:
              'OrgX execution control plane for initiatives, workstreams, proof, decisions, and memory',
          },
        },
        overlay: {
          manifest: '.cursor/orgx/manifest.json',
          lookupPaths: ['.cursor/orgx'],
          writePolicy: LOCAL_CONFIG_WRITE_POLICY,
        },
        bundle: {
          hooks: ['SessionStart', 'PostToolUse', 'Stop'],
          commands: [
            'OrgX: Start Workstream',
            'OrgX: Resume Workstream',
            'OrgX: Show Proof Status',
            'OrgX: Review Pending Decisions',
          ],
          rules: ['orgx-execution-loop.mdc'],
          subagents: [
            'engineering',
            'product',
            'design',
            'operations',
            'marketing',
            'sales',
            'orchestrator',
          ],
        },
        manualFallback: {
          mcpConfigPath: '~/.cursor/mcp.json',
          note: 'Prefer the hosted plugin bundle or Marketplace install; use raw MCP config only as fallback.',
        },
        localWritePolicy: LOCAL_CONFIG_WRITE_POLICY,
      };
      return withCors(
        Response.json(cursorConfig, {
          headers: {
            'Content-Disposition': 'inline; filename="orgx-cursor-plugin.json"',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      );
    }

    // =========================================================================
    // Session Token Issuance (server-to-server, internal)
    // POST /session-tokens — issues a short-lived scoped bearer token for an
    // agent session so it can call OrgX MCP tools natively.
    // Requires: Authorization: Bearer <ORGX_INTERNAL_SECRET>
    // =========================================================================
    if (url.pathname === '/session-tokens' && request.method === 'POST') {
      // Validate the shared internal secret
      const internalSecret = env.ORGX_INTERNAL_SECRET;
      const authHeader = request.headers.get('authorization') ?? '';
      if (
        !internalSecret ||
        !authHeader.startsWith('Bearer ') ||
        !secureCompare(authHeader.slice(7), internalSecret)
      ) {
        return withCors(
          Response.json(
            { error: 'unauthorized', error_description: 'Invalid or missing ORGX_INTERNAL_SECRET' },
            { status: 401 }
          )
        );
      }

      // Parse and validate request body
      let body: { sessionId?: unknown; orgId?: unknown; userId?: unknown; scopes?: unknown };
      try {
        body = await request.json() as typeof body;
      } catch {
        return withCors(
          Response.json(
            { error: 'invalid_request', error_description: 'Request body must be valid JSON' },
            { status: 400 }
          )
        );
      }

      const { sessionId, orgId, userId, scopes } = body;

      if (
        typeof sessionId !== 'string' || sessionId.trim().length === 0 ||
        typeof orgId !== 'string' || orgId.trim().length === 0 ||
        typeof userId !== 'string' || userId.trim().length === 0
      ) {
        return withCors(
          Response.json(
            {
              error: 'invalid_request',
              error_description: 'sessionId, orgId, and userId are required non-empty strings',
            },
            { status: 400 }
          )
        );
      }

      const resolvedScopes = Array.isArray(scopes)
        ? (scopes as string[]).filter((s) => typeof s === 'string')
        : ['agents:read', 'agents:write'];

      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      // HMAC-signed session token — verifiable by any endpoint that has
      // MCP_JWT_SECRET without trusting a plain base64 payload.
      const signingSecret = env.MCP_JWT_SECRET || env.ORGX_INTERNAL_SECRET;
      if (!signingSecret) {
        return withCors(
          Response.json(
            { error: 'Server cannot sign tokens — MCP_JWT_SECRET not configured' },
            { status: 500 }
          )
        );
      }
      const token = await signSessionToken({
        sessionId: sessionId.trim(),
        orgId: orgId.trim(),
        userId: userId.trim(),
        scopes: resolvedScopes,
        secret: signingSecret,
      });

      console.info('[auth:session-tokens] Issued session token', {
        sessionId: sessionId.trim(),
        orgId: orgId.trim(),
        userId: userId.trim(),
        scopes: resolvedScopes,
      });

      return withCors(
        Response.json({ token, expiresAt, sessionId: sessionId.trim() }, { status: 201 })
      );
    }

    // =========================================================================
    // Scaffold Streaming — SSE fan-out via ScaffoldSessionDO
    //
    // GET  /scaffold/:sessionId/stream  — requires stream token (?t=...)
    // POST /scaffold/:sessionId/event   — internal event push (ORGX_INTERNAL_SECRET)
    // GET  /scaffold/:sessionId/status  — requires stream token (?t=...)
    //
    // The DO is keyed by sessionId so each scaffold session has its own instance.
    // OPTIONS is handled here for CORS preflight.
    // =========================================================================
    const scaffoldMatch = url.pathname.match(
      /^\/scaffold\/([a-zA-Z0-9_-]+)\/(stream|event|status)$/
    );
    if (scaffoldMatch) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          },
        });
      }

      const sessionId = scaffoldMatch[1]!;
      const action = scaffoldMatch[2];

      // Stream and status endpoints require a valid stream token to prevent
      // unauthenticated access to scaffold event data.
      let scaffoldTokenExp: number | null = null;
      if (action === 'stream' || action === 'status') {
        const streamTokenSecret = env.MCP_JWT_SECRET || env.ORGX_INTERNAL_SECRET;
        const tokenParam = url.searchParams.get('t');
        if (!streamTokenSecret || !tokenParam) {
          return withCors(
            buildAuthErrorResponse({ reason: 'missing_token' })
          );
        }
        const verified = await verifyStreamTokenDetailed(tokenParam, streamTokenSecret);
        if (!verified.ok) {
          return withCors(
            buildAuthErrorResponse({
              reason: verified.reason === 'expired'
                ? 'stream_token_expired'
                : 'stream_token_invalid',
            })
          );
        }
        // Verify the token is scoped to this scaffold session. This is a
        // 403 (not 401) — the token is valid, the caller just isn't
        // authorized for this session. Refreshing wouldn't help.
        if (verified.payload.ft !== 'scaffold' || verified.payload.fi !== sessionId) {
          return withCors(
            Response.json(
              {
                error: 'access_denied',
                error_description: 'Token does not match this scaffold session',
              },
              { status: 403 }
            )
          );
        }
        scaffoldTokenExp = verified.payload.exp;
      }

      const doId = env.SCAFFOLD_SESSION.idFromName(sessionId);
      const stub = env.SCAFFOLD_SESSION.get(doId);
      // Forward the request to the DO with the same URL/method/body.
      const doResponse = await stub.fetch(request);
      // For live SSE, wrap the response so an `auth_expired` event is
      // emitted just before the stream token expires — otherwise the DO
      // would keep pushing events past the token's exp.
      if (action === 'stream' && scaffoldTokenExp !== null) {
        return withStreamTokenExpiry(doResponse, scaffoldTokenExp);
      }
      return doResponse;
    }

    // =========================================================================
    // Live Feed SSE — agent-status + initiative-pulse streaming
    //
    // GET /live-feed/agent-status/:initiativeId/stream
    // GET /live-feed/initiative-pulse/:initiativeId/stream
    //
    // The DO is keyed by "feedType:feedId" so each (type, id) pair shares one
    // polling instance with a 10-second alarm cycle.
    // =========================================================================
    const liveFeedMatch = url.pathname.match(
      /^\/live-feed\/(agent-status|initiative-pulse)\/([^/]+)\/stream$/
    );
    if (liveFeedMatch) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
          },
        });
      }

      // Verify short-lived HMAC stream token (?t=<token>)
      const token = url.searchParams.get('t') ?? '';
      const jwtSecret = env.MCP_JWT_SECRET;
      if (!token || !jwtSecret) {
        return buildAuthErrorResponse({
          reason: 'missing_token',
          headers: corsHeadersObj(),
        });
      }
      const result = await verifyStreamTokenDetailed(token, jwtSecret);
      if (!result.ok) {
        return buildAuthErrorResponse({
          reason: result.reason === 'expired'
            ? 'stream_token_expired'
            : 'stream_token_invalid',
          headers: corsHeadersObj(),
        });
      }
      const payload = result.payload;

      const feedType = liveFeedMatch[1]!;
      const feedId = liveFeedMatch[2]!;

      // Ensure token feedType/feedId match the path (prevent token reuse across feeds)
      if (payload.ft !== feedType || payload.fi !== feedId) {
        return new Response(JSON.stringify({ error: 'token_mismatch' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeadersObj() },
        });
      }

      const doKey = `${feedType}:${feedId}`;
      const doId = env.LIVE_FEED.idFromName(doKey);
      const stub = env.LIVE_FEED.get(doId);
      const liveFeedResponse = await stub.fetch(request);
      // Emit an `auth_expired` SSE event before the token's exp so clients
      // reconnect with a fresh token instead of receiving stale data past
      // the expiry window.
      return withStreamTokenExpiry(liveFeedResponse, payload.exp);
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
  const url = new URL(request.url);
  const requestedClientId = url.searchParams.get('client_id');
  const requestedRedirectUri = url.searchParams.get('redirect_uri');
  const requestedResponseType = url.searchParams.get('response_type');
  const requestedScope = url.searchParams.get('scope');
  const requestedCodeChallengeMethod =
    url.searchParams.get('code_challenge_method');

  console.info('[auth] Received authorization request', {
    clientId: requestedClientId,
    redirectUri: requestedRedirectUri,
    responseType: requestedResponseType,
    scope: requestedScope,
    codeChallengeMethod: requestedCodeChallengeMethod,
    userAgent: request.headers.get('user-agent')?.substring(0, 120),
    cfWorker: request.headers.get('cf-worker') ?? null,
  });

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    console.error('[auth] Failed to parse auth request:', error, {
      clientId: requestedClientId,
      redirectUri: requestedRedirectUri,
      responseType: requestedResponseType,
      scope: requestedScope,
      codeChallengeMethod: requestedCodeChallengeMethod,
      userAgent: request.headers.get('user-agent')?.substring(0, 120),
      cfWorker: request.headers.get('cf-worker') ?? null,
    });
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
  const error = url.searchParams.get('error');

  if (error) {
    return errorRedirect('access_denied', error, serverUrl);
  }

  if (!stateKey) {
    return errorRedirect(
      'invalid_request',
      'Missing or expired authorization session. Please start over.',
      serverUrl
    );
  }

  const identity = await resolveOAuthCallbackIdentity({
    url,
    env,
    stateKey,
    serverUrl,
  });
  if (identity instanceof Response) return identity;

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
      userId: identity.userId,
      metadata: { label: identity.userEmail },
      scope,
      props: {
        userId: identity.userId,
        scope: scope.join(' '),
        email: identity.userEmail,
      },
    });

    console.info('[auth] Authorization auto-approved', {
      userId: identity.userId,
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

  if (!stateKey) {
    return errorRedirect(
      'invalid_request',
      'Your authorization session has expired. Please start over.',
      serverUrl
    );
  }

  const identity = await resolveOAuthCallbackIdentity({
    url,
    env,
    stateKey,
    serverUrl,
  });
  if (identity instanceof Response) return identity;

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
      userId: identity.userId,
      metadata: { label: identity.userEmail },
      scope,
      props: {
        userId: identity.userId,
        scope: scope.join(' '),
        email: identity.userEmail,
      },
    });

    console.info('[auth] Authorization completed', {
      userId: identity.userId,
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

function corsHeadersObj(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}
