import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOrgxApiRaw } from '../src/orgxApi';

function decodeActorToken(token: string) {
  const [payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    type: string;
    aud: string;
    iss: string;
    sub: string;
    email?: string;
    exp: number;
  };
}

describe('callOrgxApiRaw actor token propagation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
