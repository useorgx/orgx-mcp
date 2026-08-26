import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetBillingPlanCacheForTests,
  resolveBillingPlanContext,
} from '../src/billingPlan';

describe('workspace-scoped billing plan resolution', () => {
  afterEach(() => {
    resetBillingPlanCacheForTests();
    vi.unstubAllGlobals();
  });

  it('binds the plan lookup to the authenticated identity and workspace', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ plan: 'enterprise' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveBillingPlanContext(
      {
        ORGX_API_URL: 'https://api.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
        ORGX_INTERNAL_SECRET: 'test-internal-secret',
      },
      'clerk-user-1',
      {
        userEmail: 'HopeAtina@gmail.com',
        orgxUserId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '7af01a51-49b1-47d8-98b9-91a198debca8',
      }
    );

    expect(result).toMatchObject({
      plan: 'enterprise',
      tier: 'enterprise',
      source: 'api',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(
      '/api/billing/usage?workspace_id=7af01a51-49b1-47d8-98b9-91a198debca8'
    );
    const headers = new Headers(init.headers);
    expect(headers.get('x-orgx-user-id')).toBe('clerk-user-1');
    expect(headers.get('x-orgx-actor-token')).toBeTruthy();
  });

  it('does not reuse a free plan cached for another workspace', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ plan: 'free' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ plan: 'enterprise' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      ORGX_API_URL: 'https://api.useorgx.test',
      ORGX_SERVICE_KEY: 'oxk-test',
    };
    const free = await resolveBillingPlanContext(env, 'user-1', {
      workspaceId: 'workspace-free',
    });
    const enterprise = await resolveBillingPlanContext(env, 'user-1', {
      workspaceId: 'workspace-enterprise',
    });

    expect(free.tier).toBe('free');
    expect(enterprise.tier).toBe('enterprise');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
