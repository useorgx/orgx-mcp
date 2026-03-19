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
 */

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

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

/**
 * Authenticate incoming requests for non-provider paths.
 *
 * For provider-routed paths (/mcp, /sse), the OAuthProvider has already
 * validated the token and injected props — this function is not called.
 *
 * For other paths (root URL rewrites, WebSocket), this:
 * 1. Checks DEV_USER_ID for local development
 * 2. Validates Bearer tokens via OAuthProvider.unwrapToken()
 * 3. Falls through to anonymous (WebSocket connections use DO session auth)
 */
export async function authenticateRequest(
  request: Request,
  env: AuthEnv
): Promise<AuthResult> {
  const path = new URL(request.url).pathname;
  const hasAuth = !!request.headers.get('authorization');

  console.info('[auth] Authenticating request (non-provider path)', {
    method: request.method,
    path,
    hasAuth,
    hasDevUserId: !!env.DEV_USER_ID,
  });

  // Development mode: if DEV_USER_ID is set, use it for local testing
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

  // Extract Bearer token from Authorization header
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
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

      console.warn('[auth] Bearer token invalid or expired', { path });
    } catch (error) {
      console.error('[auth] Failed to validate Bearer token:', error);
    }
  }

  // No valid token — return anonymous
  // WebSocket connections rely on DO session auth (persisted SQLite)
  if (!hasAuth) {
    console.info('[auth] No token provided, returning anonymous', { path });
  }
  return { userId: undefined, scope: undefined, email: undefined };
}
