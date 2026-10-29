import { createHmac } from 'node:crypto';

import { NextResponse } from 'next/server';

import { logger } from '@/lib/logger';
import { secureCompare } from '@/lib/server/auth/secureCompare';
import {
  matchServiceCredential,
  parseScopedServiceKeys,
} from '@/lib/server/auth/serviceCredentials';

const HEADER_NAME = 'authorization';

function extractBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  if (headerValue.toLowerCase().startsWith('bearer ')) {
    return headerValue.slice(7);
  }
  return headerValue;
}

/**
 * Validates that the incoming request includes the shared MCP service key.
 * Returns a NextResponse when the request is unauthorized so callers can early-return.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function ensureServiceRequestAuthorized(request: Request) {
  if (!process.env.ORGX_SERVICE_KEY && parseScopedServiceKeys().length === 0) {
    throw new Error('ORGX_SERVICE_KEY is not configured');
  }

  const provided = extractBearerToken(request.headers.get(HEADER_NAME));
  const match = provided
    ? matchServiceCredential(provided, requestPath(request) ?? '')
    : null;
  if (!match) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

const USER_ID_HEADER = 'x-orgx-user-id';
const USER_EMAIL_HEADER = 'x-orgx-user-email';
const ORGX_USER_ID_HEADER = 'x-orgx-orgx-user-id';
const ACTOR_TOKEN_HEADER = 'x-orgx-actor-token';
const ACTOR_TOKEN_TYPE = 'orgx.mcp.actor.v1';
const ACTOR_TOKEN_AUD = 'orgx-api';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GatewayActor = {
  userId: string;
  email: string | null;
  // Internal Supabase UUID resolved at MCP login, when the gateway sends one.
  // A verified fast-path identity signal — callers must still confirm it
  // (existence + email agreement) before treating it as ground truth.
  orgxUserId: string | null;
  /**
   * Delegation claims (orgx-mcp run-token sessions): the agent run and
   * workspace this call is bound to, and the run's granted tool scopes. Absent
   * for interactive OAuth sessions. See gatewayDelegation.ts.
   */
  runId: string | null;
  workspaceId: string | null;
  scopes: readonly string[] | null;
};

type GatewayActorPayload = {
  type: typeof ACTOR_TOKEN_TYPE;
  aud: typeof ACTOR_TOKEN_AUD;
  iss: 'orgx-mcp';
  sub: string;
  email?: string;
  orgx_user_id?: string;
  rid?: string;
  wid?: string;
  scp?: string[];
  iat: number;
  exp: number;
};

function decodeBase64UrlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function isGatewayActorPayload(value: unknown): value is GatewayActorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<GatewayActorPayload>;
  return (
    payload.type === ACTOR_TOKEN_TYPE &&
    payload.aud === ACTOR_TOKEN_AUD &&
    payload.iss === 'orgx-mcp' &&
    typeof payload.sub === 'string' &&
    payload.sub.trim().length > 0 &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number' &&
    (payload.email === undefined || typeof payload.email === 'string') &&
    (payload.orgx_user_id === undefined ||
      typeof payload.orgx_user_id === 'string') &&
    (payload.rid === undefined || typeof payload.rid === 'string') &&
    (payload.wid === undefined || typeof payload.wid === 'string') &&
    (payload.scp === undefined ||
      (Array.isArray(payload.scp) &&
        payload.scp.every((scope) => typeof scope === 'string')))
  );
}

/**
 * Verifies the signed MCP-worker actor assertion used for service-to-service
 * calls. This is intentionally separate from X-Orgx-User-Id; the user id must
 * be inside an HMAC-signed, short-lived token with an API audience.
 */
export function verifyGatewayActor(request: Request): GatewayActor | null {
  const secret = process.env.ORGX_INTERNAL_SECRET;
  const token = request.headers.get(ACTOR_TOKEN_HEADER);
  if (!secret || !token) return null;

  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expectedSignature = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  if (!secureCompare(signature, expectedSignature)) return null;

  let parsed: unknown;
  try {
    parsed = decodeBase64UrlJson(payloadB64);
  } catch {
    return null;
  }
  if (!isGatewayActorPayload(parsed)) return null;
  if (parsed.exp < Date.now()) return null;

  const orgxUserId =
    typeof parsed.orgx_user_id === 'string' &&
    UUID_RE.test(parsed.orgx_user_id.trim())
      ? parsed.orgx_user_id.trim()
      : null;

  return {
    userId: parsed.sub.trim(),
    email: parsed.email?.trim().toLowerCase() ?? null,
    orgxUserId,
    runId: parsed.rid?.trim() || null,
    workspaceId: parsed.wid?.trim() || null,
    scopes: parsed.scp ?? null,
  };
}

/**
 * How much the service-key path trusts the unsigned `X-Orgx-User-Id` /
 * `X-Orgx-User-Email` headers.
 *
 * Anyone holding ORGX_SERVICE_KEY can put any user in those headers, so the
 * service key alone is a credential for every account. The signed actor token
 * (`X-Orgx-Actor-Token`, HMAC with ORGX_INTERNAL_SECRET, 5 min, audience
 * `orgx-api`) binds the user to a gateway that also holds the internal secret.
 *
 * - `observe` (default): unsigned or mismatched identity still works, and is
 *   logged so the remaining unsigned callers can be found and migrated.
 * - `enforce`: identity comes only from a valid actor token; a header that
 *   disagrees with it, or appears without it, is ignored.
 * - `off`: legacy behaviour, no logging.
 */
export type GatewayActorMode = 'off' | 'observe' | 'enforce';

export function gatewayActorMode(
  env: Record<string, string | undefined> = process.env
): GatewayActorMode {
  const raw = env.ORGX_GATEWAY_ACTOR_MODE?.trim().toLowerCase();
  return raw === 'off' || raw === 'enforce' ? raw : 'observe';
}

function requestPath(request: Request): string | null {
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

/**
 * Extract the user the MCP gateway speaks for.
 *
 * Only meaningful on requests that already passed
 * `ensureServiceRequestAuthorized` — call that first. What it returns depends
 * on {@link gatewayActorMode}; in `enforce` it is always the signed actor.
 */
export function extractGatewayUserId(request: Request): string | null {
  const headerValue = request.headers.get(USER_ID_HEADER)?.trim() || null;
  const mode = gatewayActorMode();
  if (mode === 'off') return headerValue;

  const actor = verifyGatewayActor(request);
  if (actor) {
    if (headerValue && headerValue !== actor.userId) {
      logger.warn(
        '[gateway-actor] X-Orgx-User-Id disagrees with signed actor',
        {
          route: requestPath(request),
          mode,
        }
      );
      return mode === 'enforce' ? null : headerValue;
    }
    return actor.userId;
  }

  if (headerValue) {
    logger.warn('[gateway-actor] unsigned gateway identity', {
      route: requestPath(request),
      mode,
    });
    return mode === 'enforce' ? null : headerValue;
  }
  return null;
}

/**
 * Extract the gateway user's email. Same trust rules as
 * {@link extractGatewayUserId}: in `enforce` only the signed actor's email.
 */
export function extractGatewayUserEmail(request: Request): string | null {
  const headerValue =
    request.headers.get(USER_EMAIL_HEADER)?.trim().toLowerCase() || null;
  const mode = gatewayActorMode();
  if (mode === 'off') return headerValue;
  const actor = verifyGatewayActor(request);
  if (actor) return actor.email ?? (mode === 'enforce' ? null : headerValue);
  return mode === 'enforce' ? null : headerValue;
}

/**
 * Mint an actor token for app-internal service calls (probes, workers) so they
 * speak for a user the same way the MCP gateway does. Returns null when
 * ORGX_INTERNAL_SECRET is not configured.
 */
export function signGatewayActorToken(params: {
  userId: string;
  email?: string | null;
  orgxUserId?: string | null;
  runId?: string | null;
  workspaceId?: string | null;
  scopes?: readonly string[];
  ttlMs?: number;
  nowMs?: number;
  secret?: string | null;
}): string | null {
  const secret = params.secret ?? process.env.ORGX_INTERNAL_SECRET;
  if (!secret || !params.userId.trim()) return null;
  const now = params.nowMs ?? Date.now();
  const payload: GatewayActorPayload = {
    type: ACTOR_TOKEN_TYPE,
    aud: ACTOR_TOKEN_AUD,
    iss: 'orgx-mcp',
    sub: params.userId.trim(),
    ...(params.email ? { email: params.email.trim().toLowerCase() } : {}),
    ...(params.orgxUserId ? { orgx_user_id: params.orgxUserId } : {}),
    ...(params.runId ? { rid: params.runId } : {}),
    ...(params.workspaceId ? { wid: params.workspaceId } : {}),
    ...(params.scopes ? { scp: [...params.scopes] } : {}),
    iat: now,
    exp: now + (params.ttlMs ?? 5 * 60 * 1000),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Extract the login-resolved internal Supabase UUID the MCP gateway forwards as
 * `X-Orgx-Orgx-User-Id` (additive — `X-Orgx-User-Id` stays the Clerk id).
 *
 * Prefer the signed actor token via `verifyGatewayActor` when available; this
 * unsigned header is the compatibility hint, trustworthy only after service-key
 * auth. Returns the UUID (validated) or null. The consumer must still verify it
 * (existence + email agreement) before treating it as ground truth — a bare UUID
 * is a hint, never proof of identity.
 */
export function extractGatewayOrgxUserId(request: Request): string | null {
  const value = request.headers.get(ORGX_USER_ID_HEADER);
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

/**
 * The gateway-supplied internal UUID hint to use for THIS resolution, or null.
 *
 * Guarded so the session's UUID is never applied to an explicit owner override:
 * returned only on a service-key request whose effective (Clerk) user id equals
 * the gateway's own user id. Prefers the signed actor-token claim over the
 * unsigned header. The consumer must still verify the returned UUID.
 */
export function resolveGatewayOrgxUserIdHint(
  request: Request,
  effectiveClerkUserId: string | null,
  serviceAuthorized: boolean
): string | null {
  if (!serviceAuthorized || !effectiveClerkUserId) return null;
  if (effectiveClerkUserId !== extractGatewayUserId(request)) return null;
  return (
    verifyGatewayActor(request)?.orgxUserId ?? extractGatewayOrgxUserId(request)
  );
}
