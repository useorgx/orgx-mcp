/**
 * Request Authentication for non-provider paths
 *
 * The OAuthProvider handles token validation for /mcp and /sse routes
 * automatically. This module handles auth for paths that go through
 * the defaultHandler (root URL rewrites, WebSocket connections):
 *
 * 1. DEV_USER_ID bypass for local development
 * 2. Bearer token validation via OAuthProvider.unwrapToken()
 * 3. Anonymous passthrough (WebSocket connections use DO session auth)
 *
 * Auth failure semantics (important — this used to silently demote expired
 * tokens to anonymous, which meant clients never saw a 401 and never
 * triggered their refresh flow):
 *
 *   - No `authorization` header at all        → anonymous (userId: undefined)
 *   - Header present, token valid             → authenticated props
 *   - Header present, token invalid/expired   → 401 Response in `auth.response`
 *
 * Callers (see `mcpTransport.ts`) honour `auth.response` and short-circuit.
 * The 401 carries a proper `WWW-Authenticate: Bearer error="invalid_token"`
 * header so the client can branch on refresh-vs-reauth.
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { buildAuthErrorResponse } from './authErrors';

type AuthResult = {
  userId?: string;
  scope?: string;
  email?: string;
  response?: Response;
};

interface AuthEnv {
  MCP_SERVER_URL: string;
  OAUTH_PROVIDER: OAuthHelpers;
  DEV_USER_ID?: string;
}

function buildResourceMetadataUrl(env: AuthEnv): string | null {
  if (!env.MCP_SERVER_URL) return null;
  // RFC 9728 resource metadata endpoint served by the OAuthProvider.
  return `${env.MCP_SERVER_URL.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`;
}

/**
 * Authenticate incoming requests for non-provider paths.
 *
 * For provider-routed paths (/mcp, /sse), the OAuthProvider has already
 * validated the token and injected props — this function is not called.
 *
 * For other paths (root URL rewrites, WebSocket), this:
 * 1. Checks DEV_USER_ID for local development
 * 2. Validates Bearer tokens via OAuthProvider.unwrapToken()
 * 3. Falls through to anonymous only when NO header was provided
 */
export async function authenticateRequest(
  request: Request,
  env: AuthEnv
): Promise<AuthResult> {
  const path = new URL(request.url).pathname;
  const authHeader = request.headers.get('authorization');
  const hasAuth = !!authHeader;

  console.info('[auth] Authenticating request (non-provider path)', {
    method: request.method,
    path,
    hasAuth,
    hasDevUserId: !!env.DEV_USER_ID,
  });

  // Development mode: if DEV_USER_ID is set, use it for local testing.
  // Runs before bearer validation so local flows can reach protected paths
  // without a real token. Production deployments must never set DEV_USER_ID.
  if (env.DEV_USER_ID) {
    console.info('[auth] Using DEV_USER_ID for local development', {
      userId: env.DEV_USER_ID,
    });
    return {
      userId: env.DEV_USER_ID,
      scope:
        'read write admin agents:read agents:write decisions:read decisions:write initiatives:read initiatives:write memory:read',
      email: 'dev@localhost',
    };
  }

  // Extract Bearer token. We only validate the `Bearer` scheme here —
  // anything else (`Basic`, malformed header) is treated like "tried but
  // failed" so the client gets a clean 401, not anonymous.
  if (authHeader) {
    if (!authHeader.startsWith('Bearer ')) {
      return {
        response: buildAuthErrorResponse({
          reason: 'invalid_token',
          description: 'Authorization header must use the Bearer scheme',
          resourceMetadataUrl: buildResourceMetadataUrl(env),
        }),
      };
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return {
        response: buildAuthErrorResponse({
          reason: 'missing_token',
          resourceMetadataUrl: buildResourceMetadataUrl(env),
        }),
      };
    }

    try {
      const tokenData = await env.OAUTH_PROVIDER.unwrapToken<{
        userId?: string;
        scope?: string;
        email?: string;
      }>(token);

      if (tokenData) {
        const props = tokenData.grant?.props;
        const userId = props?.userId ?? tokenData.userId;
        const scope = props?.scope ?? tokenData.grant?.scope?.join(' ');
        const email = props?.email;

        console.info('[auth] Bearer token validated via unwrapToken', {
          userId,
          hasScope: !!scope,
          path,
        });

        return { userId, scope, email };
      }

      // `unwrapToken` returns null for both expired and invalid tokens.
      // We can't cheaply distinguish them at the call site (the provider
      // clears expired entries from KV before returning null), so emit the
      // conservative `invalid_token` reason. Clients treat both the same
      // way — attempt a refresh, fall back to reauth on second failure.
      console.warn('[auth] Bearer token invalid or expired', { path });
      return {
        response: buildAuthErrorResponse({
          reason: 'invalid_token',
          description:
            'Access token invalid or expired. Refresh the token and retry; if refresh also fails, re-authorize.',
          resourceMetadataUrl: buildResourceMetadataUrl(env),
        }),
      };
    } catch (error) {
      console.error('[auth] Failed to validate Bearer token:', error);
      // Don't leak exception details to the client — the token was presented
      // but couldn't be verified. Same 401 shape so the refresh path works.
      return {
        response: buildAuthErrorResponse({
          reason: 'invalid_token',
          description:
            'Access token could not be verified. Refresh the token and retry.',
          resourceMetadataUrl: buildResourceMetadataUrl(env),
        }),
      };
    }
  }

  // No Authorization header at all. This is the only branch that stays
  // anonymous — e.g. WebSocket upgrades that rely on DO session auth, or
  // public-facing root URL hits before sign-in.
  console.info('[auth] No token provided, returning anonymous', { path });
  return { userId: undefined, scope: undefined, email: undefined };
}
