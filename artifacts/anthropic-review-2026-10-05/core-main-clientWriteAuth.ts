import {
  ApiErrorCode,
  createApiError,
  errors,
} from '@/lib/server/apiErrors';
import {
  apiKeyScopeDenialBody,
  authenticateApiKey,
} from '@/lib/server/auth/apiKeyAuth';
import {
  ensureServiceRequestAuthorized,
  extractGatewayUserEmail,
  extractGatewayUserId,
  verifyGatewayActor,
} from '@/lib/server/auth/serviceKey';
import { extractApiKeyWorkspaceId } from '@/lib/server/auth/apiKeyAuth';
import { checkGatewayDelegation } from '@/lib/server/auth/gatewayDelegation';
import {
  getSupabaseAdmin,
  resolveSupabaseUserIdForExternal,
} from '@/lib/supabase';
import {
  resolveGatewayOrgxUserIdByEmail,
  verifyGatewayOrgxUserId,
} from '@/lib/server/auth/gatewayOrgxUser';

export type ClientWriteAuth = {
  requesterId: string;
  authMode: 'service' | 'api_key';
  /** Workspace pinned to the API key, when the credential has one. */
  workspaceId: string | null;
  identity?: {
    gatewayUserEmail?: string;
    resolvedFromPlaceholder?: boolean;
    originalRequesterId?: string;
  };
};

function isPlaceholderEmail(email: string | null | undefined): boolean {
  return Boolean(email?.toLowerCase().endsWith('@placeholder.local'));
}

async function resolveVerifiedGatewayRequester(
  request: Request
): Promise<string | null> {
  const actor = verifyGatewayActor(request);
  const orgxUserId = actor?.orgxUserId;
  const actorEmail = actor?.email?.trim().toLowerCase();
  if (!orgxUserId || !actorEmail || isPlaceholderEmail(actorEmail)) {
    return null;
  }

  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data: profile, error } = await admin
    .from('users')
    .select('id, email')
    .eq('id', orgxUserId)
    .maybeSingle();
  if (error || profile?.id !== orgxUserId) return null;

  const profileEmail =
    typeof profile.email === 'string'
      ? profile.email.trim().toLowerCase()
      : null;
  return profileEmail === actorEmail ? orgxUserId : null;
}

async function resolveCanonicalRequesterFromGatewayEmail(params: {
  requesterId: string;
  gatewayUserEmail: string | null;
}): Promise<{
  requesterId: string;
  resolvedFromPlaceholder: boolean;
  originalRequesterId?: string;
}> {
  const gatewayUserEmail = params.gatewayUserEmail?.trim().toLowerCase();
  if (!gatewayUserEmail || isPlaceholderEmail(gatewayUserEmail)) {
    return { requesterId: params.requesterId, resolvedFromPlaceholder: false };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { requesterId: params.requesterId, resolvedFromPlaceholder: false };
  }

  const { data: currentProfile } = await admin
    .from('users')
    .select('id, email')
    .eq('id', params.requesterId)
    .maybeSingle();

  const currentEmail =
    typeof currentProfile?.email === 'string'
      ? currentProfile.email.toLowerCase()
      : null;

  if (currentEmail === gatewayUserEmail) {
    return { requesterId: params.requesterId, resolvedFromPlaceholder: false };
  }

  // Only repair synthetic legacy rows. A real email mismatch should not be
  // silently remapped because it may represent a genuine account boundary.
  if (!isPlaceholderEmail(currentEmail)) {
    return { requesterId: params.requesterId, resolvedFromPlaceholder: false };
  }

  const { data: canonicalProfile } = await admin
    .from('users')
    .select('id')
    .eq('email', gatewayUserEmail)
    .maybeSingle();

  if (!canonicalProfile?.id || canonicalProfile.id === params.requesterId) {
    return { requesterId: params.requesterId, resolvedFromPlaceholder: false };
  }

  return {
    requesterId: canonicalProfile.id,
    resolvedFromPlaceholder: true,
    originalRequesterId: params.requesterId,
  };
}

/**
 * Resolves write auth for client integration endpoints.
 * Supports:
 * 1) Service key + X-Orgx-User-Id (MCP worker path)
 * 2) User API key (plugin/local path)
 */
export async function resolveClientWriteAuth(
  request: Request,
  options: { requireCanonicalGatewayIdentity?: boolean } = {}
): Promise<ClientWriteAuth> {
  const auth = await resolveClientWriteAuthCredential(request, options);
  if (auth.authMode !== 'service') return auth;
  // Run-token sessions: refuse once the run has ended, pin its workspace.
  const delegation = await checkGatewayDelegation(request, auth.requesterId);
  if ('denied' in delegation) throw errors.unauthorized(delegation.denied);
  return delegation.delegated
    ? { ...auth, workspaceId: delegation.workspaceId }
    : auth;
}

async function resolveClientWriteAuthCredential(
  request: Request,
  options: { requireCanonicalGatewayIdentity?: boolean }
): Promise<ClientWriteAuth> {
  let serviceAuthorized = false;

  try {
    const serviceUnauthorized = ensureServiceRequestAuthorized(request);
    serviceAuthorized = !serviceUnauthorized;
  } catch {
    // Ignore service-key validation errors and fall through to API key auth.
    // This keeps local/API-key flows working even if ORGX_SERVICE_KEY is unset.
  }

  if (serviceAuthorized) {
    const gatewayUserId = extractGatewayUserId(request);
    const gatewayUserEmail = extractGatewayUserEmail(request);
    if (!gatewayUserId) {
      throw errors.badRequest(
        'X-Orgx-User-Id is required when using service-key authentication'
      );
    }

    if (options.requireCanonicalGatewayIdentity) {
      const actor = verifyGatewayActor(request);
      if (!actor || actor.userId !== gatewayUserId) {
        throw errors.unauthorized(
          'Signed canonical OrgX account identity is required'
        );
      }

      if (actor.orgxUserId) {
        const canonicalUserId = await verifyGatewayOrgxUserId(
          actor.orgxUserId,
          actor.email,
          '[client-write-auth]'
        );
        if (!canonicalUserId) {
          throw errors.unauthorized(
            'Signed gateway identity does not resolve to a canonical OrgX account'
          );
        }
        return {
          requesterId: canonicalUserId,
          authMode: 'service',
          workspaceId: null,
          identity: {
            ...(actor.email ? { gatewayUserEmail: actor.email } : {}),
          },
        };
      }

      if (actor.email && !isPlaceholderEmail(actor.email)) {
        const canonicalUserId = await resolveGatewayOrgxUserIdByEmail(
          actor.email,
          '[client-write-auth]'
        );
        if (canonicalUserId) {
          return {
            requesterId: canonicalUserId,
            authMode: 'service',
            workspaceId: null,
            identity: {
              gatewayUserEmail: actor.email,
              resolvedFromPlaceholder: true,
              originalRequesterId: gatewayUserId,
            },
          };
        }
      }

      throw errors.unauthorized(
        'Signed gateway identity does not resolve to a canonical OrgX account'
      );
    }

    const verifiedGatewayRequester =
      await resolveVerifiedGatewayRequester(request);
    if (verifiedGatewayRequester) {
      return {
        requesterId: verifiedGatewayRequester,
        authMode: 'service',
        workspaceId: null,
        identity: {
          ...(gatewayUserEmail ? { gatewayUserEmail } : {}),
        },
      };
    }

    const requesterId = await resolveSupabaseUserIdForExternal(gatewayUserId, {
      email: gatewayUserEmail ?? undefined,
      createIfMissing: false,
    });
    if (!requesterId) {
      throw errors.unauthorized('Unknown user for service-key request');
    }

    const canonical = await resolveCanonicalRequesterFromGatewayEmail({
      requesterId,
      gatewayUserEmail,
    });

    return {
      requesterId: canonical.requesterId,
      authMode: 'service',
      workspaceId: null,
      identity: {
        ...(gatewayUserEmail ? { gatewayUserEmail } : {}),
        ...(canonical.resolvedFromPlaceholder
          ? {
              resolvedFromPlaceholder: true,
              originalRequesterId: canonical.originalRequesterId,
            }
          : {}),
      },
    };
  }

  const apiKeyAuth = await authenticateApiKey(request);
  if (apiKeyAuth?.userId) {
    return {
      requesterId: apiKeyAuth.userId,
      authMode: 'api_key',
      workspaceId: await extractApiKeyWorkspaceId(request),
    };
  }

  const scopeDenial = apiKeyScopeDenialBody(request);
  if (scopeDenial) {
    throw createApiError(ApiErrorCode.AUTHORIZATION_ERROR, scopeDenial.error.message, {
      details: scopeDenial.error,
    });
  }
  throw errors.unauthorized('Valid service key or API key is required');
}
