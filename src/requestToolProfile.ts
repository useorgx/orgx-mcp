import { resolveToolProfile } from './toolProfiles';

type RequestContextWithProps = {
  props?: Record<string, unknown>;
};

export type RequestHandler<Environment, Context> = {
  fetch(
    request: Request,
    env: Environment,
    ctx: Context
  ): Promise<Response>;
};

/**
 * Resolve the URL-selected discovery profile at the API-handler boundary.
 *
 * OAuthProvider replaces `ctx.props` with the decrypted access-token props
 * before dispatching to `/mcp` or `/sse`, so this must run inside the handler
 * supplied to OAuthProvider rather than in the outer Worker fetch method.
 * Missing and unknown profiles fail closed to the public v2 surface.
 */
export function attachRequestToolProfile(
  request: Request,
  ctx: unknown
): void {
  const requestedProfile = new URL(request.url).searchParams.get('profile');
  const profile = resolveToolProfile(requestedProfile).name;
  const context = ctx as RequestContextWithProps;
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
