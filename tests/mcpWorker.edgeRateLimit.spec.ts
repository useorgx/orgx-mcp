import { describe, expect, it } from 'vitest';

import { checkEdgeRateLimit } from '../src/edgeRateLimit';
import { buildRateLimitExceededPayload } from '../src/rateLimitResponse';

describe('edge rate limiting', () => {
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
