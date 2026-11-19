import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBillingPlanCacheForTests, resolveBillingPlanContext } from '../src/billingPlan';

const env = {
  ORGX_API_URL: 'https://primary.example.test',
  ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
  ORGX_SERVICE_KEY: 'oxk-test',
};

function stalledFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
  });
}

afterEach(() => {
  resetBillingPlanCacheForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('billing lookup fallback deadline', () => {
  it('recovers a stalled primary before the entitlement deadline while retaining actor and workspace', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementationOnce(stalledFetch)
      .mockResolvedValueOnce(Response.json({ plan: 'enterprise' }));
    vi.stubGlobal('fetch', fetcher);
    const lookup = resolveBillingPlanContext(env, 'user-1', { workspaceId: 'workspace-1' });

    await vi.advanceTimersByTimeAsync(2_500);

    await expect(lookup).resolves.toMatchObject({ available: true, plan: 'enterprise', source: 'api' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [fallback, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(new URL(fallback).origin).toBe('https://fallback.example.test');
    expect(new URL(fallback).searchParams.get('workspace_id')).toBe('workspace-1');
    expect(new URL(fallback).searchParams.get('view')).toBe('plan');
    expect(new Headers(init.headers).get('x-orgx-user-id')).toBe('user-1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed within the original deadline when both origins stall, then permits a fresh lookup', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(stalledFetch);
    vi.stubGlobal('fetch', fetcher);
    const lookup = resolveBillingPlanContext(env, 'user-1');

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(lookup).resolves.toMatchObject({ available: false, reason: 'timeout', tier: 'free' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    fetcher.mockResolvedValueOnce(Response.json({ plan: 'enterprise' }));
    await expect(resolveBillingPlanContext(env, 'user-1')).resolves.toMatchObject({ available: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('honors a shorter configured API budget and an earlier primary cutoff', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementationOnce(stalledFetch)
      .mockResolvedValueOnce(Response.json({ plan: 'pro' }));
    vi.stubGlobal('fetch', fetcher);
    const lookup = resolveBillingPlanContext({ ...env, ORGX_API_TIMEOUT_MS: '100', ORGX_API_PRIMARY_TIMEOUT_MS: '20' }, 'user-1');

    await vi.advanceTimersByTimeAsync(20);

    await expect(lookup).resolves.toMatchObject({ available: true, plan: 'pro' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
