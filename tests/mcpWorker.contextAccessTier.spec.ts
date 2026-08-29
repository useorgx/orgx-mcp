import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyHydrationAccessTier,
  resetHydrationAccessContextCache,
  resolveHydrationAccessContext,
  resolveHydrationMaxChars,
} from '../src/contextAccessTier';

vi.mock('../src/orgxApi', () => ({
  callOrgxApiJson: vi.fn(),
}));

describe('context hydration access tiers', () => {
  beforeEach(() => {
    resetHydrationAccessContextCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps free-tier hydration to 4000 chars', () => {
    expect(resolveHydrationMaxChars(undefined, 'free')).toBe(4000);
    expect(resolveHydrationMaxChars(6000, 'free')).toBe(4000);
    expect(resolveHydrationMaxChars(2500, 'free')).toBe(2500);
  });

  it('preserves full hydrated entries for paid tiers', () => {
    const result = applyHydrationAccessTier({
      hydrated: [
        {
          index: 0,
          entry: { type: 'entity', entity_type: 'task', entity_id: 'task-1' },
          hydrated: {
            id: 'task-1',
            title: 'Ship context hydration',
            status: 'in_progress',
            owner_id: 'user-1',
            summary: 'Keep the full payload',
          },
        },
      ],
      maxChars: 50000,
      tier: 'paid',
      truncated: false,
    });

    expect(result).toMatchObject({
      truncated: false,
      hydrated: [
        {
          hydrated: {
            id: 'task-1',
            title: 'Ship context hydration',
            status: 'in_progress',
            owner_id: 'user-1',
            summary: 'Keep the full payload',
          },
        },
      ],
    });
  });

  it('compacts hydrated entries for free tiers', () => {
    const result = applyHydrationAccessTier({
      hydrated: [
        {
          index: 0,
          entry: { type: 'artifact', artifact_id: 'artifact-1' },
          hydrated: {
            id: 'artifact-1',
            title: 'Launch brief',
            status: 'approved',
            artifact_type: 'launch.launch_brief',
            artifact_url: 'https://example.com/launch-brief',
            body_markdown: '# internal notes',
            metadata: { hidden: true },
          },
        },
      ],
      maxChars: 4000,
      tier: 'free',
      truncated: false,
    });

    expect(result).toMatchObject({
      truncated: false,
      hydrated: [
        {
          hydrated: {
            id: 'artifact-1',
            title: 'Launch brief',
            status: 'approved',
            artifact_type: 'launch.launch_brief',
            artifact_url: 'https://example.com/launch-brief',
          },
        },
      ],
    });
    expect(
      (result.hydrated[0]?.hydrated as Record<string, unknown>).body_markdown
    ).toBeUndefined();
  });

  it('resolves paid access from billing usage', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockResolvedValueOnce({
      json: async () => ({ plan: 'starter' }),
    } as Response);

    await expect(
      resolveHydrationAccessContext(
        { ORGX_API_URL: 'https://example.com', ORGX_SERVICE_KEY: 'oxk-test' },
        'user-1'
      )
    ).resolves.toEqual({
      tier: 'paid',
      plan: 'starter',
    });
  });

  it('caches resolved access per user for the ttl window', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockResolvedValue({
      json: async () => ({ plan: 'starter' }),
    } as Response);

    const env = {
      ORGX_API_URL: 'https://example.com',
      ORGX_SERVICE_KEY: 'oxk-test',
    };

    await expect(resolveHydrationAccessContext(env, 'user-1')).resolves.toEqual({
      tier: 'paid',
      plan: 'starter',
    });
    await expect(resolveHydrationAccessContext(env, 'user-1')).resolves.toEqual({
      tier: 'paid',
      plan: 'starter',
    });

    expect(callOrgxApiJson).toHaveBeenCalledTimes(1);
  });

  it('falls back to free access when billing usage fails', async () => {
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockRejectedValueOnce(new Error('boom'));

    await expect(
      resolveHydrationAccessContext(
        { ORGX_API_URL: 'https://example.com', ORGX_SERVICE_KEY: 'oxk-test' },
        'user-1'
      )
    ).resolves.toEqual({
      tier: 'free',
      plan: 'free',
    });
  });

  it('fails soft when billing usage exceeds its dedicated latency budget', async () => {
    vi.useFakeTimers();
    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson).mockImplementationOnce(
      async (_env, _path, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );

    const resolution = resolveHydrationAccessContext(
      {
        ORGX_API_URL: 'https://example.com',
        ORGX_SERVICE_KEY: 'oxk-test',
        ORGX_BILLING_PLAN_TIMEOUT_MS: '25',
      },
      'user-1'
    );

    await vi.advanceTimersByTimeAsync(24);
    expect(callOrgxApiJson).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resolution).resolves.toEqual({ tier: 'free', plan: 'free' });
    expect(
      (vi.mocked(callOrgxApiJson).mock.calls[0]?.[2]?.signal as AbortSignal)
        .aborted
    ).toBe(true);
  });

  it('does not reuse stale paid access when billing usage refresh fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00Z'));

    const { callOrgxApiJson } = await import('../src/orgxApi');
    vi.mocked(callOrgxApiJson)
      .mockResolvedValueOnce({
        json: async () => ({ plan: 'starter' }),
      } as Response)
      .mockRejectedValueOnce(new Error('billing unavailable'));

    const env = {
      ORGX_API_URL: 'https://example.com',
      ORGX_SERVICE_KEY: 'oxk-test',
    };

    await expect(resolveHydrationAccessContext(env, 'user-1')).resolves.toEqual({
      tier: 'paid',
      plan: 'starter',
    });

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await expect(resolveHydrationAccessContext(env, 'user-1')).resolves.toEqual({
      tier: 'free',
      plan: 'free',
    });
    expect(callOrgxApiJson).toHaveBeenCalledTimes(2);
  });
});
