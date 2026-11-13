import { describe, expect, it, vi } from 'vitest';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { MultiResourceOAuthProvider, legacyResourcesFor } from '../src/oauthMultiResource';

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));

const ORIGIN = 'https://mcp.example.test';
const REDIRECT = 'https://client.example.test/callback';
type Env = { OAUTH_KV: KVNamespace; OAUTH_PROVIDER?: OAuthHelpers };

function harness() {
  const values = new Map<string, string>();
  const kv = {
    get: async (key: string, options?: string | { type?: string }) => {
      const value = values.get(key) ?? null;
      const type = typeof options === 'string' ? options : options?.type;
      return value !== null && type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true, cacheStatus: null,
    }),
  } as unknown as KVNamespace;
  const seen: Array<{ route: string; props: unknown; audience: unknown }> = [];
  const api = (route: string) => ({
    fetch(_request: Request, _env: Env, ctx: ExecutionContext) {
      const scoped = ctx as ExecutionContext & { props?: unknown; auth?: { audience: string } };
      seen.push({ route, props: scoped.props, audience: scoped.auth?.audience });
      return Response.json({ route });
    },
  });
  const provider = new MultiResourceOAuthProvider<Env>({
    apiHandlers: { '/mcp': api('/mcp'), '/sse': api('/sse') },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register',
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 24 * 3600,
    defaultHandler: { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== '/authorize') return Response.json({ helpers: Boolean(env.OAUTH_PROVIDER) });
      const auth = await env.OAUTH_PROVIDER!.parseAuthRequest(request);
      const { redirectTo } = await env.OAUTH_PROVIDER!.completeAuthorization({
        request: auth, userId: 'user-1', metadata: {}, scope: [], props: { user: 'user-1' },
      });
      return Response.redirect(redirectTo);
    } },
  });
  const ctx = () => ({ waitUntil: () => undefined }) as unknown as ExecutionContext;
  const fetch = (path: string, init?: RequestInit) =>
    provider.fetch(new Request(ORIGIN + path, init), { OAUTH_KV: kv }, ctx());

  async function signIn(resource?: string) {
    const client = await (await fetch('/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Fixture', redirect_uris: [REDIRECT] }),
    })).json() as { client_id: string; client_secret: string };
    const verifier = 'v'.repeat(43);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', state: 's', ...(resource ? { resource } : {}) });
    const authorized = await fetch(`/authorize?${query}`);
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const token = await fetch('/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    });
    expect(token.status).toBe(200);
    return { client, ...(await token.json() as { access_token: string; refresh_token: string }) };
  }
  const call = (path: string, token?: string) => fetch(path, {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { values, seen, fetch, signIn, call };
}

describe('one OAuth server for every resource a 0.x grant can carry', () => {
  it('declares the routes first, then the bare origin', () => {
    expect(legacyResourcesFor(ORIGIN, ['/mcp', '/sse'])).toEqual([`${ORIGIN}/mcp`, `${ORIGIN}/sse`, ORIGIN]);
  });

  it.each([`${ORIGIN}/mcp`, `${ORIGIN}/sse`, ORIGIN, `${ORIGIN}/`, undefined])(
    'a token issued for %s works on both /mcp and /sse', async (resource) => {
      const h = harness();
      const { access_token } = await h.signIn(resource);
      for (const path of ['/mcp', '/sse', '/sse/message']) {
        const response = await h.call(path, access_token);
        expect(response.status, path).toBe(200);
      }
      expect(h.seen.map((entry) => entry.props)).toEqual(Array(3).fill({ user: 'user-1' }));
      const expected = resource === undefined ? `${ORIGIN}/mcp` : resource === `${ORIGIN}/` ? ORIGIN : resource;
      expect(new Set(h.seen.map((entry) => entry.audience))).toEqual(new Set([expected]));
    });

  const unbind = (values: Map<string, string>) => {
    let stripped = 0;
    for (const [key, raw] of values) {
      if (!key.startsWith('token:') && !key.startsWith('grant:')) continue;
      const record = JSON.parse(raw);
      for (const target of [record, record.grant].filter(Boolean)) {
        for (const field of ['audience', 'resource']) if (field in target) { delete target[field]; stripped += 1; }
      }
      values.set(key, JSON.stringify(record));
    }
    expect(stripped).toBeGreaterThan(0);
  };
  const refresh = (h: ReturnType<typeof harness>, client: { client_id: string; client_secret: string },
    refresh_token: string, resource?: string) => h.fetch('/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, ...(resource ? { resource } : {}) }),
  });

  it.each([undefined, `${ORIGIN}/mcp`, `${ORIGIN}/sse`, ORIGIN, `${ORIGIN}/`])(
    'keeps a pre-1.0 grant with no stored resource working when refresh names %s', async (resource) => {
      const h = harness();
      const { client, access_token, refresh_token } = await h.signIn(ORIGIN);
      unbind(h.values);
      expect((await h.call('/mcp', access_token)).status).toBe(200);
      expect((await h.call('/sse', access_token)).status).toBe(200);
      const refreshed = await refresh(h, client, refresh_token, resource);
      expect(refreshed.status).toBe(200);
      const next = await refreshed.json() as { access_token: string };
      expect((await h.call('/sse', next.access_token)).status).toBe(200);
      expect((await h.call('/mcp', next.access_token)).status).toBe(200);
    });

  it('refreshes a bare-origin grant without signing the client out', async () => {
    const h = harness();
    const { client, refresh_token } = await h.signIn(ORIGIN);
    const refreshed = await refresh(h, client, refresh_token, ORIGIN);
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as { access_token: string };
    expect((await h.call('/mcp', next.access_token)).status).toBe(200);
  });

  it('challenges a missing or unknown token with the discovery document 0.x advertised', async () => {
    const h = harness();
    const missing = await h.call('/mcp');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(
      `Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const below = await h.call('/sse/message');
    expect(below.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    const invalid = await h.call('/sse', 'user-1:grant:secret');
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(await invalid.json()).toMatchObject({ error: 'invalid_token' });
    expect(h.seen).toHaveLength(0);
  });

  it('answers CORS preflight on protected routes and passes helpers to other routes', async () => {
    const h = harness();
    const preflight = await h.fetch('/mcp', { method: 'OPTIONS', headers: { Origin: 'https://app.example.test' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(await (await h.fetch('/elsewhere')).json()).toEqual({ helpers: true });
  });

  it('rejects a resource this server does not host', async () => {
    const h = harness();
    await expect(h.signIn('https://other.example.test/mcp')).rejects.toThrow();
  });
});
