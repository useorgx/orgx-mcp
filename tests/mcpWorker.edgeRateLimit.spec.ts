import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetEdgeRateLimitStateForTests,
  checkEdgeRateLimit,
} from '../src/edgeRateLimit';
import { buildRateLimitExceededPayload } from '../src/rateLimitResponse';

describe('edge rate limiting', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetEdgeRateLimitStateForTests();
  });

  it('returns rate-limit headers for allowed free-tier requests', async () => {
    const decision = await checkEdgeRateLimit(
      new Request('https://example.com/mcp', {
        headers: {
          'cf-connecting-ip': '198.51.100.10',
        },
      }),
      {
        ORGX_API_URL: 'https://example.com',
        ORGX_SERVICE_KEY: 'oxk-test',
      }
    );

    expect(decision.allowed).toBe(true);
    expect(decision.headers).toMatchObject({
      'X-RateLimit-Tier': 'free',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Source': 'memory',
      'X-OrgX-RateLimit-Strategy': 'base_allowance',
    });
    expect(decision.headers['Server-Timing']).toContain('edge_rate_limit;dur=');
    expect(decision.timing).toMatchObject({
      identityMs: 0,
      billingMs: 0,
      strategy: 'base_allowance',
    });
    expect(Number(decision.headers['X-RateLimit-Remaining'])).toBeLessThan(100);
    expect(Number(decision.headers['X-RateLimit-Reset'])).toBeGreaterThan(0);
  });

  it('returns a retry window after the free-tier limit is exceeded', async () => {
    const env = {
      ORGX_API_URL: 'https://example.com',
      ORGX_SERVICE_KEY: 'oxk-test',
    };

    let decision = await checkEdgeRateLimit(
      new Request('https://example.com/mcp', {
        headers: {
          'cf-connecting-ip': '198.51.100.11',
        },
      }),
      env
    );

    for (let i = 0; i < 100; i += 1) {
      decision = await checkEdgeRateLimit(
        new Request('https://example.com/mcp', {
          headers: {
            'cf-connecting-ip': '198.51.100.11',
          },
        }),
        env
      );
    }

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not charge rejected memory fallback requests or extend the reset window', async () => {
    const baseMs = Date.parse('2026-04-12T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseMs);

    const env = {
      ORGX_API_URL: 'https://example.com',
      ORGX_SERVICE_KEY: 'oxk-test',
    };
    const request = () =>
      new Request('https://example.com/mcp', {
        headers: {
          'cf-connecting-ip': '198.51.100.12',
        },
      });

    for (let i = 0; i < 100; i += 1) {
      const allowed = await checkEdgeRateLimit(request(), env);
      expect(allowed.allowed).toBe(true);
    }

    vi.setSystemTime(baseMs + 30 * 60 * 1000);
    const rejected = await checkEdgeRateLimit(request(), env);

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBe(30 * 60);
    expect(rejected.headers['X-RateLimit-Reset']).toBe(
      String(Math.floor((baseMs + 60 * 60 * 1000) / 1000))
    );
  });

  it('does not write over-limit Upstash requests into the rate bucket', async () => {
    const baseMs = Date.parse('2026-04-12T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseMs);

    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body));
      expect(commands.some((command: string[]) => command[0] === 'ZADD')).toBe(
        false
      );
      return Response.json([
        { result: 0 },
        { result: 100 },
        { result: [`${baseMs}-first`, String(baseMs)] },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const decision = await checkEdgeRateLimit(
      new Request('https://example.com/mcp', {
        headers: {
          'cf-connecting-ip': '198.51.100.13',
        },
      }),
      {
        ORGX_API_URL: 'https://example.com',
        ORGX_SERVICE_KEY: 'oxk-test',
        UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
        UPSTASH_REDIS_REST_TOKEN: 'redis-test',
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('upstash');
    expect(decision.retryAfterSeconds).toBe(60 * 60);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips OAuth and billing I/O while requests remain inside the base allowance', async () => {
    const unwrapToken = vi.fn(async () => ({
      grant: { props: { userId: 'user-cache' } },
    }));
    const fetchMock = vi.fn(async () => Response.json({ plan: 'pro' }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      ORGX_API_URL: 'https://example.com',
      ORGX_SERVICE_KEY: 'oxk-test',
      OAUTH_PROVIDER: { unwrapToken } as any,
    };
    const request = () =>
      new Request('https://example.com/mcp', {
        headers: {
          authorization: 'Bearer cached-token',
        },
      });

    const first = await checkEdgeRateLimit(request(), env);
    const second = await checkEdgeRateLimit(request(), env);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(first.timing?.strategy).toBe('base_allowance');
    expect(second.timing?.strategy).toBe('base_allowance');
    expect(unwrapToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent OAuth unwraps and billing lookups after the base allowance', async () => {
    let resolveToken!: (value: {
      grant: { props: { userId: string } };
    }) => void;
    const tokenGate = new Promise<{ grant: { props: { userId: string } } }>(
      (resolve) => {
        resolveToken = resolve;
      }
    );
    const unwrapToken = vi.fn(() => tokenGate);
    const fetchMock = vi.fn(async () => Response.json({ plan: 'pro' }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      ORGX_API_URL: 'https://example.com',
      ORGX_SERVICE_KEY: 'oxk-test',
      OAUTH_PROVIDER: { unwrapToken } as any,
    };
    const request = () =>
      new Request('https://example.com/mcp', {
        headers: {
          authorization: 'Bearer concurrent-token',
        },
      });

    for (let i = 0; i < 100; i += 1) {
      const base = await checkEdgeRateLimit(request(), env);
      expect(base.allowed).toBe(true);
    }

    const first = checkEdgeRateLimit(request(), env);
    const second = checkEdgeRateLimit(request(), env);

    await vi.waitFor(() => {
      expect(unwrapToken).toHaveBeenCalledTimes(1);
    });

    resolveToken({ grant: { props: { userId: 'user-concurrent' } } });
    const results = await Promise.all([first, second]);

    expect(results.every((decision) => decision.allowed)).toBe(true);
    expect(
      results.every(
        (decision) => decision.timing?.strategy === 'paid_allowance'
      )
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to memory when the Upstash pipeline exceeds the edge timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const decisionPromise = checkEdgeRateLimit(
      new Request('https://example.com/mcp', {
        headers: {
          'cf-connecting-ip': '198.51.100.14',
        },
      }),
      {
        ORGX_API_URL: 'https://example.com',
        ORGX_SERVICE_KEY: 'oxk-test',
        UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
        UPSTASH_REDIS_REST_TOKEN: 'redis-test',
      }
    );

    await vi.advanceTimersByTimeAsync(750);
    const decision = await decisionPromise;

    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('memory');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds an upgrade CTA to the 429 payload', () => {
    const payload = buildRateLimitExceededPayload(
      {
        allowed: false,
        tier: 'free',
        source: 'memory',
        retryAfterSeconds: 42,
        headers: {
          'X-RateLimit-Limit': '100',
        },
      },
      'https://useorgx.com'
    );

    expect(payload).toMatchObject({
      error: 'Rate limit exceeded',
      tier: 'free',
      retry_after_seconds: 42,
      upgrade_cta: {
        target_plan: 'pro',
        billing_settings_url:
          'https://useorgx.com/settings/billing?source=mcp_rate_limit',
      },
    });
    expect(payload.upgrade_cta.url).toContain('/pricing');
  });
});
