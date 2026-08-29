import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetBillingPlanCacheForTests,
  resolveBillingPlanContext,
} from '../src/billingPlan';
import { checkToolPlanAccess } from '../src/toolAccessGating';

vi.mock('../src/orgxApi', () => ({
  callOrgxApiJson: vi.fn(),
}));

const env = {
  ORGX_API_URL: 'https://api.useorgx.test',
  ORGX_SERVICE_KEY: 'oxk-test',
};

function billingResponse(body: unknown, origin = 'https://api.useorgx.test') {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'x-orgx-upstream-origin': origin,
    },
  });
}

describe('billing plan availability', () => {
  beforeEach(() => {
    resetBillingPlanCacheForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats only an explicit known API plan as available and surfaces its origin', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockResolvedValueOnce(
      billingResponse({ plan: 'free' }, 'https://fallback.useorgx.test')
    );

    await expect(resolveBillingPlanContext(env, 'user-1')).resolves.toEqual({
      plan: 'free',
      tier: 'free',
      available: true,
      source: 'api',
      origin: 'https://fallback.useorgx.test',
    });
  });

  it.each([
    ['missing', {}],
    ['unknown', { plan: 'mystery' }],
  ])('marks a %s plan payload unavailable instead of Free', async (_label, body) => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockResolvedValueOnce(billingResponse(body));

    await expect(resolveBillingPlanContext(env, 'user-1')).resolves.toMatchObject({
      plan: 'unknown',
      available: false,
      source: 'unavailable',
      reason: 'invalid_response',
      retryable: true,
    });
  });

  it('marks malformed JSON unavailable instead of Free', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockResolvedValueOnce(
      new Response('{not-json', {
        headers: {
          'content-type': 'application/json',
          'x-orgx-upstream-origin': 'https://api.useorgx.test',
        },
      })
    );

    await expect(resolveBillingPlanContext(env, 'user-1')).resolves.toMatchObject({
      available: false,
      source: 'unavailable',
      origin: 'https://api.useorgx.test',
      reason: 'invalid_response',
    });
  });

  it('returns a retryable timeout and does not cache the unavailable result', async () => {
    vi.useFakeTimers();
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson)
      .mockImplementationOnce(
        async (_env, _path, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            );
          })
      )
      .mockResolvedValueOnce(billingResponse({ plan: 'enterprise' }));

    const first = resolveBillingPlanContext(
      { ...env, ORGX_BILLING_PLAN_TIMEOUT_MS: '25' },
      'user-1'
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toMatchObject({
      available: false,
      source: 'unavailable',
      reason: 'timeout',
      retryable: true,
    });

    await expect(
      resolveBillingPlanContext(env, 'user-1')
    ).resolves.toMatchObject({
      available: true,
      plan: 'enterprise',
      source: 'api',
    });
    expect(callOrgxApiJson).toHaveBeenCalledTimes(2);
  });

  it('caches only verified API results and identifies cache as the source', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockResolvedValue(
      billingResponse({ plan: 'starter' })
    );

    const first = await resolveBillingPlanContext(env, 'user-1');
    const second = await resolveBillingPlanContext(env, 'user-1');

    expect(first.source).toBe('api');
    expect(second).toMatchObject({
      available: true,
      plan: 'starter',
      source: 'cache',
    });
    expect(callOrgxApiJson).toHaveBeenCalledTimes(1);
  });

  it('emits plan_unavailable for lookup failures, not plan_restricted', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockRejectedValueOnce(new Error('origin down'));

    const result = await checkToolPlanAccess({
      env,
      userId: 'user-1',
      feature: 'spawn_agent_task',
    });

    expect(result?.structuredContent).toMatchObject({
      ok: false,
      code: 'plan_unavailable',
      retryable: true,
      source: 'unavailable',
      reason: 'upstream_error',
    });
  });

  it('restricts a verified Free response and surfaces its source', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockResolvedValueOnce(
      billingResponse({ plan: 'free' })
    );

    const result = await checkToolPlanAccess({
      env,
      userId: 'user-1',
      feature: 'spawn_agent_task',
    });

    expect(result?.structuredContent).toMatchObject({
      ok: false,
      code: 'plan_restricted',
      plan: 'free',
      source: 'api',
      origin: 'https://api.useorgx.test',
    });
  });
});
