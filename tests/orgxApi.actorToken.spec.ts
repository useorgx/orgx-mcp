import { afterEach, describe, expect, it, vi } from 'vitest';

import { _clearOrgxApiCachesForTests, callOrgxApiRaw } from '../src/orgxApi';

function decodeActorToken(token: string) {
  const [payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    type: string;
    aud: string;
    iss: string;
    sub: string;
    email?: string;
    orgx_user_id?: string;
    exp: number;
  };
}

const UUID = '5c52c8ca-c1d0-48cc-a177-9cf1ac2c5b06';

describe('callOrgxApiRaw actor token propagation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _clearOrgxApiCachesForTests();
  });

  it('sends a signed short-lived actor assertion with service requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await callOrgxApiRaw(
      {
        ORGX_API_URL: 'https://api.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
        ORGX_INTERNAL_SECRET: 'test-internal-secret',
      },
      '/api/flywheel/briefs',
      undefined,
      { userId: 'user_123', userEmail: 'Hope@Example.com' }
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    const actorToken = headers.get('x-orgx-actor-token');
    expect(actorToken).toBeTruthy();

    const payload = decodeActorToken(actorToken!);
    expect(payload).toMatchObject({
      type: 'orgx.mcp.actor.v1',
      aud: 'orgx-api',
      iss: 'orgx-mcp',
      sub: 'user_123',
      email: 'hope@example.com',
    });
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  it('carries the login-resolved orgx_user_id in the actor token and X-Orgx-Orgx-User-Id header, without changing X-Orgx-User-Id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await callOrgxApiRaw(
      {
        ORGX_API_URL: 'https://api.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
        ORGX_INTERNAL_SECRET: 'test-internal-secret',
      },
      '/api/entities',
      { method: 'POST', body: '{}' },
      { userId: 'user_123', userEmail: 'hope@example.com', orgxUserId: UUID }
    );

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    // X-Orgx-User-Id stays the Clerk id — the UUID is additive.
    expect(headers.get('x-orgx-user-id')).toBe('user_123');
    expect(headers.get('x-orgx-orgx-user-id')).toBe(UUID);

    const payload = decodeActorToken(headers.get('x-orgx-actor-token')!);
    expect(payload.sub).toBe('user_123');
    expect(payload.orgx_user_id).toBe(UUID);
  });

  it('omits the orgx_user_id claim and header when no UUID is present (pre-migration session)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await callOrgxApiRaw(
      {
        ORGX_API_URL: 'https://api.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
        ORGX_INTERNAL_SECRET: 'test-internal-secret',
      },
      '/api/entities',
      undefined,
      { userId: 'user_123', userEmail: 'hope@example.com' }
    );

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-orgx-orgx-user-id')).toBeNull();
    const payload = decodeActorToken(headers.get('x-orgx-actor-token')!);
    expect(payload.orgx_user_id).toBeUndefined();
  });

  it('keys the actor-token cache on orgx_user_id so a session that gains a UUID does not reuse the pre-UUID token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-06-20T12:00:00.000Z'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      ORGX_API_URL: 'https://api.useorgx.test',
      ORGX_SERVICE_KEY: 'oxk-test',
      ORGX_INTERNAL_SECRET: 'test-internal-secret',
    };

    await callOrgxApiRaw(env, '/api/one', undefined, {
      userId: 'user_123',
      userEmail: 'hope@example.com',
    });
    await callOrgxApiRaw(env, '/api/two', undefined, {
      userId: 'user_123',
      userEmail: 'hope@example.com',
      orgxUserId: UUID,
    });

    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
      'x-orgx-actor-token'
    );
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(
      'x-orgx-actor-token'
    );
    expect(first).not.toBe(second);
    expect(decodeActorToken(second!).orgx_user_id).toBe(UUID);
  });

  it('reuses actor assertions inside the safe token cache window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-06-20T12:00:00.000Z'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      ORGX_API_URL: 'https://api.useorgx.test',
      ORGX_SERVICE_KEY: 'oxk-test',
      ORGX_INTERNAL_SECRET: 'test-internal-secret',
    };

    await callOrgxApiRaw(env, '/api/one', undefined, {
      userId: 'user_123',
      userEmail: 'Hope@Example.com',
    });
    await callOrgxApiRaw(env, '/api/two', undefined, {
      userId: 'user_123',
      userEmail: 'hope@example.com',
    });

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('x-orgx-actor-token')).toBeTruthy();
    expect(secondHeaders.get('x-orgx-actor-token')).toBe(
      firstHeaders.get('x-orgx-actor-token')
    );
  });

  it('retries through ORGX_API_FALLBACK_URL when the primary upstream is unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const response = await callOrgxApiRaw(
      {
        ORGX_API_URL: 'https://primary.useorgx.test',
        ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
      },
      '/api/health'
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://primary.useorgx.test/api/health'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://fallback.useorgx.test/api/health'
    );
  });

  it('retries through ORGX_API_FALLBACK_URL for Cloudflare origin failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('origin timeout', { status: 522 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const response = await callOrgxApiRaw(
      {
        ORGX_API_URL: 'https://primary.useorgx.test',
        ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
      },
      '/api/health'
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://fallback.useorgx.test/api/health'
    );
  });

  it('fails closed without calling the fallback when fallback is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'primary unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callOrgxApiRaw(
        {
          ORGX_API_URL: 'https://primary.useorgx.test',
          ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
          ORGX_SERVICE_KEY: 'oxk-test',
        },
        '/api/internal/lifecycle',
        { method: 'POST', body: '{}' },
        { allowFallback: false }
      )
    ).rejects.toMatchObject({
      name: 'OrgXApiError',
      statusCode: 503,
      message: 'primary unavailable',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://primary.useorgx.test/api/internal/lifecycle'
    );
  });

  it('uses the primary fallback timeout before trying ORGX_API_FALLBACK_URL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith('https://primary.useorgx.test')) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            );
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
    );
    vi.stubGlobal('fetch', fetchMock);

    const responsePromise = callOrgxApiRaw(
      {
        ORGX_API_URL: 'https://primary.useorgx.test',
        ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
        ORGX_API_PRIMARY_TIMEOUT_MS: '10',
      },
      '/api/health'
    );

    await vi.advanceTimersByTimeAsync(9);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://fallback.useorgx.test/api/health'
    );
  });
});
