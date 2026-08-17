/**
 * MCP Authentication Helpers
 *
 * DRY helpers for OAuth checking and error responses.
 * Extracted from index.ts to reduce duplication.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface SecurityScheme {
  type: string;
  scopes?: readonly string[];
}

export type GrantedScopes = readonly string[] | ReadonlySet<string>;

export type AuthFailureReason =
  | 'missing_authentication'
  | 'insufficient_scope'
  | null;

export interface AuthCheckOptions {
  toolId: string;
  securitySchemes?: readonly SecurityScheme[];
  userId?: string;
  /**
   * OAuth scopes from a verified grant. `undefined` means the caller has no
   * grant source (legacy/internal auth); an explicit empty collection is a
   * known OAuth grant with no scopes and is enforced fail-closed.
   */
  grantedScopes?: GrantedScopes;
  serverUrl?: string;
  featureDescription?: string;
}

export interface AuthCheckResult {
  requiresAuth: boolean;
  allowsAnonymous: boolean;
  isAuthenticated: boolean;
  grantedScopesKnown: boolean;
  grantedScopes: string[];
  requiredScopeAlternatives: string[][];
  missingScopeAlternatives: string[][];
  isAuthorized: boolean;
  failureReason: AuthFailureReason;
  shouldBlock: boolean;
}

export interface ToolErrorEnvelope {
  code: string;
  status?: number;
  message: string;
  details?: Record<string, unknown>;
}

function buildToolErrorResult(error: ToolErrorEnvelope): CallToolResult {
  return {
    content: [{ type: 'text', text: error.message }],
    structuredContent: { error },
    isError: true,
  };
}

function uniqueScopes(scopes: GrantedScopes | undefined): string[] {
  return scopes === undefined ? [] : [...new Set(scopes)];
}

/**
 * Check authentication and OAuth scope alternatives.
 *
 * MCP security scheme entries are alternatives. A single OAuth alternative is
 * satisfied only when every scope in that entry is granted. Authenticated
 * legacy/internal callers remain compatible when no verified grant source is
 * available; once a grant is provided (including an empty grant), scope checks
 * fail closed.
 */
export function checkAuthRequirements(
  securitySchemes?: readonly SecurityScheme[],
  userId?: string,
  grantedScopes?: GrantedScopes
): AuthCheckResult {
  const schemes = securitySchemes ?? [];
  const oauthSchemes = schemes.filter((scheme) => scheme.type === 'oauth2');
  const requiresAuth = oauthSchemes.length > 0;
  const allowsAnonymous = schemes.some((scheme) => scheme.type === 'noauth');
  const isAuthenticated = !!userId;
  const grantedScopesKnown = grantedScopes !== undefined;
  const normalizedGrantedScopes = uniqueScopes(grantedScopes);
  const grantedScopeSet = new Set(normalizedGrantedScopes);
  const requiredScopeAlternatives = oauthSchemes.map((scheme) => [
    ...(scheme.scopes ?? []),
  ]);
  const missingScopeAlternatives = requiredScopeAlternatives.map((required) =>
    required.filter((scope) => !grantedScopeSet.has(scope))
  );

  const oauthAlternativeSatisfied =
    isAuthenticated &&
    oauthSchemes.some((scheme) => {
      if (!grantedScopesKnown) {
        return true;
      }
      return (scheme.scopes ?? []).every((scope) =>
        grantedScopeSet.has(scope)
      );
    });

  const isAuthorized =
    !requiresAuth || allowsAnonymous || oauthAlternativeSatisfied;
  const failureReason: AuthFailureReason = isAuthorized
    ? null
    : isAuthenticated
      ? 'insufficient_scope'
      : 'missing_authentication';

  return {
    requiresAuth,
    allowsAnonymous,
    isAuthenticated,
    grantedScopesKnown,
    grantedScopes: normalizedGrantedScopes,
    requiredScopeAlternatives,
    missingScopeAlternatives,
    isAuthorized,
    failureReason,
    shouldBlock: !isAuthorized,
  };
}

function selectChallengeScopes(authCheck: AuthCheckResult): string[] {
  const { requiredScopeAlternatives, missingScopeAlternatives } = authCheck;
  if (requiredScopeAlternatives.length === 0) {
    return [];
  }

  let selectedIndex = 0;
  for (let index = 1; index < requiredScopeAlternatives.length; index += 1) {
    const selectedMissing = missingScopeAlternatives[selectedIndex]?.length ?? 0;
    const candidateMissing = missingScopeAlternatives[index]?.length ?? 0;
    const selectedTotal = requiredScopeAlternatives[selectedIndex]?.length ?? 0;
    const candidateTotal = requiredScopeAlternatives[index]?.length ?? 0;

    if (
      candidateMissing < selectedMissing ||
      (candidateMissing === selectedMissing && candidateTotal < selectedTotal)
    ) {
      selectedIndex = index;
    }
  }

  return requiredScopeAlternatives[selectedIndex] ?? [];
}

function escapeChallengeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Build an OAuth authentication required error response.
 * Returns null if auth is not required.
 */
export function buildAuthRequiredResponse(
  options: AuthCheckOptions
): CallToolResult | null {
  const {
    toolId,
    securitySchemes,
    userId,
    grantedScopes,
    serverUrl,
    featureDescription,
  } = options;

  const authCheck = checkAuthRequirements(
    securitySchemes,
    userId,
    grantedScopes
  );

  if (!authCheck.shouldBlock) {
    return null;
  }

  const isMissingAuthentication =
    authCheck.failureReason === 'missing_authentication';
  const status = isMissingAuthentication ? 401 : 403;
  const errorCode = isMissingAuthentication
    ? 'authentication_required'
    : 'insufficient_scope';
  const challengeError = isMissingAuthentication
    ? 'invalid_token'
    : 'insufficient_scope';
  const requiredScopes = selectChallengeScopes(authCheck);

  // Log the block reason and policy inputs without logging credentials.
  console.warn(`[auth] Tool blocked due to ${authCheck.failureReason}`, {
    toolId,
    requiresAuth: authCheck.requiresAuth,
    allowsAnonymous: authCheck.allowsAnonymous,
    isAuthenticated: authCheck.isAuthenticated,
    hasUserId: !!userId,
    grantedScopesKnown: authCheck.grantedScopesKnown,
    requiredScopeAlternatives: authCheck.requiredScopeAlternatives,
    missingScopeAlternatives: authCheck.missingScopeAlternatives,
  });

  const baseServerUrl = (serverUrl ?? 'https://mcp.useorgx.com').replace(
    /\/+$/,
    ''
  );

  // Generate user-friendly description
  const description = featureDescription ?? toolId.replace(/_/g, ' ');
  const message = isMissingAuthentication
    ? `Authentication required: Please sign in to OrgX to ${description}.`
    : `Additional permission required: Reconnect OrgX and grant ${requiredScopes.join(
        ', '
      )} to ${description}.`;

  // Build WWW-Authenticate challenge (inlined, no longer depends on oauth.ts)
  const metadataUrl = `${baseServerUrl}/.well-known/oauth-protected-resource`;
  let challenge = `Bearer resource_metadata="${escapeChallengeValue(
    metadataUrl
  )}", error="${challengeError}", error_description="${escapeChallengeValue(
    message
  )}"`;
  if (requiredScopes.length > 0) {
    challenge += `, scope="${escapeChallengeValue(requiredScopes.join(' '))}"`;
  }

  return {
    content: [{ type: 'text', text: message }],
    structuredContent: {
      error: {
        code: errorCode,
        status,
        message,
        details: {
          required_scopes: requiredScopes,
          required_scope_alternatives: authCheck.requiredScopeAlternatives,
          missing_scope_alternatives: authCheck.missingScopeAlternatives,
          granted_scopes: authCheck.grantedScopes,
          grant_source_known: authCheck.grantedScopesKnown,
          retryable: false,
          ...(isMissingAuthentication
            ? {
                suggested_next_calls: [{ tool: 'orgx_bootstrap', args: {} }],
              }
            : {}),
        },
      },
    },
    _meta: {
      'mcp/www_authenticate': [challenge],
    },
    isError: true,
  } as CallToolResult;
}

/**
 * Tool error helper - creates a consistent error response.
 */
export function toolError(
  message: string,
  options: Partial<ToolErrorEnvelope> = {}
): CallToolResult {
  return buildToolErrorResult({
    code: options.code ?? 'tool_execution_failed',
    status: options.status,
    message,
    details: options.details,
  });
}

/**
 * Extract scopes from security schemes.
 */
export function extractRequiredScopes(
  securitySchemes?: readonly SecurityScheme[]
): string[] {
  return [
    ...new Set(
      securitySchemes
        ?.filter((scheme) => scheme.type === 'oauth2')
        .flatMap((scheme) => scheme.scopes ?? []) ?? []
    ),
  ];
}

/** Return OAuth requirements without collapsing alternative schemes. */
export function extractRequiredScopeAlternatives(
  securitySchemes?: readonly SecurityScheme[]
): string[][] {
  return (
    securitySchemes
      ?.filter((scheme) => scheme.type === 'oauth2')
      .map((scheme) => [...(scheme.scopes ?? [])]) ?? []
  );
}
