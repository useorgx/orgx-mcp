import { describe, expect, it } from 'vitest';

import {
  CLAUDE_DIRECTORY_WIDGET_URIS,
  resolveProfileDiscoveryPolicy,
} from '../src/profileDiscoveryPolicy';

describe('profile auxiliary discovery policy', () => {
  it('limits the Anthropic directory profile to coherent informational widgets', () => {
    const policy = resolveProfileDiscoveryPolicy('claude-directory');

    expect(policy).toMatchObject({
      includeInitiativeResource: false,
      includeSkillResources: false,
      includePrompts: false,
    });
    expect([...(policy.widgetUris ?? [])]).toEqual([
      ...CLAUDE_DIRECTORY_WIDGET_URIS,
    ]);
    expect(policy.widgetUris?.size).toBe(4);
  });

  it('preserves the established auxiliary surface for general profiles', () => {
    for (const profileName of ['v2', 'chatgpt', 'full', undefined]) {
      expect(resolveProfileDiscoveryPolicy(profileName)).toEqual({
        includeInitiativeResource: true,
        includeSkillResources: true,
        includePrompts: true,
        widgetUris: null,
      });
    }
  });

  it('only advertises initiative resources to an authorized read grant', () => {
    expect(
      resolveProfileDiscoveryPolicy('v2', {
        userId: 'oauth-user',
        grantedScopes: [],
      }).includeInitiativeResource
    ).toBe(false);
    expect(
      resolveProfileDiscoveryPolicy('v2', {
        userId: 'oauth-user',
        grantedScopes: ['memory:read'],
      }).includeInitiativeResource
    ).toBe(false);
    expect(
      resolveProfileDiscoveryPolicy('v2', {
        userId: 'oauth-user',
        grantedScopes: ['initiatives:read'],
      }).includeInitiativeResource
    ).toBe(true);
  });

  it('preserves authenticated legacy/internal resource access when the grant source is unknown', () => {
    expect(
      resolveProfileDiscoveryPolicy('v2', { userId: 'internal-user' })
        .includeInitiativeResource
    ).toBe(true);
  });
});
