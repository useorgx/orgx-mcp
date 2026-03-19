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

export interface AuthCheckOptions {
  toolId: string;
  securitySchemes?: readonly SecurityScheme[];
  userId?: string;
  serverUrl?: string;
  featureDescription?: string;
}

export interface AuthCheckResult {
  requiresAuth: boolean;
  isAuthenticated: boolean;
  shouldBlock: boolean;
}

/**
 * Check if a tool requires authentication based on its security schemes.
 */
export function checkAuthRequirements(
  securitySchemes?: readonly SecurityScheme[],
  userId?: string
): AuthCheckResult {
  const requiresAuth =
    securitySchemes?.some((s) => s.type === 'oauth2') ?? false;
  const allowsAnonymous =
    securitySchemes?.some((s) => s.type === 'noauth') ?? false;
  const isAuthenticated = !!userId;

  return {
    requiresAuth,
    isAuthenticated,
    shouldBlock: requiresAuth && !allowsAnonymous && !isAuthenticated,
  };
}

/**
 * Build an OAuth authentication required error response.
 * Returns null if auth is not required.
 */
export function buildAuthRequiredResponse(
  options: AuthCheckOptions
): CallToolResult | null {
  const { toolId, securitySchemes, userId, serverUrl, featureDescription } =
    options;

  const authCheck = checkAuthRequirements(securitySchemes, userId);

  if (!authCheck.shouldBlock) {
    return null;
  }

  // Log auth block for observability in production
  console.warn('[auth] Tool blocked due to missing authentication', {
    toolId,
    requiresAuth: authCheck.requiresAuth,
    allowsAnonymous: !authCheck.shouldBlock && authCheck.requiresAuth,
    isAuthenticated: authCheck.isAuthenticated,
    hasUserId: !!userId,
    requiredScopes:
      securitySchemes
        ?.filter((s) => s.type === 'oauth2')
        .flatMap((s) => s.scopes ?? []) ?? [],
  });

  const baseServerUrl = serverUrl ?? 'https://mcp.useorgx.com';
  const requiredScopes = securitySchemes
    ?.filter((s) => s.type === 'oauth2')
    .flatMap((s) => s.scopes ?? [])
    .join(' ');

  // Generate user-friendly description
  const description = featureDescription ?? toolId.replace(/_/g, ' ');

  // Build WWW-Authenticate challenge (inlined, no longer depends on oauth.ts)
  const metadataUrl = `${baseServerUrl}/.well-known/oauth-protected-resource`;
  let challenge = `Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", error_description="You need to sign in to ${description}"`;
  if (requiredScopes) {
    challenge += `, scope="${requiredScopes}"`;
  }

  return {
    content: [
      {
        type: 'text',
        text: `Authentication required: Please sign in to OrgX to ${description}.`,
      },
    ],
    _meta: {
      'mcp/www_authenticate': [challenge],
    },
    isError: true,
  } as CallToolResult;
}

/**
 * Tool error helper - creates a consistent error response.
 */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Extract scopes from security schemes.
 */
export function extractRequiredScopes(
  securitySchemes?: readonly SecurityScheme[]
): string[] {
  return (
    securitySchemes
      ?.filter((s) => s.type === 'oauth2')
      .flatMap((s) => s.scopes ?? []) ?? []
  );
}
