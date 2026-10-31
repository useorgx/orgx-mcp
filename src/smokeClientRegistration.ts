import { AsyncLocalStorage } from 'node:async_hooks';
import OAuthProvider, {
  OAuthError,
  type OAuthProviderOptions,
  type TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider';

export const SMOKE_REGISTRATION_HEADER = 'x-orgx-smoke-registration';
export const SMOKE_REGISTRATION_VERSION = '1';
export const SMOKE_REGISTRATION_TTL_SECONDS = 300;
const MARKER = 'orgxSmokeRegistration';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

type RecordValue = Record<string, unknown>;
type Scope = { smoke: boolean; clients: Map<string, number>; created: Set<string> };
const scopes = new AsyncLocalStorage<Scope>();
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function record(value: unknown): RecordValue | null {
  if (object(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : null; }
  catch { return null; }
}

function deadline(value: RecordValue): number | null | undefined {
  if (!Object.hasOwn(value, MARKER)) return undefined;
  const marker = value[MARKER];
  if (!object(marker) || marker.version !== 1 ||
      !Number.isSafeInteger(marker.expiresAt) || !Number.isSafeInteger(value.registrationDate) ||
      marker.expiresAt !== Number(value.registrationDate) + SMOKE_REGISTRATION_TTL_SECONDS) return null;
  return Number(marker.expiresAt);
}

function responseError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, {
    status, headers: { 'cache-control': 'no-store' },
  });
}

/** Reuses the provider's client records and TTL; no cleanup credential or API. */
function scopedKv(raw: KVNamespace, state: Scope, ctx: ExecutionContext): KVNamespace {
  function inspect(key: unknown, value: unknown): unknown {
    if (typeof key !== 'string' || !key.startsWith('client:')) return value;
    const client = record(value);
    if (!client) return value;
    const expires = deadline(client);
    if (expires === undefined) return value;
    if (expires === null || key !== `client:${client.clientId}`) return null;
    if (Math.floor(Date.now() / 1000) >= expires) {
      // KV cache/eviction timing cannot extend authentication beyond this date.
      ctx.waitUntil(raw.delete(key).catch(() => undefined));
      return null;
    }
    state.clients.set(String(client.clientId), expires);
    return value;
  }

  return new Proxy(raw, {
    get(target, property) {
      if (property === 'get') return async (...args: unknown[]) =>
        inspect(args[0], await Reflect.apply(target.get, target, args));
      if (property === 'getWithMetadata') return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.getWithMetadata, target, args);
        const value = inspect(args[0], result.value);
        return value === result.value ? result : { ...result, value, metadata: null };
      };
      if (property === 'put') return async (...args: unknown[]) => {
        const [key, body, options] = args;
        if (typeof key !== 'string' || !key.startsWith('client:'))
          return Reflect.apply(target.put, target, args);
        const client = record(body);
        if (!client || typeof body !== 'string') {
          if (state.smoke) throw new Error('Invalid smoke client storage');
          return Reflect.apply(target.put, target, args);
        }
        if (state.smoke) {
          if (typeof client.clientId !== 'string' || key !== `client:${client.clientId}` ||
              !Number.isSafeInteger(client.registrationDate)) throw new Error('Invalid smoke client identity');
          client[MARKER] = { version: 1,
            expiresAt: Number(client.registrationDate) + SMOKE_REGISTRATION_TTL_SECONDS };
          // Capture before the write: a failed reply may still mean it committed.
          state.created.add(key);
        }
        const expires = deadline(client);
        const prior = state.clients.get(String(client.clientId));
        if (prior !== undefined && expires !== prior) throw new Error('Smoke client deadline cannot change');
        if (expires === undefined) return Reflect.apply(target.put, target, args);
        if (expires === null || key !== `client:${client.clientId}` ||
            expires - Math.floor(Date.now() / 1000) < 60) throw new Error('Invalid or expired smoke client deadline');
        const nextOptions = object(options) ? { ...options } : {};
        delete nextOptions.expirationTtl;
        nextOptions.expiration = expires;
        // Provider updates may use its normal 90-day TTL. Never extend this one.
        return Reflect.apply(target.put, target, [key, JSON.stringify(client), nextOptions]);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function cleanup(kv: KVNamespace, keys: Set<string>): Promise<boolean> {
  let complete = true;
  for (const key of keys) {
    try { await kv.delete(key); }
    catch { complete = false; }
  }
  return complete;
}

export function createSmokeRegistrationProvider<Env extends { OAUTH_KV: KVNamespace }>(
  options: OAuthProviderOptions<Env>
) {
  const exchange = async (input: TokenExchangeCallbackOptions) => {
    // This canary checks registration only, using the CI's existing bearer for
    // other probes. Its fresh client must never mint user access/refresh tokens.
    if (scopes.getStore()?.clients.has(input.clientId)) throw new OAuthError('unauthorized_client', {
      description: 'Smoke registrations cannot authorize token grants',
    });
    return options.tokenExchangeCallback?.(input);
  };
  const ordinary = new OAuthProvider<Env>({ ...options, tokenExchangeCallback: exchange });
  const smoke = new OAuthProvider<Env>({
    ...options, tokenExchangeCallback: exchange,
    clientRegistrationTTL: SMOKE_REGISTRATION_TTL_SECONDS,
    async clientRegistrationCallback(input) {
      const prior = await options.clientRegistrationCallback?.(input);
      if (prior !== undefined) return prior;
      const data = input.clientMetadata;
      if (Object.keys(data).sort().join(',') !== 'client_name,grant_types,redirect_uris,response_types' ||
          data.client_name !== 'OrgX MCP Smoke Test' || !Array.isArray(data.redirect_uris) ||
          data.redirect_uris.length !== 1 || data.redirect_uris[0] !== REDIRECT ||
          !Array.isArray(data.grant_types) || data.grant_types.length !== 0 ||
          !Array.isArray(data.response_types) || data.response_types.length !== 0)
        return { description: 'Invalid smoke registration metadata' };
    },
  });

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const registration = request.method === 'POST' && new URL(request.url).pathname === '/register';
      const header = request.headers.get(SMOKE_REGISTRATION_HEADER);
      if (registration && header !== null && header !== SMOKE_REGISTRATION_VERSION)
        return responseError(400, 'invalid_request', 'Unsupported smoke registration version');
      const state: Scope = { smoke: registration && header === SMOKE_REGISTRATION_VERSION,
        clients: new Map(), created: new Set() };
      // Existing helpers capture their original KV/provider. Never reuse one
      // across request scopes, or its lookup/update path could bypass expiry.
      const scopedEnv = { ...env, OAUTH_KV: scopedKv(env.OAUTH_KV, state, ctx), OAUTH_PROVIDER: undefined };
      let response: Response;
      try {
        response = await scopes.run(state, () =>
          (state.smoke ? smoke : ordinary).fetch(request, scopedEnv, ctx));
      } catch (error) {
        await cleanup(env.OAUTH_KV, state.created);
        throw error;
      }
      const complete = await cleanup(env.OAUTH_KV, state.created);
      if (state.smoke && response.status === 201) {
        if (!complete || state.created.size !== 1) {
          await response.body?.cancel();
          // Never release a generated secret when its cleanup was uncertain.
          return responseError(503, 'temporarily_unavailable', 'Smoke registration cleanup did not complete');
        }
        const headers = new Headers(response.headers);
        headers.set('x-orgx-smoke-cleanup', 'complete');
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    },
  };
}
