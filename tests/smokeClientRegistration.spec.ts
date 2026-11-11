import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOAuthApi, type OAuthHelpers, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import {
  createSmokeRegistrationProvider,
  SMOKE_REGISTRATION_HEADER,
  SMOKE_REGISTRATION_TTL_SECONDS,
} from '../src/smokeClientRegistration';

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));

const ORIGIN = 'https://mcp.example.test';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const ORDINARY_METADATA = { client_name: 'OrgX MCP Smoke Test', redirect_uris: [REDIRECT] };
const METADATA = { ...ORDINARY_METADATA, grant_types: [], response_types: [] };
const NOW = 1_800_000_000;
type Env = { OAUTH_KV: KVNamespace; OAUTH_PROVIDER?: OAuthHelpers };

// Deliberately does NOT evict expired records. This models a stale KV cache,
// making the worker's authentication deadline independently observable.
function harness(overrides: Partial<OAuthProviderOptions<Env>> = {}) {
  const values = new Map<string, string>();
  const pending: Promise<unknown>[] = [];
  const get = vi.fn(async (key: string, options?: string | { type?: string }) => {
    const value = values.get(key) ?? null;
    const type = typeof options === 'string' ? options : options?.type;
    return value !== null && type === 'json' ? JSON.parse(value) : value;
  });
  const put = vi.fn(async (key: string, value: string, _options?: unknown) => { values.set(key, value); });
  const del = vi.fn(async (key: string) => { values.delete(key); });
  const list = vi.fn(async ({ prefix = '' } = {}) => ({
    keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
    list_complete: true, cacheStatus: null,
  }));
  const raw = {
    get, put, delete: del, list,
    getWithMetadata: vi.fn(async (key, options) => ({
      value: await get(key, options), metadata: null, cacheStatus: null,
    })),
  } as unknown as KVNamespace;
  const env: Env = { OAUTH_KV: raw };
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
  const options: OAuthProviderOptions<Env> = {
    apiRoute: '/mcp', apiHandler: { fetch: () => Response.json({ ok: true }) },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register',
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 24 * 3600,
    defaultHandler: { async fetch(request, scopedEnv) {
      const url = new URL(request.url);
      const helpers = scopedEnv.OAUTH_PROVIDER!;
      if (url.pathname === '/inspect') {
        const client = await helpers.lookupClient(url.searchParams.get('id')!);
        return Response.json({ exists: client !== null });
      }
      if (url.pathname === '/update') {
        await helpers.updateClient(url.searchParams.get('id')!, { clientName: 'Updated' });
        return Response.json({ ok: true });
      }
      if (url.pathname === '/rewrite') {
        await helpers.updateClient(url.searchParams.get('id')!, await request.json());
        return Response.json({ ok: true });
      }
      if (url.pathname === '/authorize') {
        try {
          const auth = await helpers.parseAuthRequest(request);
          const { redirectTo } = await helpers.completeAuthorization({
            request: auth, userId: 'fixture-user', metadata: {}, scope: [], props: { fixture: true },
            revokeExistingGrants: false,
          });
          return Response.redirect(redirectTo);
        } catch { return Response.json({ error: 'invalid_client' }, { status: 400 }); }
      }
      return new Response(null, { status: 404 });
    } },
    ...overrides,
  };
  const provider = createSmokeRegistrationProvider<Env>(options);
  const fetch = (path: string, init?: RequestInit) => provider.fetch(new Request(ORIGIN + path, init), env, ctx);
  const register = (smoke = true, metadata: unknown = smoke ? METADATA : ORDINARY_METADATA) => fetch('/register', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(smoke ? { [SMOKE_REGISTRATION_HEADER]: '1' } : {}) },
    body: JSON.stringify(metadata),
  });
  const inspect = async (id: string) => (await fetch(`/inspect?id=${id}`)).json() as Promise<{ exists: boolean }>;
  const tagged = (id: string) => {
    const key = `client:${id}`;
    const record = JSON.parse(values.get(key)!);
    record.orgxSmokeRegistration = { version: 1, expiresAt: record.registrationDate + SMOKE_REGISTRATION_TTL_SECONDS };
    values.set(key, JSON.stringify(record));
    return record;
  };
  const authorize = async (id: string) => {
    const verifier = 'a'.repeat(43);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
    const query = new URLSearchParams({ client_id: id, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', state: 'fixture-state' });
    const response = await fetch(`/authorize?${query}`);
    const location = response.headers.get('location');
    return { response, verifier, code: location ? new URL(location).searchParams.get('code')! : '' };
  };
  const exchange = (client: { client_id: string; client_secret: string }, code: string, verifier: string) => fetch('/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  const installRawHelper = () => {
    const helper = getOAuthApi(options, env);
    env.OAUTH_PROVIDER = helper;
    return helper;
  };
  return { values, pending, get, put, del, list, fetch, register, inspect, tagged, authorize, exchange, installRawHelper, env };
}

describe('bounded smoke registration using the real pinned OAuth provider', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network allowed in expiry tests'); }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('stores a five-minute deadline atomically, then deletes only the new client before success', async () => {
    const h = harness();
    const response = await h.register();
    expect(response.status).toBe(201);
    expect(response.headers.get('x-orgx-smoke-cleanup')).toBe('complete');
    const client = await response.json() as any;
    expect(client.client_secret_expires_at).toBe(NOW + 300);
    expect(client.grant_types).toEqual([]);
    expect(client.response_types).toEqual([]);
    expect(client.client_secret).toBeTruthy();
    const [key, stored, options] = h.put.mock.calls[0];
    const record = JSON.parse(stored);
    expect(record.orgxSmokeRegistration).toEqual({ version: 1, expiresAt: NOW + 300 });
    expect(record.clientSecret).not.toBe(client.client_secret);
    expect(options).toEqual({ expiration: NOW + 300 });
    expect(h.del.mock.calls).toEqual([[key]]);
    expect(h.values.size).toBe(0);
    expect(h.list).not.toHaveBeenCalled(); // no namespace-wide grant/customer scan
    expect(await h.inspect(client.client_id)).toEqual({ exists: false });
    expect((await h.authorize(client.client_id)).response.status).toBe(400);
  });

  it('preserves ordinary 90-day registration, including a same-named ordinary integration', async () => {
    const h = harness();
    const response = await h.register(false);
    const client = await response.json() as any;
    expect(response.status).toBe(201);
    expect(client.client_secret_expires_at).toBe(NOW + 90 * 24 * 3600);
    expect(h.put.mock.calls[0][2]).toEqual({ expirationTtl: 90 * 24 * 3600 });
    expect(JSON.parse(h.values.get(`client:${client.client_id}`)!)).not.toHaveProperty('orgxSmokeRegistration');
    expect(h.del).not.toHaveBeenCalled();
    const auth = await h.authorize(client.client_id);
    expect(auth.response.status).toBe(302);
    const token = await h.exchange(client, auth.code, auth.verifier);
    expect(token.status).toBe(200);
    const body = await token.json() as any;
    expect(body.expires_in).toBe(3600);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  it('preserves an explicitly configured ordinary registration lifetime', async () => {
    const h = harness({ clientRegistrationTTL: 86400 });
    const ordinary = await (await h.register(false)).json() as any;
    expect(ordinary.client_secret_expires_at).toBe(NOW + 86400);
    const smoke = await (await h.register()).json() as any;
    expect(smoke.client_secret_expires_at).toBe(NOW + 300);
    expect(await h.inspect(ordinary.client_id)).toEqual({ exists: true });
  });

  it.each([
    { ...METADATA, scope: 'admin' },
    { ...METADATA, client_name: 'Ordinary' },
    { ...METADATA, redirect_uris: ['https://elsewhere.example/callback'] },
    { ...METADATA, redirect_uris: [REDIRECT, 'https://elsewhere.example/callback'] },
    { ...METADATA, token_endpoint_auth_method: 'none' },
  ])('rejects opt-in metadata outside the exact canary contract (%j)', async metadata => {
    const h = harness();
    expect((await h.register(true, metadata)).status).toBe(400);
    expect(h.put).not.toHaveBeenCalled();
  });

  it('composes an existing registration denial and token callback without bypassing it', async () => {
    const callback = vi.fn(() => ({ code: 'access_denied' as const, status: 403 }));
    const h = harness({ clientRegistrationCallback: callback });
    expect((await h.register()).status).toBe(403);
    expect((await h.register(false)).status).toBe(403);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(h.put).not.toHaveBeenCalled();
  });

  it('rejects an unsupported opt-in version without creating a client', async () => {
    const h = harness();
    const result = await h.fetch('/register', { method: 'POST', headers: { [SMOKE_REGISTRATION_HEADER]: '2' }, body: JSON.stringify(METADATA) });
    expect(result.status).toBe(400);
    expect(h.put).not.toHaveBeenCalled();
  });

  it('does not expose a generated credential when cleanup fails', async () => {
    const h = harness();
    h.del.mockRejectedValue(new Error('synthetic cleanup failure'));
    const response = await h.register();
    expect(response.status).toBe(503);
    expect(response.headers.get('x-orgx-smoke-cleanup')).toBeNull();
    const body = await response.json();
    expect(body).toEqual({ error: 'temporarily_unavailable', error_description: 'Smoke registration cleanup did not complete' });
    expect(JSON.stringify(body)).not.toContain('client_secret');
    expect(h.values.size).toBe(1);
    vi.setSystemTime((NOW + 300) * 1000);
    const id = [...h.values.keys()][0].slice(7);
    expect(await h.inspect(id)).toEqual({ exists: false });
    await Promise.all(h.pending);
    expect(h.values.size).toBe(1); // failed cleanup cannot extend authentication
  });

  it('cleans up a write that committed before throwing', async () => {
    const h = harness();
    h.put.mockImplementationOnce(async (key, value) => {
      h.values.set(key, value);
      throw new Error('synthetic reply lost after commit');
    });
    await expect(h.register()).rejects.toThrow('synthetic reply lost after commit');
    expect(h.del).toHaveBeenCalledTimes(1);
    expect(h.values.size).toBe(0);
  });

  it('enforces expiry if the worker/CI is interrupted before cleanup', async () => {
    const h = harness();
    let committed!: () => void;
    const ready = new Promise<void>(resolve => { committed = resolve; });
    h.put.mockImplementationOnce(async (key, value) => {
      h.values.set(key, value); committed();
      await new Promise(() => {}); // worker never reaches response/cleanup
    });
    void h.register();
    await ready;
    const id = [...h.values.keys()][0].slice(7);
    expect(h.del).not.toHaveBeenCalled();
    vi.setSystemTime((NOW + 300) * 1000);
    expect(await h.inspect(id)).toEqual({ exists: false });
    await Promise.all(h.pending);
    expect(h.values.size).toBe(0);
    expect(await h.inspect(id)).toEqual({ exists: false }); // repeated cleanup safe
  });

  it('rejects smoke token grants even within the deadline when stale deletion data survives', async () => {
    const callback = vi.fn();
    const h = harness({ tokenExchangeCallback: callback });
    const client = await (await h.register(false)).json() as any;
    h.tagged(client.client_id);
    const auth = await h.authorize(client.client_id);
    expect(auth.response.status).toBe(302);
    const response = await h.exchange(client, auth.code, auth.verifier);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unauthorized_client' });
    expect(callback).not.toHaveBeenCalled();
    expect([...h.values.keys()].filter(key => key.startsWith('token:'))).toHaveLength(0);
  });

  it('rejects expired credentials at the exact deadline despite cached KV data', async () => {
    const h = harness();
    const client = await (await h.register(false)).json() as any;
    h.tagged(client.client_id);
    const auth = await h.authorize(client.client_id);
    h.del.mockResolvedValue(); // simulate a stale cache surviving successful delete
    vi.setSystemTime((NOW + 299) * 1000);
    expect(await h.inspect(client.client_id)).toEqual({ exists: true });
    vi.setSystemTime((NOW + 300) * 1000);
    const response = await h.exchange(client, auth.code, auth.verifier);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
    expect(await h.inspect(client.client_id)).toEqual({ exists: false });
    expect((await h.authorize(client.client_id)).response.status).toBe(400);
  });

  it.each([
    { version: 2, expiresAt: NOW + 300 },
    { version: 1, expiresAt: NOW + 3600 },
    { version: 1, expiresAt: 'later' }, null,
  ])('fails closed for malformed smoke markers (%j)', async marker => {
    const h = harness();
    const client = await (await h.register(false)).json() as any;
    const key = `client:${client.client_id}`;
    const value = JSON.parse(h.values.get(key)!);
    value.orgxSmokeRegistration = marker;
    h.values.set(key, JSON.stringify(value));
    expect(await h.inspect(client.client_id)).toEqual({ exists: false });
  });

  it('prevents ordinary provider updates from extending a smoke deadline', async () => {
    const h = harness();
    const client = await (await h.register(false)).json() as any;
    h.tagged(client.client_id);
    vi.setSystemTime((NOW + 100) * 1000);
    expect((await h.fetch(`/update?id=${client.client_id}`)).status).toBe(200);
    expect(h.put.mock.calls.at(-1)?.[2]).toEqual({ expiration: NOW + 300 });
    expect(JSON.parse(h.values.get(`client:${client.client_id}`)!).orgxSmokeRegistration.expiresAt).toBe(NOW + 300);
  });

  it.each([
    { orgxSmokeRegistration: undefined },
    { registrationDate: NOW + 100, orgxSmokeRegistration: { version: 1, expiresAt: NOW + 400 } },
  ])('rejects helper attempts to demote or extend a previously read canary (%j)', async updates => {
    const h = harness();
    const client = await (await h.register(false)).json() as any;
    const original = h.tagged(client.client_id);
    // null also represents invalid/removal metadata after a JSON transport.
    const data = { ...updates, ...(updates.orgxSmokeRegistration === undefined ? { orgxSmokeRegistration: null } : {}) };
    await expect(h.fetch(`/rewrite?id=${client.client_id}`, { method: 'POST', body: JSON.stringify(data) })).rejects.toThrow('Smoke client deadline cannot change');
    expect(JSON.parse(h.values.get(`client:${client.client_id}`)!)).toEqual(original);
  });

  it('rebinds preexisting raw helpers so expired lookup/update/authorization cannot bypass scoped KV', async () => {
    const h = harness();
    const client = await (await h.register(false)).json() as any;
    const original = h.tagged(client.client_id);
    const rawHelper = h.installRawHelper();
    vi.setSystemTime((NOW + 300) * 1000);
    h.del.mockResolvedValue(); // stale backing data remains
    expect(await rawHelper.lookupClient(client.client_id)).not.toBeNull();
    expect(await h.inspect(client.client_id)).toEqual({ exists: false });
    expect((await h.fetch(`/update?id=${client.client_id}`)).status).toBe(200);
    expect(JSON.parse(h.values.get(`client:${client.client_id}`)!)).toEqual(original);
    expect((await h.authorize(client.client_id)).response.status).toBe(400);
    expect(h.env.OAUTH_PROVIDER).toBe(rawHelper); // no mutation of caller env
  });

  it('requests no grant capabilities even if an older Worker ignores the opt-in header', async () => {
    const h = harness();
    const client = await (await h.register(false, METADATA)).json() as any;
    expect(client.grant_types).toEqual([]);
    expect(client.response_types).toEqual([]);
    expect((await h.authorize(client.client_id)).response.status).toBe(400);
  });

  it('keeps concurrent ordinary registrations isolated from smoke cleanup', async () => {
    const h = harness();
    const [smoke, ordinary] = await Promise.all([h.register(), h.register(false)]);
    const a = await smoke.json() as any;
    const b = await ordinary.json() as any;
    expect(await h.inspect(a.client_id)).toEqual({ exists: false });
    expect(await h.inspect(b.client_id)).toEqual({ exists: true });
    expect(h.del.mock.calls).toEqual([[`client:${a.client_id}`]]);
  });
});
