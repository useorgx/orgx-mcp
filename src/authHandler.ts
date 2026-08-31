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
  ClientInfo,
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
  AUTHORIZATION_POLICY,
  AUTHORIZATION_PRESETS,
  OAUTH_SCOPES_SUPPORTED,
  WIDGET_RESOURCES,
} from './toolDefinitions';
import { toSkybridgeResourceUri } from './widgetConfig';
import serverManifest from '../server.json';
import glamaConnectorManifest from '../glama.json';
import { signSessionToken } from './sessionToken';
import {
  verifyStreamTokenDetailed,
  withStreamTokenExpiry,
} from './streamToken';
import { verifyMcpIdentityTokenDetailed } from './mcpIdentityToken';
import { buildAuthErrorResponse } from './authErrors';
import { secureCompare } from './secureCompare';
import {
  handlePublicMcpDiscoveryRequest,
  PRIMARY_AUTHENTICATED_TOOLS,
} from './publicMcpDiscovery';
import { buildExecutionGraphHookBundle } from './executionGraphHookBundle';
import { DEFAULT_TOOL_PROFILE } from './toolProfiles';
import { SMITHERY_TOOL_PROFILES } from './smitheryConfig';

// Re-export type for use in index.ts
export type { OAuthHelpers };

interface AuthHandlerEnv {
  ORGX_API_URL: string;
  ORGX_API_FALLBACK_URL?: string;
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
  // Internal Supabase user UUID resolved + email-cross-checked by the web app at
  // token-mint time. Optional — absent when the web app couldn't safely resolve
  // it; the gateway then forwards only the Clerk id + email as before.
  orgxUserId?: string;
};

const ORGX_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OAUTH_STATE_TTL_SECONDS = 20 * 60;

const ED25519_SPKI_PREFIX = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/** Return the registry-required base64 encoding of the raw 32-byte key. */
export function normalizeRegistryPublicKey(value: string): string | null {
  const compact = value
    .trim()
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!compact) return null;
  try {
    const bytes = Uint8Array.from(atob(compact), (character) =>
      character.charCodeAt(0)
    );
    if (bytes.length === 32) return compact;
    if (
      bytes.length === ED25519_SPKI_PREFIX.length + 32 &&
      ED25519_SPKI_PREFIX.every((byte, index) => bytes[index] === byte)
    ) {
      return btoa(
        String.fromCharCode(...bytes.slice(ED25519_SPKI_PREFIX.length))
      );
    }
  } catch {
    // Invalid base64 is rejected below.
  }
  return null;
}

type ClientIconKind =
  | 'chatgpt'
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'vscode'
  | 'github_copilot'
  | 'windsurf'
  | 'zed'
  | 'cline'
  | 'roo_code'
  | 'continue'
  | 'raycast'
  | 'gemini'
  | 'goose'
  | 'openclaw'
  | 'opencode'
  | 'local'
  | 'unverified';

type ClientIdentityTrust =
  | 'verified_redirect'
  | 'registered_metadata'
  | 'local_callback'
  | 'unverified';

type ClientPresentation = {
  name: string;
  icon: ClientIconKind;
  identityTrust: ClientIdentityTrust;
};

type OAuthScopeSource = 'client_request' | 'server_read_default';

type StoredAuthRequest = AuthRequest & {
  clientPresentation?: ClientPresentation;
  scopeSource?: OAuthScopeSource;
};

function authStateKey(stateKey: string): string {
  return `auth_state:${stateKey}`;
}

function authIdentityKey(stateKey: string): string {
  return `auth_identity:${stateKey}`;
}

function isPlaceholderEmail(email: string | null | undefined): boolean {
  return Boolean(email?.toLowerCase().endsWith('@placeholder.local'));
}

function scopeListToParam(scopes: readonly string[] | undefined): string {
  return (scopes ?? []).join(' ');
}

function hostMatches(hostname: string, trustedDomain: string): boolean {
  return hostname === trustedDomain || hostname.endsWith(`.${trustedDomain}`);
}

const CLIENT_NAME_MATCHERS: ReadonlyArray<{
  icon: ClientIconKind;
  pattern: RegExp;
}> = [
  { icon: 'chatgpt', pattern: /^(chatgpt|openai chatgpt)$/i },
  { icon: 'codex', pattern: /^(codex|openai codex|codex cli)$/i },
  { icon: 'claude', pattern: /^(claude|claude code|claude desktop|anthropic)$/i },
  { icon: 'cursor', pattern: /^cursor$/i },
  { icon: 'vscode', pattern: /^(visual studio code|vs code|vscode)$/i },
  { icon: 'github_copilot', pattern: /^(github )?copilot$/i },
  { icon: 'windsurf', pattern: /^(windsurf|codeium)$/i },
  { icon: 'zed', pattern: /^zed$/i },
  { icon: 'cline', pattern: /^cline$/i },
  { icon: 'roo_code', pattern: /^(roo|roo code)$/i },
  { icon: 'continue', pattern: /^(continue|continue dev)$/i },
  { icon: 'raycast', pattern: /^raycast$/i },
  { icon: 'gemini', pattern: /^(gemini|gemini cli|google gemini)$/i },
  { icon: 'goose', pattern: /^(goose|block goose)$/i },
  { icon: 'openclaw', pattern: /^openclaw$/i },
  { icon: 'opencode', pattern: /^opencode$/i },
];

function safeRegisteredClientName(clientName: string | undefined): string | null {
  const normalized = clientName?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, 80) : null;
}

function iconForRegisteredName(clientName: string): ClientIconKind {
  // Dynamic clients commonly append a connection label to their registered
  // product name (for example, "Claude Code (orgx)"). Keep the full reported
  // name visible, but resolve the icon from the stable product portion. This
  // remains presentation only: registered metadata is never upgraded to a
  // verified client identity.
  const productName = clientName
    .replace(/\s+\([^()\r\n]{1,40}\)\s*$/, '')
    .trim();
  return (
    CLIENT_NAME_MATCHERS.find(({ pattern }) => pattern.test(productName))?.icon ??
    'local'
  );
}

function resolveClientPresentation(
  redirectUri: string,
  clientInfo?: Pick<ClientInfo, 'clientName'> | null
): ClientPresentation {
  try {
    const redirect = new URL(redirectUri);
    const hostname = redirect.hostname.toLowerCase();
    if (
      (hostMatches(hostname, 'chatgpt.com') ||
        hostMatches(hostname, 'openai.com')) &&
      redirect.pathname.includes('connector_platform_oauth_redirect')
    ) {
      return {
        name: 'ChatGPT',
        icon: 'chatgpt',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'cursor.com') || hostMatches(hostname, 'cursor.sh')) {
      return {
        name: 'Cursor',
        icon: 'cursor',
        identityTrust: 'verified_redirect',
      };
    }
    if (
      hostMatches(hostname, 'claude.ai') ||
      hostMatches(hostname, 'anthropic.com')
    ) {
      return {
        name: 'Claude',
        icon: 'claude',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'vscode.dev')) {
      return {
        name: 'Visual Studio Code',
        icon: 'vscode',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'windsurf.com')) {
      return {
        name: 'Windsurf',
        icon: 'windsurf',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'zed.dev')) {
      return {
        name: 'Zed',
        icon: 'zed',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'raycast.com')) {
      return {
        name: 'Raycast',
        icon: 'raycast',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'geminicli.com')) {
      return {
        name: 'Gemini CLI',
        icon: 'gemini',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'cline.bot')) {
      return {
        name: 'Cline',
        icon: 'cline',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'roocode.com')) {
      return {
        name: 'Roo Code',
        icon: 'roo_code',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'continue.dev')) {
      return {
        name: 'Continue',
        icon: 'continue',
        identityTrust: 'verified_redirect',
      };
    }
    if (hostMatches(hostname, 'opencode.ai')) {
      return {
        name: 'OpenCode',
        icon: 'opencode',
        identityTrust: 'verified_redirect',
      };
    }
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    ) {
      const registeredName = safeRegisteredClientName(clientInfo?.clientName);
      return registeredName
        ? {
            name: registeredName,
            icon: iconForRegisteredName(registeredName),
            identityTrust: 'registered_metadata',
          }
        : {
            name: 'Local MCP application',
            icon: 'local',
            identityTrust: 'local_callback',
          };
    }
  } catch {
    // The provider validates registered redirect URIs. Unknown or malformed
    // metadata must never be upgraded to a trusted brand in presentation.
  }
  const registeredName = safeRegisteredClientName(clientInfo?.clientName);
  return registeredName
    ? {
        name: registeredName,
        icon: 'unverified',
        identityTrust: 'registered_metadata',
      }
    : {
        name: 'Unverified MCP application',
        icon: 'unverified',
        identityTrust: 'unverified',
      };
}

function safeRedirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return 'Invalid callback';
  }
}

function isReadOnlyCodexTool(toolName: string | undefined): boolean {
  return Boolean(
    toolName &&
      (toolName === 'orgx_bootstrap' ||
        toolName === 'orgx_search' ||
        toolName === 'orgx_inspect' ||
        toolName === 'orgx_recommend' ||
        toolName === 'get_agent_status' ||
        toolName === 'get_initiative_pulse' ||
        toolName === 'recommend_next_action' ||
        toolName === 'query_org_memory' ||
        toolName === 'recall_memory' ||
        toolName === 'track_project_progress' ||
        toolName === 'get_morning_brief')
  );
}

function resolveSupportedRequestedScopes(
  requestedScopes: readonly string[] | undefined
): string[] {
  const supportedScopes = new Set<string>(OAUTH_SCOPES_SUPPORTED);
  return [...new Set((requestedScopes ?? []).filter((scope) =>
    supportedScopes.has(scope)
  ))];
}

function resolveApprovedScopes(
  requestedScopes: readonly string[] | undefined,
  finalScope: string
): string[] {
  const supportedScopes = new Set<string>(OAUTH_SCOPES_SUPPORTED);
  const requested = resolveSupportedRequestedScopes(requestedScopes);
  const requestedSet = new Set(requested);

  const selected = finalScope.split(/\s+/).filter(Boolean);
  const approved: string[] = [];
  const seen = new Set<string>();
  for (const scope of selected) {
    if (!supportedScopes.has(scope)) continue;
    if (!requestedSet.has(scope)) continue;
    if (seen.has(scope)) continue;
    seen.add(scope);
    approved.push(scope);
  }
  return approved;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function safeRedirectDestination(redirectTo: string): string {
  try {
    const url = new URL(redirectTo);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-redirect';
  }
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

    const claimedOrgxUserId = verified.payload.orgx_user_id;
    return {
      userId: verified.payload.sub,
      userEmail: verified.payload.email,
      orgxUserId:
        typeof claimedOrgxUserId === 'string' &&
        ORGX_UUID_RE.test(claimedOrgxUserId)
          ? claimedOrgxUserId
          : undefined,
    };
  }

  // Local development fallback only. Production query parameters are never
  // accepted as identity proof when the signing secret is missing.
  if (
    !isLoopbackUrl(params.serverUrl) ||
    !isLoopbackUrl(params.url.origin)
  ) {
    return errorRedirect(
      'server_error',
      'OrgX identity verification is not configured. Please contact the server administrator.',
      params.serverUrl
    );
  }
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
  return serveStaticAsset(request, env, '/index.html', '/index.html');
}

const CONSENT_CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
];

function consentRedirectCspSource(redirectUri: string): string | null {
  try {
    const redirect = new URL(redirectUri);
    if (redirect.protocol === 'http:' || redirect.protocol === 'https:') {
      return redirect.origin;
    }
    if (
      ['javascript:', 'data:', 'blob:', 'file:'].includes(redirect.protocol) ||
      !/^[a-z][a-z0-9+.-]*:$/.test(redirect.protocol)
    ) {
      return null;
    }
    return redirect.protocol;
  } catch {
    return null;
  }
}

async function serveConsentPage(
  request: Request,
  env: Pick<AuthHandlerEnv, 'ASSETS' | 'MCP_SERVER_URL' | 'OAUTH_KV'>
): Promise<Response> {
  const url = new URL(request.url);
  const stateKey = url.searchParams.get('state_key');
  let callbackSource: string | null = null;

  if (stateKey) {
    try {
      const storedState = await env.OAUTH_KV.get(authStateKey(stateKey));
      if (storedState) {
        const oauthRequest = JSON.parse(storedState) as StoredAuthRequest;
        callbackSource = consentRedirectCspSource(oauthRequest.redirectUri);
      }
    } catch (error) {
      console.warn('[auth] Failed to resolve consent callback CSP source', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const assetResponse = await serveStaticAsset(
    request,
    env,
    '/consent.html',
    '/consent.html'
  );
  if (assetResponse.status >= 300 && assetResponse.status < 400) {
    return assetResponse;
  }

  const headers = new Headers(assetResponse.headers);
  const formAction = ["'self'", callbackSource].filter(Boolean).join(' ');
  headers.set(
    'Content-Security-Policy',
    [...CONSENT_CSP_DIRECTIVES, `form-action ${formAction}`].join('; ')
  );
  headers.set('Cache-Control', 'no-store, no-transform');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

async function serveStaticAsset(
  request: Request,
  env: Pick<AuthHandlerEnv, 'ASSETS' | 'MCP_SERVER_URL'>,
  assetPath: string,
  fallbackPath: string
): Promise<Response> {
  const serverUrl = env.MCP_SERVER_URL ?? 'https://mcp.useorgx.com';

  if (env.ASSETS?.fetch) {
    const assetRequest = new Request(new URL(assetPath, serverUrl).toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: request.headers,
    });
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    if (assetResponse.ok) {
      return withCors(assetResponse);
    }
  }

  return Response.redirect(new URL(fallbackPath, serverUrl).toString(), 302);
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
        'Optional tool profile to expose at connection time. Use chatgpt for OpenAI review or claude-directory for Anthropic non-destructive review. Defaults to the published v2 surface; full is explicit admin/debug compatibility.',
      enum: [...SMITHERY_TOOL_PROFILES],
      default: DEFAULT_TOOL_PROFILE,
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

const PUBLISHED_WIDGET_URI_OVERRIDES = new Map<string, string>(
  WIDGET_RESOURCES.flatMap((widget) => {
    const [baseUri] = widget.uri.split('?');
    const skybridgeUri = toSkybridgeResourceUri(widget.uri);
    const [baseSkybridgeUri] = skybridgeUri.split('?');
    return [
      [baseUri, widget.uri],
      [baseSkybridgeUri, skybridgeUri],
    ];
  })
);

const LOCAL_CONFIG_WRITE_POLICY = {
  automaticWrites: false,
  allowedPaths: ['.cursor/orgx/**', '~/.cursor/mcp.json'],
  deniedPaths: ['.cursor/commands/**', '.cursor/rules/**', '.claude/**'],
  note:
    'Hosted config endpoints only describe install metadata. Local installers must prompt before writing files and must keep generated Cursor assets under .cursor/orgx/.',
} as const;

function getUpstreamHealthUrls(env: AuthHandlerEnv): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of [env.ORGX_API_URL, env.ORGX_API_FALLBACK_URL]) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

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

    if (url.pathname === '/public' || url.pathname === '/public/mcp') {
      return withCors(await handlePublicMcpDiscoveryRequest(request));
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/.well-known/orgx-authorization-policy'
    ) {
      return withCors(
        Response.json(AUTHORIZATION_POLICY, {
          headers: { 'Cache-Control': 'public, max-age=300' },
        })
      );
    }

    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      url.pathname === '/consent.html'
    ) {
      return serveConsentPage(request, env);
    }

    // =========================================================================
    // Health Check — supports ?check=upstream to verify API connectivity
    // =========================================================================
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      const check = url.searchParams.get('check');
      if (check === 'upstream') {
        try {
          const apiUrls = getUpstreamHealthUrls(env);
          if (apiUrls.length === 0) {
            return withCors(
              Response.json(
                { status: 'fail', upstream: 'unconfigured', error: 'ORGX_API_URL not set' },
                { status: 503 }
              )
            );
          }

          const failures: Array<Record<string, unknown>> = [];
          for (const [index, apiUrl] of apiUrls.entries()) {
            try {
              const probe = await fetch(`${apiUrl}/api/health`, {
                redirect: 'manual',
                signal: AbortSignal.timeout(5000),
              });
              if (probe.status >= 300 && probe.status < 400) {
                const location = probe.headers.get('location') ?? 'unknown';
                failures.push({
                  apiUrl,
                  upstream: 'redirect',
                  httpStatus: probe.status,
                  location,
                });
                continue;
              }
              if (!probe.ok) {
                failures.push({
                  apiUrl,
                  upstream: 'error',
                  httpStatus: probe.status,
                });
                continue;
              }
              return withCors(
                Response.json({
                  status: 'ok',
                  upstream: index === 0 ? 'healthy' : 'fallback_healthy',
                  apiUrl,
                  attempted: apiUrls,
                  ...(failures.length ? { failures } : {}),
                })
              );
            } catch (err) {
              failures.push({
                apiUrl,
                upstream: 'unreachable',
                error: String(err),
              });
            }
          }

          return withCors(
            Response.json(
              {
                status: 'fail',
                upstream: 'unreachable',
                failures,
                fix: 'Update ORGX_API_URL or ORGX_API_FALLBACK_URL in wrangler.toml to a reachable URL with no redirect.',
              },
              { status: 502 }
            )
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

    if (request.method === 'GET' && url.pathname === '/.well-known/glama.json') {
      return withCors(
        Response.json(glamaConnectorManifest, {
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
            version: serverManifest.version,
            category: 'organizational-continuity-for-ai-agents',
            registry: 'com.useorgx/orgx-mcp',
            remote: 'https://mcp.useorgx.com/mcp',
            public_discovery: 'https://mcp.useorgx.com/public',
            integration_walkthrough: 'https://mcp.useorgx.com/hope-ux',
            llms: 'https://mcp.useorgx.com/llms.txt',
            server_manifest: 'https://mcp.useorgx.com/server.json',
            should_use_when: [
              'continue work another agent, session, or teammate started',
              'remember or recall a decision that must not be relitigated',
              'search team memory or project context',
              'find prior artifacts or plans with provenance',
              'review agent work awaiting human approval',
              'assign work to specialist AI agents',
              'track project health, blockers, milestones, and owners',
              'create a full initiative hierarchy from a partner workflow',
              'prove completion with receipts and evidence rather than prose',
              'read back operator chronicle proof across decisions, artifacts, PRs, goals, and gaps',
            ],
            primary_tools: PRIMARY_AUTHENTICATED_TOOLS,
            integration_tool_chain: [
              'orgx_bootstrap',
              'scaffold_initiative',
              'get_initiative_pulse',
              'get_operator_chronicle',
              'orgx_submit_receipt',
            ],
            answer_engine_topics: [
              'organizational continuity for AI agents',
              'OrgX MCP integration',
              'organizational memory MCP server',
              'MCP initiative scaffolding',
              'AI agent proof receipts',
              'operator chronicle for agent work',
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
      (request.method === 'GET' || request.method === 'HEAD') &&
      (url.pathname === '/hope-ux' || url.pathname === '/hope-ux/')
    ) {
      return serveStaticAsset(request, env, '/hope-ux.html', '/hope-ux.html');
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
            category: 'Organizational continuity for AI agents',
            description:
              'Make AI work resumable, reviewable, and provable across agents. OrgX lets the next agent continue from the decisions, artifacts, approvals, owners, and proof the last agent left behind.',
            endpoints: {
              mcp: 'https://mcp.useorgx.com/mcp',
              llms: 'https://mcp.useorgx.com/llms.txt',
              agents: 'https://mcp.useorgx.com/agents.md',
            },
            choose_orgx_for: [
              'work that will continue across sessions, agents, tools, or teammates',
              'decisions that must not be relitigated',
              'artifacts that need provenance or review',
              'human approval, ownership, delegation, or blocker tracking',
              'completion that must be proven with evidence rather than prose',
            ],
            do_not_use_for: [
              'personal preferences',
              'generic web research',
              'documentation lookup',
              'local file reads',
              'disposable one-off notes',
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
        resource_documentation: 'https://docs.useorgx.com/api/scopes',
        authorization_policy:
          `${serverUrl}/.well-known/orgx-authorization-policy`,
      };
      return withCors(
        Response.json(metadata, {
          headers: { 'Cache-Control': 'public, max-age=3600' },
        })
      );
    }

    // =========================================================================
    // Authorization Server Metadata (RFC 8414)
    // Serve both the exact route and path variants through the app handler so
    // browser-based MCP clients receive the same CORS contract.
    // =========================================================================
    if (isOAuthAuthorizationServerMetadataPath(url.pathname)) {
      console.info('[auth:discovery] Auth server metadata requested', {
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
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: false,
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

    // Consent page display data is resolved from opaque server-side state.
    if (
      url.pathname === '/oauth/consent-session' &&
      request.method === 'GET'
    ) {
      return handleConsentSession(request, env);
    }

    // Step 3: /oauth/consent-callback — user approved scopes, complete authorization
    if (url.pathname === '/oauth/consent-callback') {
      if (request.method !== 'POST') {
        return Response.json(
          {
            error: 'method_not_allowed',
            error_description: 'Consent must be submitted from the authorization form.',
          },
          {
            status: 405,
            headers: {
              Allow: 'POST',
              'Cache-Control': 'no-store',
            },
          }
        );
      }
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
      const pubkey = env.MCP_REGISTRY_PUBKEY
        ? normalizeRegistryPublicKey(env.MCP_REGISTRY_PUBKEY)
        : null;
      if (!pubkey) {
        return withCors(
          new Response(
            'MCP Registry auth not configured with a valid Ed25519 public key.',
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
        tools: (serverManifest.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          ...(isReadOnlyCodexTool(tool.name) ? { readOnly: true } : {}),
        })),
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
# enabled_tools = ["orgx_bootstrap", "orgx_search", "orgx_recommend"]

# To authenticate, set your token:
# export ORGX_API_TOKEN="your-token-here"
# Get your token at: https://app.useorgx.com/settings/api

# --- OrgX execution-graph auto-emit hook (WEG keystone, OPT-IN) ---
# Codex has no native lifecycle hook bundle, so wire the emitter via notify.
# It no-ops unless ORGX_EMIT_EXECUTION_GRAPH is set, so this is safe to add.
#   notify = ["node", "/absolute/path/to/orgx-emit-execution-graph.mjs"]
# Enable per shell:
#   export ORGX_EMIT_EXECUTION_GRAPH=1
#   export ORGX_INITIATIVE_ID="<initiative-uuid>"
#   export ORGX_CLIENT_KEY="oxk_..."           # or ORGX_SERVICE_KEY + ORGX_USER_ID
#   export ORGX_SOURCE_CLIENT="codex"
# Emitter + full instructions: ${webUrl}/docs/integrations/execution-graph-hook
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
        // Execution-graph auto-emit hook (WEG keystone). Advertised, OPT-IN, and
        // described abstractly — the hosted config intentionally does not write
        // local files; see docs for the settings hook snippet.
        lifecycleHooks: buildExecutionGraphHookBundle({
          sourceClient: 'claude',
          webUrl,
        }),
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
          // The Stop hook can fire the execution-graph auto-emit (WEG keystone).
          executionGraphHook: buildExecutionGraphHookBundle({
            sourceClient: 'cursor',
            webUrl,
          }),
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

  // Resolve the display identity once, while the provider's registered client
  // metadata is available. Registered names remain explicitly distinct from
  // callback-domain-verified brands in the consent UI.
  let clientInfo: ClientInfo | null = null;
  try {
    clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  } catch (error) {
    console.warn('[auth] Registered client metadata could not be loaded', {
      clientId: oauthReqInfo.clientId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const shouldApplyReadDefault =
    requestedScope === null && (oauthReqInfo.scope?.length ?? 0) === 0;
  const storedAuthRequest: StoredAuthRequest = {
    ...oauthReqInfo,
    // OAuth scope is optional. Claude Code and Cursor can omit it entirely.
    // When neither the URL nor the provider parser resolves client scopes,
    // treat omission as the documented server-side Read preset, while an
    // explicit empty or unsupported scope still fails closed. The same value
    // is persisted into the AuthRequest used by completeAuthorization(), so
    // the browser can never select beyond this least-privilege baseline.
    scope:
      shouldApplyReadDefault
        ? [...AUTHORIZATION_PRESETS.read.scopes]
        : oauthReqInfo.scope,
    scopeSource:
      shouldApplyReadDefault ? 'server_read_default' : 'client_request',
    clientPresentation: resolveClientPresentation(
      oauthReqInfo.redirectUri,
      clientInfo
    ),
  };

  // Store oauthReqInfo in KV with a random state key (TTL: 20 min)
  const stateKey = crypto.randomUUID();
  try {
    await env.OAUTH_KV.put(
      authStateKey(stateKey),
      JSON.stringify(storedAuthRequest),
      { expirationTtl: OAUTH_STATE_TTL_SECONDS }
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
    clientId: storedAuthRequest.clientId,
    scope: storedAuthRequest.scope,
    scopeSource: storedAuthRequest.scopeSource,
  });

  return Response.redirect(signInUrl.toString(), 302);
}

export function isOAuthAuthorizationServerMetadataPath(
  pathname: string
): boolean {
  return (
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname.startsWith('/.well-known/oauth-authorization-server/')
  );
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

  let oauthReqInfo: AuthRequest;
  try {
    const stored = await env.OAUTH_KV.get(authStateKey(stateKey));
    if (!stored) {
      return errorRedirect(
        'invalid_request',
        'Authorization session expired. Please start over.',
        serverUrl
      );
    }
    oauthReqInfo = JSON.parse(stored);
  } catch (error) {
    console.error('[auth] Failed to read state from KV:', error);
    return errorRedirect(
      'invalid_request',
      'Invalid authorization data. Please start over.',
      serverUrl
    );
  }

  try {
    await env.OAUTH_KV.put(
      authIdentityKey(stateKey),
      JSON.stringify({
        userId: identity.userId,
        userEmail: identity.userEmail,
        ...(identity.orgxUserId ? { orgxUserId: identity.orgxUserId } : {}),
      } satisfies OAuthCallbackIdentity),
      { expirationTtl: OAUTH_STATE_TTL_SECONDS }
    );

    // Keep the browser URL opaque. Client metadata, callback details, scopes,
    // and identity remain server-side and are loaded by the same-origin consent
    // session endpoint. This prevents OAuth and personal data leaking through
    // browser history, referrers, screenshots, or third-party assets.
    const consentUrl = new URL(`${serverUrl}/consent.html`);
    consentUrl.searchParams.set('state_key', stateKey);

    console.info('[auth] Redirecting to OAuth consent', {
      userId: identity.userId,
      scope: scopeListToParam(oauthReqInfo.scope),
      clientId: oauthReqInfo.clientId,
    });

    return Response.redirect(consentUrl.toString(), 302);
  } catch (error) {
    console.error('[auth] Failed to prepare OAuth consent:', error);
    return errorRedirect(
      'server_error',
      "We couldn't prepare your authorization. This is usually temporary — please try again.",
      serverUrl
    );
  }
}

/**
 * GET /oauth/consent-session — Same-origin display contract for consent.html.
 *
 * The state key is an opaque, short-lived capability. No OAuth state or
 * redirect authority is returned to the page; approve and deny are resolved
 * against the server-side AuthRequest.
 */
async function handleConsentSession(
  request: Request,
  env: AuthHandlerEnv
): Promise<Response> {
  const url = new URL(request.url);
  const stateKey = url.searchParams.get('state_key');
  if (!stateKey) {
    return Response.json(
      {
        error: 'invalid_request',
        error_description: 'Missing authorization session.',
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const [storedState, storedIdentity] = await Promise.all([
      env.OAUTH_KV.get(authStateKey(stateKey)),
      env.OAUTH_KV.get(authIdentityKey(stateKey)),
    ]);
    if (!storedState || !storedIdentity) {
      return Response.json(
        {
          error: 'authorization_session_expired',
          error_description:
            'This authorization session expired or was already used. Restart the connection from your MCP client.',
        },
        { status: 410, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const oauthReqInfo = JSON.parse(storedState) as StoredAuthRequest;
    const identity = JSON.parse(storedIdentity) as OAuthCallbackIdentity;
    if (
      !oauthReqInfo?.clientId ||
      !oauthReqInfo?.redirectUri ||
      !identity?.userEmail
    ) {
      return Response.json(
        {
          error: 'invalid_authorization_session',
          error_description: 'The authorization session is invalid.',
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const requestedScopes = resolveSupportedRequestedScopes(oauthReqInfo.scope);
    const requestedScopeCount = Array.isArray(oauthReqInfo.scope)
      ? oauthReqInfo.scope.length
      : 0;
    const scopeSource: OAuthScopeSource =
      oauthReqInfo.scopeSource === 'server_read_default'
        ? 'server_read_default'
        : 'client_request';
    const clientPresentation =
      oauthReqInfo.clientPresentation ??
      resolveClientPresentation(oauthReqInfo.redirectUri);
    return Response.json(
      {
        session: {
          state_key: stateKey,
          expires_in_seconds: OAUTH_STATE_TTL_SECONDS,
        },
        client: {
          id: oauthReqInfo.clientId,
          name: clientPresentation.name,
          icon: clientPresentation.icon,
          identity_trust: clientPresentation.identityTrust,
          redirect_uri: oauthReqInfo.redirectUri,
          redirect_host: safeRedirectHost(oauthReqInfo.redirectUri),
        },
        account: {
          email: identity.userEmail,
          scope_boundary: 'accessible_workspaces',
        },
        authorization_policy: AUTHORIZATION_POLICY,
        requested_scopes: requestedScopes,
        scope_resolution: {
          source: scopeSource,
          status:
            requestedScopes.length > 0
              ? 'ready'
              : requestedScopeCount > 0
                ? 'unsupported'
                : 'empty',
        },
        offline_access_requested: requestedScopes.includes('offline_access'),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      }
    );
  } catch (error) {
    console.error('[auth] Failed to load consent session:', error);
    return Response.json(
      {
        error: 'invalid_authorization_session',
        error_description: 'The authorization session could not be loaded.',
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

/**
 * POST /oauth/consent-callback — User approved scopes, complete authorization via provider
 */
async function handleConsentCallback(
  request: Request,
  env: AuthHandlerEnv,
  serverUrl: string
): Promise<Response> {
  const wantsJson = request.headers.get('accept')
    ?.split(',')
    .some((value) => value.trim().startsWith('application/json')) ?? false;
  const consentError = (
    error: string,
    errorDescription: string,
    status = 400
  ): Response =>
    wantsJson
      ? Response.json(
          { error, error_description: errorDescription },
          { status, headers: { 'Cache-Control': 'no-store' } }
        )
      : errorRedirect(error, errorDescription, serverUrl);
  const consentRedirect = (redirectTo: string): Response =>
    wantsJson
      ? Response.json(
          { redirect_to: redirectTo },
          { headers: { 'Cache-Control': 'no-store' } }
        )
      : Response.redirect(redirectTo, 302);

  let body: FormData;
  try {
    body = await request.formData();
  } catch {
    return consentError(
      'invalid_request',
      'The consent submission was invalid. Please start over.'
    );
  }

  const stateKey = typeof body.get('state_key') === 'string'
    ? String(body.get('state_key'))
    : null;
  const finalScope = typeof body.get('final_scope') === 'string'
    ? String(body.get('final_scope'))
    : null;
  const action = typeof body.get('action') === 'string'
    ? String(body.get('action'))
    : null;

  if (!stateKey) {
    return consentError(
      'invalid_request',
      'Your authorization session has expired. Please start over.'
    );
  }

  // Load the opaque state. It is deleted only after deny or successful grant
  // creation so transient provider failures remain retryable.
  let oauthReqInfo: AuthRequest;
  let identity: OAuthCallbackIdentity;
  try {
    const [storedState, storedIdentity] = await Promise.all([
      env.OAUTH_KV.get(authStateKey(stateKey)),
      env.OAUTH_KV.get(authIdentityKey(stateKey)),
    ]);
    if (!storedIdentity) {
      return consentError(
        'invalid_request',
        'Authorization session identity expired. Please start over.'
      );
    }
    if (!storedState) {
      return consentError(
        'invalid_request',
        'Authorization session expired or already used. Please start over.'
      );
    }
    oauthReqInfo = JSON.parse(storedState);
    identity = JSON.parse(storedIdentity);
    if (
      !identity ||
      typeof identity.userId !== 'string' ||
      typeof identity.userEmail !== 'string' ||
      identity.userId.trim().length === 0 ||
      identity.userEmail.trim().length === 0
    ) {
      return consentError(
        'invalid_request',
        'Authorization session identity is invalid. Please start over.'
      );
    }
    // Drop a malformed persisted UUID rather than propagating it into props.
    if (
      typeof identity.orgxUserId !== 'string' ||
      !ORGX_UUID_RE.test(identity.orgxUserId)
    ) {
      identity.orgxUserId = undefined;
    }
  } catch (error) {
    console.error('[auth] Failed to load consent state from KV:', error);
    return consentError(
      'invalid_request',
      'Invalid authorization data. Please start over.'
    );
  }

  if (action === 'deny') {
    try {
      const redirectUrl = new URL(oauthReqInfo.redirectUri);
      redirectUrl.searchParams.set('error', 'access_denied');
      redirectUrl.searchParams.set(
        'error_description',
        'The resource owner denied the authorization request.'
      );
      if (oauthReqInfo.state) {
        redirectUrl.searchParams.set('state', oauthReqInfo.state);
      }
      await Promise.all([
        env.OAUTH_KV.delete(authStateKey(stateKey)),
        env.OAUTH_KV.delete(authIdentityKey(stateKey)),
      ]);
      return consentRedirect(redirectUrl.toString());
    } catch (error) {
      console.error('[auth] Failed to deny authorization:', error);
      return consentError(
        'invalid_request',
        'The authorization request could not be denied safely. Please restart it from the client.'
      );
    }
  }

  if (action !== 'approve') {
    return consentError(
      'invalid_request',
      'Unknown consent action. Please start over.'
    );
  }

  if (finalScope === null) {
    return consentError(
      'invalid_request',
      'The consent selection was missing. Please review access and try again.'
    );
  }

  // Use user-selected scopes from the consent page, clamped to the scopes
  // originally requested by the client and supported by this server.
  const scope = resolveApprovedScopes(oauthReqInfo.scope, finalScope);
  if (scope.filter((selectedScope) => selectedScope !== 'offline_access').length === 0) {
    return consentError(
      'invalid_request',
      'Choose at least one resource permission before authorizing.'
    );
  }

  // Complete authorization via the OAuthProvider
  // This creates a grant, issues an auth code, and returns the redirect URL
  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: identity.userId,
      metadata: { label: identity.userEmail },
      scope,
      // OrgX intentionally supports concurrent grants for the same account and
      // OAuth client. ChatGPT runtime connections, Codex, and OpenAI's plugin
      // review scanner can all authorize independently while sharing a client
      // identity. The provider's default revocation path scans every grant for
      // the user synchronously before returning the authorization redirect;
      // high-cardinality accounts can therefore exhaust Worker/KV limits and
      // leave the browser stuck on "Authorizing connection". Disconnect and
      // explicit revocation remain the lifecycle boundary for existing grants.
      revokeExistingGrants: false,
      props: {
        userId: identity.userId,
        ...(identity.orgxUserId ? { orgxUserId: identity.orgxUserId } : {}),
        scope: scope.join(' '),
        email: identity.userEmail,
      },
    });

    console.info('[auth] Authorization completed', {
      userId: identity.userId,
      scope: scope.join(' '),
      redirectTo: safeRedirectDestination(redirectTo),
    });

    // Consume the opaque session only after the provider has successfully
    // created the grant. A transient provider failure remains safely retryable.
    await Promise.all([
      env.OAUTH_KV.delete(authStateKey(stateKey)),
      env.OAUTH_KV.delete(authIdentityKey(stateKey)),
    ]);

    // Browser consent requests receive the provider-validated callback so the
    // page can navigate after a same-origin POST. This avoids Chromium applying
    // form-action to the POST redirect chain. Non-browser clients retain the
    // standard direct 302 response.
    return consentRedirect(redirectTo);
  } catch (error) {
    console.error('[auth] Failed to complete authorization:', error);
    return consentError(
      'server_error',
      "We couldn't complete your authorization. This is usually temporary — please try again.",
      500
    );
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function corsHeadersObj(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}
