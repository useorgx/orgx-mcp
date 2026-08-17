import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_POLICY,
  AUTHORIZATION_POLICY_VERSION,
  AUTHORIZATION_PRESETS,
  AUTHORIZATION_RESOURCE_ACTION_CATALOG,
  AUTHORIZATION_SESSION_CAPABILITIES,
  OAUTH_SCOPE,
  OAUTH_SCOPES_SUPPORTED,
  isSupportedOAuthScope,
} from '../src/authorizationPolicy';
import { SECURITY_SCHEMES } from '../src/toolDefinitions';

describe('authorization policy', () => {
  it('publishes one versioned catalog with the exact supported scope vocabulary', () => {
    const resourceScopes = AUTHORIZATION_RESOURCE_ACTION_CATALOG.flatMap(
      (resource) => resource.actions.map((action) => action.scope)
    );
    const sessionScopes = AUTHORIZATION_SESSION_CAPABILITIES.map(
      (capability) => capability.scope
    );

    expect(AUTHORIZATION_POLICY_VERSION).toBe('2026-08-15.v1');
    expect([...resourceScopes, ...sessionScopes]).toEqual([
      ...OAUTH_SCOPES_SUPPORTED,
    ]);
    expect(new Set(OAUTH_SCOPES_SUPPORTED).size).toBe(
      OAUTH_SCOPES_SUPPORTED.length
    );
    expect(AUTHORIZATION_POLICY).toMatchObject({
      version: AUTHORIZATION_POLICY_VERSION,
      scopesSupported: OAUTH_SCOPES_SUPPORTED,
      resources: AUTHORIZATION_RESOURCE_ACTION_CATALOG,
      sessionCapabilities: AUTHORIZATION_SESSION_CAPABILITIES,
      presets: AUTHORIZATION_PRESETS,
    });
  });

  it('keeps the supported scopes backward compatible and rejects unknown scopes', () => {
    expect(OAUTH_SCOPES_SUPPORTED).toEqual([
      'decisions:read',
      'decisions:write',
      'agents:read',
      'agents:write',
      'initiatives:read',
      'initiatives:write',
      'memory:read',
      'offline_access',
    ]);
    expect(isSupportedOAuthScope(OAUTH_SCOPE.agentsWrite)).toBe(true);
    expect(isSupportedOAuthScope('memory:write')).toBe(false);
    expect(isSupportedOAuthScope('admin')).toBe(false);
  });

  it('defines Read, Operate, and Custom without silently granting offline access', () => {
    expect(AUTHORIZATION_PRESETS.read.scopes).toEqual([
      'decisions:read',
      'agents:read',
      'initiatives:read',
      'memory:read',
    ]);
    expect(AUTHORIZATION_PRESETS.operate.scopes).toEqual([
      'decisions:read',
      'decisions:write',
      'agents:read',
      'agents:write',
      'initiatives:read',
      'initiatives:write',
      'memory:read',
    ]);
    expect(AUTHORIZATION_PRESETS.custom).toMatchObject({
      id: 'custom',
      label: 'Custom',
      selection: 'custom',
      scopes: [],
    });
    expect(AUTHORIZATION_PRESETS.read.scopes).not.toContain('offline_access');
    expect(AUTHORIZATION_PRESETS.operate.scopes).not.toContain(
      'offline_access'
    );
  });

  it('maps legacy write scopes to the user-facing Operate action', () => {
    const decisions = AUTHORIZATION_RESOURCE_ACTION_CATALOG.find(
      (resource) => resource.id === 'decisions'
    );
    const memory = AUTHORIZATION_RESOURCE_ACTION_CATALOG.find(
      (resource) => resource.id === 'memory'
    );

    expect(decisions?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'operate',
          access: 'operate',
          scope: 'decisions:write',
        }),
      ])
    );
    expect(memory?.actions.map((action) => action.id)).toEqual(['read']);
  });

  it('builds every advertised security scheme from supported scopes', () => {
    const schemeScopes = Object.values(SECURITY_SCHEMES).flatMap((schemes) =>
      schemes.flatMap((scheme) => ('scopes' in scheme ? scheme.scopes : []))
    );

    expect(schemeScopes.every(isSupportedOAuthScope)).toBe(true);
    expect(SECURITY_SCHEMES.handoffRequiresAuth[0].scopes).toEqual([
      OAUTH_SCOPE.agentsWrite,
      OAUTH_SCOPE.initiativesWrite,
    ]);
  });
});
