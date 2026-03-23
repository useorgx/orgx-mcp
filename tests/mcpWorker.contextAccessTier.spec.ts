import { describe, expect, it, vi } from 'vitest';

import {
  applyHydrationAccessTier,
  resolveHydrationAccessContext,
  resolveHydrationMaxChars,
} from '../src/contextAccessTier';

vi.mock('../src/orgxApi', () => ({
  callOrgxApiJson: vi.fn(),
}));

describe('context hydration access tiers', () => {
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
});
