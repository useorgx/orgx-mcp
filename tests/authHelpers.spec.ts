import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAuthRequiredResponse,
  checkAuthRequirements,
  extractRequiredScopeAlternatives,
  extractRequiredScopes,
  type SecurityScheme,
} from '../src/authHelpers';

const oauth = (...scopes: string[]): SecurityScheme => ({
  type: 'oauth2',
  scopes,
});

function responseError(result: ReturnType<typeof buildAuthRequiredResponse>) {
  return (result?.structuredContent as {
    error: {
      code: string;
      status: number;
      message: string;
      details: Record<string, unknown>;
    };
  }).error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkAuthRequirements', () => {
  it('preserves authenticated legacy/internal calls when grant source is unknown', () => {
    expect(
      checkAuthRequirements([oauth('decisions:write')], 'user_123')
    ).toMatchObject({
      requiresAuth: true,
      isAuthenticated: true,
      grantedScopesKnown: false,
      isAuthorized: true,
      failureReason: null,
      shouldBlock: false,
    });
  });

  it('fails closed for an explicit empty OAuth grant', () => {
    expect(
      checkAuthRequirements([oauth('decisions:write')], 'user_123', [])
    ).toMatchObject({
      grantedScopesKnown: true,
      grantedScopes: [],
      isAuthorized: false,
      failureReason: 'insufficient_scope',
      shouldBlock: true,
    });
  });

  it('requires every scope within an OAuth scheme', () => {
    const schemes = [oauth('agents:write', 'initiatives:write')];

    expect(
      checkAuthRequirements(schemes, 'user_123', ['agents:write'])
    ).toMatchObject({
      isAuthorized: false,
      failureReason: 'insufficient_scope',
      missingScopeAlternatives: [['initiatives:write']],
    });
    expect(
      checkAuthRequirements(schemes, 'user_123', [
        'initiatives:write',
        'agents:write',
      ])
    ).toMatchObject({
      isAuthorized: true,
      shouldBlock: false,
    });
  });

  it('treats security scheme entries as alternatives', () => {
    const schemes = [oauth('decisions:write'), oauth('initiatives:write')];

    expect(
      checkAuthRequirements(schemes, 'user_123', ['initiatives:write'])
    ).toMatchObject({
      isAuthorized: true,
      requiredScopeAlternatives: [
        ['decisions:write'],
        ['initiatives:write'],
      ],
    });
  });

  it('accepts explicit empty grants for an auth-only OAuth scheme', () => {
    expect(
      checkAuthRequirements([{ type: 'oauth2' }], 'user_123', [])
    ).toMatchObject({
      isAuthorized: true,
      shouldBlock: false,
    });
  });

  it('honors a noauth alternative', () => {
    expect(
      checkAuthRequirements(
        [{ type: 'noauth' }, oauth('initiatives:read')],
        undefined,
        []
      )
    ).toMatchObject({
      allowsAnonymous: true,
      isAuthorized: true,
      shouldBlock: false,
    });
  });
});

describe('buildAuthRequiredResponse', () => {
  it('returns a 401 invalid_token challenge when authentication is missing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = buildAuthRequiredResponse({
      toolId: 'orgx_decide',
      securitySchemes: [oauth('decisions:write')],
      serverUrl: 'https://mcp.useorgx.com/',
      featureDescription: 'approve this decision',
    });
    const error = responseError(result);
    const challenge = result?._meta?.['mcp/www_authenticate'] as string[];

    expect(error).toMatchObject({
      code: 'authentication_required',
      status: 401,
      details: {
        required_scopes: ['decisions:write'],
        granted_scopes: [],
        grant_source_known: false,
      },
    });
    expect(challenge[0]).toContain('error="invalid_token"');
    expect(challenge[0]).toContain('scope="decisions:write"');
    expect(challenge[0]).not.toContain('mcp.useorgx.com//');
  });

  it('returns a 403 insufficient_scope challenge for an explicit partial grant', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = buildAuthRequiredResponse({
      toolId: 'handoff_task',
      securitySchemes: [oauth('agents:write', 'initiatives:write')],
      userId: 'user_123',
      grantedScopes: new Set(['agents:write']),
      featureDescription: 'hand off this task',
    });
    const error = responseError(result);
    const challenge = result?._meta?.['mcp/www_authenticate'] as string[];

    expect(error).toMatchObject({
      code: 'insufficient_scope',
      status: 403,
      details: {
        required_scopes: ['agents:write', 'initiatives:write'],
        required_scope_alternatives: [
          ['agents:write', 'initiatives:write'],
        ],
        missing_scope_alternatives: [['initiatives:write']],
        granted_scopes: ['agents:write'],
        grant_source_known: true,
      },
    });
    expect(error.details).not.toHaveProperty('suggested_next_calls');
    expect(challenge[0]).toContain('error="insufficient_scope"');
    expect(challenge[0]).toContain(
      'scope="agents:write initiatives:write"'
    );
  });

  it('returns null when one complete OAuth alternative is granted', () => {
    expect(
      buildAuthRequiredResponse({
        toolId: 'example',
        securitySchemes: [oauth('decisions:write'), oauth('agents:write')],
        userId: 'user_123',
        grantedScopes: ['agents:write'],
      })
    ).toBeNull();
  });
});

describe('scope extraction', () => {
  it('preserves alternatives while providing a deduplicated legacy union', () => {
    const schemes = [
      oauth('decisions:read', 'memory:read'),
      oauth('decisions:read'),
    ];

    expect(extractRequiredScopeAlternatives(schemes)).toEqual([
      ['decisions:read', 'memory:read'],
      ['decisions:read'],
    ]);
    expect(extractRequiredScopes(schemes)).toEqual([
      'decisions:read',
      'memory:read',
    ]);
  });
});
