import { describe, expect, it } from 'vitest';

import {
  CLAUDE_DIRECTORY_WIDGET_URIS,
  resolveProfileDiscoveryPolicy,
} from '../src/profileDiscoveryPolicy';
import { WIDGET_URIS } from '../src/toolDefinitions';

const INFORMATIONAL_WIDGET_BASELINE = [
  WIDGET_URIS.agentStatus,
  WIDGET_URIS.searchResults,
  WIDGET_URIS.initiativePulse,
  WIDGET_URIS.morningBrief,
  WIDGET_URIS.entityCard,
  WIDGET_URIS.workLedger,
];

describe('profile auxiliary discovery policy', () => {
  it('limits the broader Anthropic directory to widgets its tools can serve', () => {
    const policy = resolveProfileDiscoveryPolicy('claude-directory');

    expect(policy).toMatchObject({
      includeInitiativeResource: false,
      includeSkillResources: false,
      includePrompts: false,
    });
    expect([...(policy.widgetUris ?? [])]).toEqual([
      ...CLAUDE_DIRECTORY_WIDGET_URIS,
    ]);
    expect([...(policy.widgetUris ?? [])]).toEqual([
      ...INFORMATIONAL_WIDGET_BASELINE,
      WIDGET_URIS.workspaceMap,
      WIDGET_URIS.proofReceipt,
    ]);
    expect(policy.widgetUris?.size).toBe(8);
    for (const uri of INFORMATIONAL_WIDGET_BASELINE) {
      expect(policy.widgetUris).toContain(uri);
    }
  });

  it.each(['read-only', 'unrecognized-profile'])(
    '%s preserves the six informational widgets independently of the directory',
    (profile) => {
      const policy = resolveProfileDiscoveryPolicy(profile);
      expect(policy).toMatchObject({
        includeInitiativeResource: false,
        includeSkillResources: false,
        includePrompts: false,
      });
      expect([...(policy.widgetUris ?? [])]).toEqual(INFORMATIONAL_WIDGET_BASELINE);
    }
  );

  it('preserves the established auxiliary surface for general profiles', () => {
    for (const profileName of ['v2', 'full', 'claude-plugin', undefined]) {
      expect(resolveProfileDiscoveryPolicy(profileName)).toEqual({
        includeInitiativeResource: true,
        includeSkillResources: true,
        includePrompts: true,
        widgetUris: null,
      });
    }
  });

  it('suppresses incompatible auxiliary skills and prompts for the ChatGPT review profile', () => {
    expect(resolveProfileDiscoveryPolicy('chatgpt')).toEqual({
      includeInitiativeResource: true,
      includeSkillResources: false,
      includePrompts: false,
      widgetUris: null,
    });

    expect(
      resolveProfileDiscoveryPolicy('chatgpt', {
        userId: 'oauth-user',
        grantedScopes: [],
      })
    ).toEqual({
      includeInitiativeResource: false,
      includeSkillResources: false,
      includePrompts: false,
      widgetUris: null,
    });

    expect(
      resolveProfileDiscoveryPolicy('chatgpt', {
        userId: 'oauth-user',
        grantedScopes: ['initiatives:read'],
      })
    ).toEqual({
      includeInitiativeResource: true,
      includeSkillResources: false,
      includePrompts: false,
      widgetUris: null,
    });
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
