/**
 * authErrors.ts — Centralized 401 builders for the orgx-mcp bearer path.
 *
 * The upstream `@cloudflare/workers-oauth-provider` already emits proper
 * RFC 6750 / RFC 9728 responses for its own protected endpoints (/mcp, /sse).
 * This helper covers every other auth-gated surface we serve ourselves:
 *
 *   - Root URL rewrites that call `authenticateRequest` directly
 *   - Stream token endpoints (`/scaffold/:sid/stream`, live-feed)
 *   - Session token validation (internal `/session-tokens` redemption)
 *
 * Every 401 we return from our own code now shares the same shape so clients
 * can branch on `error="invalid_token"` + `error_description` and take the
 * right refresh action instead of guessing at "you're signed out".
 */
export type AuthErrorReason =
  | 'missing_token'
  | 'invalid_token'
  | 'token_expired'
  | 'session_expired'
  | 'stream_token_expired'
  | 'stream_token_invalid';

export interface AuthErrorResponseOptions {
  /**
   * The reason the token failed. Drives both the HTTP response shape and the
   * `error_description` returned to clients. Keep to this fixed set — adding
   * free-form reasons makes client branching fragile.
   */
  reason: AuthErrorReason;
  /**
   * Optional override for `error_description`. If omitted, a stable default is
   * used. Avoid including token values, user identifiers, or expiry timestamps
   * here — those leak into client logs without serving the refresh path.
   */
  description?: string;
  /**
   * RFC 9728 resource metadata URL for discovery-driven clients. Optional.
   * Emitted on the `WWW-Authenticate` header as `resource_metadata="..."`.
   */
  resourceMetadataUrl?: string | null;
  /**
   * Extra headers to merge in (CORS, caching). `WWW-Authenticate` is always
   * overwritten by this function regardless of what's passed.
   */
  headers?: HeadersInit;
}

const REASON_DEFAULTS: Record<
  AuthErrorReason,
  { error: string; description: string }
> = {
  missing_token: {
    error: 'invalid_token',
    description: 'Missing access token',
  },
  invalid_token: {
    error: 'invalid_token',
    description: 'Invalid access token',
  },
  token_expired: {
    error: 'invalid_token',
    description: 'Access token expired. Refresh the token and retry.',
  },
  session_expired: {
    error: 'invalid_token',
    description: 'Session token expired. Request a new session token from /session-tokens.',
  },
  stream_token_expired: {
    error: 'invalid_token',
    description: 'Stream token expired. Request a new stream token and reconnect.',
  },
  stream_token_invalid: {
    error: 'invalid_token',
    description: 'Stream token invalid. Request a new stream token and reconnect.',
  },
};

/**
 * Build an RFC 6750 + RFC 9728 `WWW-Authenticate` header value.
 *
 * Shape:
 *   Bearer error="invalid_token",
 *          error_description="...",
 *          resource_metadata="..."
 *
 * Quoted params use plain double quotes; values are escaped only for the
 * characters RFC 6750 treats as special (`"` and `\`). Description text is
 * controlled by us (see REASON_DEFAULTS) so we don't sanitize further.
 */
export function buildWwwAuthenticateHeader(opts: {
  error: string;
  description: string;
  resourceMetadataUrl?: string | null;
}): string {
  const parts: string[] = [`error="${opts.error}"`];
  if (opts.description) {
    parts.push(`error_description="${opts.description.replace(/"/g, '\\"')}"`);
  }
  if (opts.resourceMetadataUrl) {
    parts.push(`resource_metadata="${opts.resourceMetadataUrl}"`);
  }
  return `Bearer ${parts.join(', ')}`;
}

/**
 * Build the full 401 Response for an auth failure. The body matches the
 * JSON shape used by the upstream OAuth provider so downstream clients that
 * parse the body (rather than only the header) still recognize the error.
 */
export function buildAuthErrorResponse(
  options: AuthErrorResponseOptions
): Response {
  const { reason } = options;
  const defaults = REASON_DEFAULTS[reason];
  const description = options.description ?? defaults.description;

  const headers = new Headers(options.headers);
  headers.set(
    'WWW-Authenticate',
    buildWwwAuthenticateHeader({
      error: defaults.error,
      description,
      resourceMetadataUrl: options.resourceMetadataUrl ?? null,
    })
  );
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Auth failures must never be cached — a refresh flips them to 200, and a
  // stale cached 401 would trap the user in a loop.
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }

  return new Response(
    JSON.stringify({
      error: defaults.error,
      error_description: description,
      // Non-RFC extension: lets clients switch on a stable code without
      // parsing free-form description text.
      reason,
    }),
    { status: 401, headers }
  );
}
