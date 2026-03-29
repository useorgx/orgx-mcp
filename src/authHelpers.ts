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
    structuredContent: {
      error: {
        code: 'permission_denied',
        status: 401,
        message: `Authentication required: Please sign in to OrgX to ${description}.`,
        details: {
          required_scopes:
            securitySchemes
              ?.filter((s) => s.type === 'oauth2')
              .flatMap((s) => s.scopes ?? []) ?? [],
          granted_scopes: [],
          retryable: false,
          suggested_next_calls: [{ tool: 'orgx_bootstrap', args: {} }],
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
  return (
    securitySchemes
      ?.filter((s) => s.type === 'oauth2')
      .flatMap((s) => s.scopes ?? []) ?? []
  );
}
