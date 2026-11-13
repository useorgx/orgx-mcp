/**
 * One OAuth authorization server for several MCP resources on one origin.
 *
 * `@cloudflare/workers-oauth-provider` 1.x binds every grant and access token
 * to exactly one resource and compares it exactly. On 0.x this Worker never
 * configured a resource, so existing grants carry whichever value a client
 * discovered: `<origin>/mcp`, `<origin>/sse`, or the bare origin (clients that
 * read the root metadata, including `/sse/message` challenges). A single
 * `OAuthProvider` resource matches only one of those and would sign the other
 * clients out at deploy, so every value is declared here and a protected route
 * accepts a token issued for any of them. They are all this one server.
 *
 * Routing mirrors what `OAuthProvider` did for us on 0.x:
 * - protected routes (`/mcp`, `/sse` and below) need a valid bearer token;
 * - token, revocation, registration and authorization-server metadata go to
 *   the library;
 * - everything else goes to the default handler with `env.OAUTH_PROVIDER`.
 */
import {
  OAuthAuthorizationServer,
  type OAuthAuthorizationServerOptions,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';

type FetchHandler<Env> = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

export type MultiResourceEnv = { OAUTH_KV: KVNamespace; OAUTH_PROVIDER?: OAuthHelpers };

export type MultiResourceProviderOptions<Env> = Omit<
  OAuthAuthorizationServerOptions<Env>,
  'issuer' | 'resources' | 'defaultResource' | 'legacyGrantResource'
> & {
  /** Protected path → handler. The first entry is the default resource. */
  apiHandlers: Record<string, FetchHandler<Env>>;
  defaultHandler: FetchHandler<Env>;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientRegistrationEndpoint: string;
};

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
const MAX_SERVERS = 16;

/** Every resource value a 0.x grant on this origin can carry, default first. */
export function legacyResourcesFor(origin: string, routes: readonly string[]): string[] {
  return [...routes.map((route) => `${origin}${route}`), origin];
}

function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  const cors = new Response(response.body, response);
  const set = (name: string, value: string) => { if (!cors.headers.has(name)) cors.headers.set(name, value); };
  set('Access-Control-Allow-Origin', origin);
  set('Access-Control-Allow-Methods', '*');
  set('Access-Control-Allow-Headers', 'Authorization, *');
  set('Access-Control-Max-Age', '86400');
  for (const [name, value] of [['Vary', 'Origin'], ['Access-Control-Expose-Headers', 'WWW-Authenticate'],
    ['Access-Control-Expose-Headers', 'Retry-After']] as const) {
    const values = (cors.headers.get(name) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
    cors.headers.set(name, values.join(', '));
  }
  return cors;
}

export class MultiResourceOAuthProvider<Env extends MultiResourceEnv> {
  readonly #options: MultiResourceProviderOptions<Env>;
  readonly #routes: string[];
  readonly #servers = new Map<string, OAuthAuthorizationServer<Env>>();

  constructor(options: MultiResourceProviderOptions<Env>) {
    this.#routes = Object.keys(options.apiHandlers);
    if (this.#routes.length === 0 || this.#routes.some((route) => !/^\/[^/?#]+$/.test(route)))
      throw new Error('apiHandlers needs one or more single-segment paths such as /mcp');
    this.#options = options;
  }

  /**
   * One authorization server per origin, built the way 0.x derived its issuer.
   * `legacy` picks the resource an unbound pre-1.0 grant is treated as bound
   * to; it only differs from the primary route on a refresh that names
   * another declared resource (see {@link #legacyFor}).
   */
  server(origin: string, legacy?: string): OAuthAuthorizationServer<Env> {
    const resources = legacyResourcesFor(origin, this.#routes);
    const legacyGrantResource = legacy && resources.includes(legacy) ? legacy : resources[0]!;
    const key = `${origin} ${legacyGrantResource}`;
    const existing = this.#servers.get(key);
    if (existing) return existing;
    const { apiHandlers: _api, defaultHandler: _default, ...common } = this.#options;
    const server = new OAuthAuthorizationServer<Env>({
      ...common,
      issuer: origin,
      resources,
      // New sign-ins that omit `resource` go to the primary route.
      defaultResource: resources[0],
      legacyGrantResource,
    });
    if (this.#servers.size >= MAX_SERVERS) this.#servers.delete(this.#servers.keys().next().value!);
    this.#servers.set(key, server);
    return server;
  }

  /**
   * A grant made before 1.0 stored no resource. If its client now names one of
   * our resources on refresh, bind the grant to that one instead of refusing
   * the refresh with invalid_target and signing the client out.
   */
  async #legacyFor(request: Request, origin: string): Promise<string | undefined> {
    if (request.method !== 'POST') return undefined;
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded'))
      return undefined;
    try {
      const body = new URLSearchParams(await request.clone().text());
      if (body.get('grant_type') !== 'refresh_token') return undefined;
      const requested = body.getAll('resource');
      if (requested.length !== 1) return undefined;
      const wanted = requested[0] === `${origin}/` ? origin : requested[0];
      return legacyResourcesFor(origin, this.#routes).find((resource) => resource === wanted);
    } catch {
      return undefined;
    }
  }

  helpers(env: Env, origin: string): OAuthHelpers {
    return this.server(origin).getOAuthApi(env);
  }

  #route(pathname: string): string | undefined {
    return this.#routes.find((route) => pathname === route || pathname.startsWith(`${route}/`));
  }

  #isAuthorizationServerPath(pathname: string): boolean {
    return pathname === this.#options.tokenEndpoint ||
      pathname === this.#options.clientRegistrationEndpoint ||
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname.startsWith('/.well-known/oauth-authorization-server/');
  }

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const server = this.server(url.origin);
    const route = this.#route(url.pathname);
    if (route) {
      if (request.method === 'OPTIONS')
        return withCors(new Response(null, { status: 204, headers: { 'Content-Length': '0' } }), request);
      if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = server.getOAuthApi(env);
      return withCors(await this.#protected(request, env, ctx, server, url, route), request);
    }
    if (url.pathname === this.#options.tokenEndpoint)
      return this.server(url.origin, await this.#legacyFor(request, url.origin)).fetch(request, env, ctx);
    if (this.#isAuthorizationServerPath(url.pathname)) return server.fetch(request, env, ctx);
    if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = server.getOAuthApi(env);
    return this.#options.defaultHandler.fetch(request, env, ctx);
  }

  async #protected(
    request: Request, env: Env, ctx: ExecutionContext,
    server: OAuthAuthorizationServer<Env>, url: URL, route: string
  ): Promise<Response> {
    // Same discovery document 0.x pointed at: path-scoped for the route
    // itself, origin-level below it.
    const metadata = url.pathname === route
      ? `${url.origin}/.well-known/oauth-protected-resource${route}`
      : `${url.origin}/.well-known/oauth-protected-resource`;
    const challenge = (error?: string) =>
      `Bearer realm="OAuth"${error ? `, error="${error}"` : ''}, resource_metadata="${metadata}"`;
    const match = /^Bearer[\t ]+([^\s,]+)$/i.exec(request.headers.get('Authorization') ?? '');
    if (!match) return new Response(null, { status: 401, headers: { ...NO_STORE, 'WWW-Authenticate': challenge() } });

    const token = match[1]!;
    const resources = legacyResourcesFor(url.origin, this.#routes);
    const own = `${url.origin}${route}`;
    for (const resource of [own, ...resources.filter((value) => value !== own)]) {
      const validated = await server.validateToken(resource, token, env);
      if (!validated) continue;
      const scoped = ctx as ExecutionContext & { props?: unknown; auth?: unknown };
      scoped.props = validated.props;
      scoped.auth = {
        token, audience: validated.audience, expiresAt: validated.expiresAt,
        scope: validated.scope, userId: validated.userId, clientId: validated.clientId,
      };
      return this.#options.apiHandlers[route]!.fetch(request, env, ctx);
    }
    return Response.json(
      { error: 'invalid_token', error_description: 'Invalid access token' },
      { status: 401, headers: { ...NO_STORE, 'WWW-Authenticate': challenge('invalid_token') } }
    );
  }
}
