import {
  READ_ONLY_FALLBACK_PROFILE,
  resolveToolProfile,
} from './toolProfiles';

type RequestContextWithProps = {
  props?: Record<string, unknown>;
};

export const ORGX_TOOL_PROFILE_HEADER = 'x-orgx-tool-profile';

export type RequestHandler<Environment, Context> = {
  fetch(
    request: Request,
    env: Environment,
    ctx: Context
  ): Promise<Response>;
};

/**
 * Resolve the request-selected discovery profile at the API-handler boundary.
 *
 * OAuthProvider replaces `ctx.props` with the decrypted access-token props
 * before dispatching to `/mcp` or `/sse`, so this must run inside the handler
 * supplied to OAuthProvider rather than in the outer Worker fetch method.
 * Missing profiles default to v2; unknown profiles fail closed to the
 * read-only fallback surface.
 */
export function attachRequestToolProfile(
  request: Request,
  ctx: unknown
): void {
  const requestedProfile =
    new URL(request.url).searchParams.get('profile') ??
    request.headers.get(ORGX_TOOL_PROFILE_HEADER);
  const context = ctx as RequestContextWithProps;
  const resolved = resolveToolProfile(requestedProfile);
  const provablyInternal = context.props?.authSource === 'run_token';
  const profile =
    resolved.name === 'full' && !provablyInternal
      ? READ_ONLY_FALLBACK_PROFILE
      : resolved.name;
  if (resolved.name === 'full' && !provablyInternal) {
    console.warn(
      '[mcp:profiles] External full profile request; failing closed to read-only surface'
    );
  }
  context.props = { ...(context.props ?? {}), profile };
}

/**
 * Wrap an MCP transport handler so profile negotiation happens after OAuth
 * token props have been injected and before the Durable Object registers its
 * tools for this connection.
 */
export function withRequestToolProfile<Environment, Context>(
  handler: RequestHandler<Environment, Context>
): RequestHandler<Environment, Context> {
  return {
    async fetch(request, env, ctx) {
      attachRequestToolProfile(request, ctx);
      return handler.fetch(request, env, ctx);
    },
  };
}
