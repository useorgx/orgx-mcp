import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { verifyCsrf } from '@/lib/csrf';
import { allowRequest, rateLimitKey } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import type { SupabaseDbClient } from '@/types/database';
import { recordRunTraceEvent } from '@/lib/server/runTrace';
import {
  extractCorrelationId,
  setCorrelationId,
  getCorrelationId,
} from '@/lib/server/correlation';
import { ApiErrorCode, normalizeToApiError } from '@/lib/server/apiErrors';
import type { InternalUserId } from '@/lib/server/auth/actorUserId';
import {
  runWithRequestContext,
  resolveRequestAuth,
  getRequestSupabaseClient,
  hasRequestContext,
} from '@/lib/server/requestContext';
import {
  ensureServiceRequestAuthorized,
  verifyGatewayActor,
} from '@/lib/server/auth/serviceKey';
import {
  jsonApiError,
  jsonError,
  jsonValidationError,
} from '@/lib/server/apiResponse';

export type ApiContext = {
  /** The acting user resolved to `public.users.id`. Safe in a `uuid` column. */
  userId: InternalUserId | null;
  /**
   * The external-facing id. NOT branded `ExternalUserId`, deliberately:
   * `resolveApiUser` falls back to the internal id here when no Clerk id
   * exists, so the field genuinely holds either kind. Branding it would make
   * that fallback a compile error, which is a conversation about what this
   * field means rather than a mechanical fix — left for a follow-up so the
   * boundary that reaches `uuid` columns can close now.
   */
  externalUserId: string | null;
  email: string | null;
  fullName: string | null;
  // Attach parsed data if validation middleware is used
  body?: unknown;
  query?: unknown;
  params?: Record<string, string | string[]>;
  // Populated by composable authz wrappers in lib/server/routeAuthz.ts
  workspace?: { id: string };
  resource?: { id: string; workspace_id: string; row: Record<string, unknown> };
  project?: { id: string };
  // Credential class that admitted this request. Set by the v1 admission
  // wrapper (app/api/v1/proofRuntimeRouteAuth.ts) so handlers can branch on
  // *how* the caller authenticated without re-parsing headers — which is the
  // only reliable way to tell a shared service key from a personal key.
  credential?: CredentialClass;
  /** `api_keys.id` when a personal `oxk_` key authorized. Null otherwise. */
  apiKeyId?: string | null;
  /**
   * `api_keys.scopes` for the admitting key. Exposed for observability only —
   * nothing enforces these yet (see docs/specs/api/v1-completion-spec.md G2).
   */
  apiKeyScopes?: readonly string[] | null;
  /**
   * Workspace the *credential itself* is bound to (`api_keys.metadata.workspaceId`).
   * Distinct from `workspace`, which any authz wrapper may set: this one records
   * that the binding came from the key, so `withWorkspaceAccess` can treat a
   * differing caller-supplied `workspace_id` as a refusal rather than an override.
   */
  credentialWorkspaceId?: string | null;
};

/**
 * How the caller authenticated. Only `service` (the trusted MCP gateway /
 * worker key) may speak for a user other than itself.
 */
export type CredentialClass = 'session' | 'api_key' | 'service';

export type ApiHandler = (req: Request, ctx: ApiContext) => Promise<Response>;

/**
 * Extracts runId from URL path if it matches patterns like /api/runs/[runId]/...
 */
function extractRunIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathMatch = urlObj.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})/);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Tracks Next.js compilation delays by measuring time from route entry to handler execution.
 * Compilation typically happens before the handler executes, so a significant delay (>100ms)
 * likely indicates compilation occurred.
 */
function withCompilationTracking(handler: ApiHandler): ApiHandler {
  return async (req: Request, ctx: ApiContext) => {
    // Extract and set correlation ID
    const correlationId = extractCorrelationId(req);
    setCorrelationId(correlationId);

    const routeEntryTime = performance.now();
    const url = new URL(req.url);
    const routePath = url.pathname;

    // Extract runId from URL if available
    const runId = extractRunIdFromUrl(req.url);

    try {
      const response = await handler(req, ctx);

      // Calculate time from route entry to handler completion
      const handlerDuration = performance.now() - routeEntryTime;

      // If handler took > 100ms and we have a runId, record a potential compilation event
      // Note: This is an approximation - actual compilation happens before handler execution
      // but we can't measure it directly. The delay includes compilation + handler execution.
      if (runId && handlerDuration > 100) {
        // Try to get userId from context if available
        const userId = ctx.userId;

        // Record as a system event indicating route execution time
        // In dev mode, if this is very long (>1s), it likely includes compilation
        if (process.env.NODE_ENV !== 'production' && handlerDuration > 1000) {
          recordRunTraceEvent({
            runId,
            eventName: 'api.route.compilation_detected',
            source: 'system',
            durationMs: Math.round(handlerDuration),
            detail: {
              route: routePath,
              method: req.method,
              durationMs: Math.round(handlerDuration),
              note: 'This duration includes Next.js compilation time if route was not previously compiled',
            },
            userId: userId ?? undefined,
            forceFile: true, // Always record compilation events to file
          }).catch((error) => {
            // Don't fail the request if trace recording fails
            logger.debug('[apiRoute] failed to record compilation event', {
              runId,
              route: routePath,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }

      return response;
    } catch (error) {
      // Still record if there was an error
      const handlerDuration = performance.now() - routeEntryTime;
      const runId = extractRunIdFromUrl(req.url);

      if (runId && handlerDuration > 1000) {
        recordRunTraceEvent({
          runId,
          eventName: 'api.route.compilation_detected',
          source: 'system',
          durationMs: Math.round(handlerDuration),
          detail: {
            route: routePath,
            method: req.method,
            durationMs: Math.round(handlerDuration),
            error: error instanceof Error ? error.message : String(error),
          },
          userId: ctx.userId ?? undefined,
          forceFile: true,
        }).catch(() => {
          // Ignore errors
        });
      }

      throw error;
    }
  };
}

export function toRoute(handler: ApiHandler) {
  return async (
    req: NextRequest,
    context: { params: Promise<Record<string, string | string[]>> }
  ) => {
    const params = context?.params ? await context.params : {};
    const baseContext: ApiContext = {
      userId: null,
      externalUserId: null,
      email: null,
      fullName: null,
      params,
    };
    // Wrap the handler with request context, compilation tracking, and global error handling
    const trackedHandler = withCompilationTracking(handler);

    // Run within request context for shared auth state
    return runWithRequestContext(() => trackedHandler(req, baseContext));
  };
}

export async function resolveApiUser(): Promise<
  Pick<ApiContext, 'userId' | 'externalUserId' | 'email' | 'fullName'>
> {
  // Use request-scoped context if available (preferred)
  const authContext = await resolveRequestAuth();

  // If we got a result from the context, use it
  if (authContext.clerkUserId || authContext.supabaseUserId) {
    return {
      userId: authContext.supabaseUserId as InternalUserId | null,
      externalUserId: authContext.clerkUserId ?? authContext.supabaseUserId,
      email: authContext.email,
      fullName: authContext.fullName,
    };
  }

  // Fallback: try Supabase auth directly (for non-Clerk sessions)
  try {
    const supabase = await getRequestSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      return {
        userId: user.id as InternalUserId,
        externalUserId: user.id,
        email: user.email?.toLowerCase() ?? null,
        fullName: (user.user_metadata?.full_name as string | null) ?? null,
      };
    }
  } catch (error) {
    logger.warn('[api] Failed to get Supabase user', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    userId: null,
    externalUserId: null,
    email: null,
    fullName: null,
  };
}

export function withAuth(
  options: { optional?: boolean; allowServiceAuth?: boolean } = {}
) {
  const { optional = false, allowServiceAuth = false } = options;
  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      const resolved = await resolveApiUser();
      let nextCtx: ApiContext = { ...ctx, ...resolved };
      if (allowServiceAuth && !nextCtx.userId) {
        try {
          const unauthorized = ensureServiceRequestAuthorized(req);
          if (!unauthorized) {
            const gatewayActor = verifyGatewayActor(req);
            if (gatewayActor) {
              nextCtx = {
                ...nextCtx,
                userId: gatewayActor.userId as InternalUserId,
                externalUserId: gatewayActor.userId,
                email: gatewayActor.email,
              };
            }
          }
        } catch {
          // Runtime has no service key configured; keep normal user auth behavior.
        }
      }
      if (!optional && !nextCtx.userId) {
        return jsonError(
          ApiErrorCode.AUTHENTICATION_ERROR,
          'Authentication required'
        );
      }
      return handler(req, nextCtx);
    };
  };
}

export function withCsrf() {
  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      if (!(await verifyCsrf(req))) {
        return jsonError(
          ApiErrorCode.AUTHORIZATION_ERROR,
          'Invalid CSRF token'
        );
      }
      return handler(req, ctx);
    };
  };
}

export function withRateLimit(options: {
  limit: number;
  windowMs: number;
  key?: (req: Request, ctx: ApiContext) => string;
  deadlineMs?: number;
  failOpenOnTimeout?: boolean;
  requireDistributedInProduction?: boolean;
  includeIp?: boolean;
}) {
  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      const ip =
        (req.headers.get('x-forwarded-for') || '').split(',')[0] || null;
      const defaultKey = `${
        new URL(req.url).pathname
      }:${req.method.toLowerCase()}`;
      const routeKey = options.key ? options.key(req, ctx) : defaultKey;
      const key =
        options.includeIp === false ? routeKey : rateLimitKey(ip, routeKey);
      let timedOut = false;
      let allowed = true;
      let resetAt = Date.now() + options.windowMs;
      let rateLimitBackend: 'distributed' | 'memory' = 'memory';

      if (options.failOpenOnTimeout && options.deadlineMs) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const fallback = new Promise<{
          allowed: boolean;
          remaining: number;
          resetAt: number;
          backend: 'memory';
          timedOut: true;
        }>((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve({
              allowed: true,
              remaining: Number.MAX_SAFE_INTEGER,
              resetAt: Date.now() + options.windowMs,
              backend: 'memory',
              timedOut: true,
            });
          }, options.deadlineMs);
        });

        const rateLimitResult = await Promise.race([
          allowRequest(key, options.limit, options.windowMs)
            .then((result) => ({ ...result, timedOut: false as const }))
            .catch((error) => {
              logger.warn('[apiRoute] rate limit failed open', {
                route: defaultKey,
                key,
                error: error instanceof Error ? error.message : String(error),
              });
              return {
                allowed: true,
                remaining: Number.MAX_SAFE_INTEGER,
                resetAt: Date.now() + options.windowMs,
                backend: 'memory' as const,
                timedOut: false as const,
              };
            }),
          fallback,
        ]);

        if (timeoutHandle) clearTimeout(timeoutHandle);
        allowed = rateLimitResult.allowed;
        resetAt = rateLimitResult.resetAt;
        rateLimitBackend = rateLimitResult.backend;
        timedOut = rateLimitResult.timedOut;
        if (timedOut) {
          logger.warn('[apiRoute] rate limit timed out; allowing request', {
            route: defaultKey,
            key,
            deadlineMs: options.deadlineMs,
          });
        }
      } else {
        const rateLimitResult = await allowRequest(
          key,
          options.limit,
          options.windowMs
        );
        allowed = rateLimitResult.allowed;
        resetAt = rateLimitResult.resetAt;
        rateLimitBackend = rateLimitResult.backend;
      }

      if (
        options.requireDistributedInProduction &&
        process.env.NODE_ENV === 'production' &&
        rateLimitBackend !== 'distributed'
      ) {
        logger.error(
          '[apiRoute] distributed rate limit unavailable for fail-closed route',
          { route: defaultKey }
        );
        return jsonError(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'Distributed rate limiting is temporarily unavailable',
          {
            retryAfter: 60,
            headers: { 'X-OrgX-RateLimit-Degraded': 'true' },
          }
        );
      }

      if (!allowed) {
        const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
        return jsonError(
          ApiErrorCode.RATE_LIMIT_EXCEEDED,
          'Too many requests',
          {
            retryAfter,
            headers: { 'Retry-After': String(retryAfter) },
          }
        );
      }
      const response = await handler(req, ctx);
      try {
        response.headers.set('X-OrgX-RateLimit-Scope', rateLimitBackend);
      } catch {
        // Some response implementations expose immutable headers.
      }
      if (timedOut) {
        try {
          response.headers.set('X-OrgX-RateLimit-Degraded', 'true');
        } catch {
          // Some response implementations expose immutable headers.
        }
      }
      return response;
    };
  };
}

function zodErrorDetails(error: z.ZodError): Record<string, unknown> {
  return { issues: error.issues, fieldErrors: error.flatten().fieldErrors };
}

function zodErrorMessage(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message || fallback;
}

// Validation Middleware
export function withValidation<B = any, Q = any, P = any>(schemas: {
  body?: z.Schema<B>;
  query?: z.Schema<Q>;
  params?: z.Schema<P>;
}) {
  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      let body = ctx.body;
      let query = ctx.query;
      let params = ctx.params;

      if (schemas.body) {
        const json = await req.json().catch(() => null);
        const parsed = schemas.body.safeParse(json);
        if (!parsed.success) {
          return jsonValidationError(
            zodErrorMessage(parsed.error, 'Invalid body'),
            zodErrorDetails(parsed.error)
          );
        }
        body = parsed.data;
      }

      if (schemas.query) {
        const url = new URL(req.url);
        const rawQuery: Record<string, string> = {};
        url.searchParams.forEach((val, key) => {
          rawQuery[key] = val;
        });
        const parsed = schemas.query.safeParse(rawQuery);
        if (!parsed.success) {
          return jsonValidationError(
            zodErrorMessage(parsed.error, 'Invalid query parameters'),
            zodErrorDetails(parsed.error)
          );
        }
        query = parsed.data;
      }

      if (schemas.params && ctx.params) {
        const parsed = schemas.params.safeParse(ctx.params);
        if (!parsed.success) {
          return jsonValidationError(
            zodErrorMessage(parsed.error, 'Invalid route parameters'),
            zodErrorDetails(parsed.error)
          );
        }
        params = parsed.data as Record<string, string | string[]>;
      }

      return handler(req, { ...ctx, body, query, params });
    };
  };
}

// Backward compatibility
export function withJsonBody<T>(options?: {
  schema?: {
    safeParse: (
      value: unknown
    ) => { success: true; data: T } | { success: false; error: unknown };
  };
}) {
  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      const json = await req.json().catch(() => null);
      if (options?.schema) {
        const parsed = options.schema.safeParse(json);
        if (!(parsed as any).success) {
          return jsonValidationError('Invalid body', {
            issues: (parsed as any).error,
          });
        }
        return handler(req, { ...ctx, body: (parsed as any).data });
      }
      return handler(req, { ...ctx, body: json });
    };
  };
}

export function withGlobalErrorHandling() {
  return (handler: ApiHandler): ApiHandler => {
    return async (req: Request, ctx: ApiContext) => {
      try {
        const response = await handler(req, ctx);

        // Add request ID to response headers
        const requestId = getCorrelationId();
        if (requestId && response instanceof NextResponse) {
          response.headers.set('X-Request-ID', requestId);
          // Also keep X-Correlation-ID for backward compatibility
          response.headers.set('X-Correlation-ID', requestId);
        }

        return response;
      } catch (error) {
        const requestId = getCorrelationId();
        const apiError = normalizeToApiError(error, requestId);

        const logPayload = {
          url: req.url,
          method: req.method,
          requestId,
          error: apiError.apiError.message,
          code: apiError.apiError.code,
          ...(apiError.statusCode >= 500 && error instanceof Error
            ? { stack: error.stack }
            : {}),
        };

        if (apiError.statusCode >= 500) {
          logger.error('API Route failed', logPayload);
        } else {
          logger.warn('API Route failed', logPayload);
        }

        // Use the wrapped format: { error: {...} }
        return jsonApiError(apiError);
      }
    };
  };
}

type NextRouteContext = {
  params: Promise<Record<string, string | string[]>>;
};

export function compose(
  ...wrappers: Array<(handler: ApiHandler) => ApiHandler>
) {
  return (handler: ApiHandler) => {
    const wrapped = wrappers.reduceRight((acc, wrap) => wrap(acc), handler);
    const withErrorHandling = withGlobalErrorHandling()(wrapped);

    // Composed handlers are also exported directly as Next route handlers.
    // Resolve framework params and initialize auth fields before middleware runs.
    return async (req: Request, ctx?: ApiContext | NextRouteContext) => {
      const apiContext: ApiContext =
        ctx && 'userId' in ctx
          ? ctx
          : {
              userId: null,
              externalUserId: null,
              email: null,
              fullName: null,
              params: ctx?.params ? await ctx.params : {},
            };
      if (hasRequestContext()) {
        return withErrorHandling(req, apiContext);
      }
      return runWithRequestContext(() => withErrorHandling(req, apiContext));
    };
  };
}

type RequireSupabaseUserSuccess = {
  response: null;
  supabase: SupabaseDbClient;
  user: SupabaseUser;
};

type RequireSupabaseUserFailure = {
  response: NextResponse;
  supabase?: undefined;
  user?: undefined;
};

export async function requireSupabaseUser(): Promise<
  RequireSupabaseUserSuccess | RequireSupabaseUserFailure
> {
  const supabase = await getRequestSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      response: jsonError(
        ApiErrorCode.AUTHENTICATION_ERROR,
        'Authentication required'
      ),
    };
  }

  return { response: null, supabase: supabase as SupabaseDbClient, user };
}

export async function enforceRateLimit(
  req: Request,
  options: {
    limit: number;
    windowMs: number;
    identifier?: string | ((req: Request) => string);
    entity?: string | ((req: Request) => string | null);
  }
): Promise<NextResponse | null> {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0] || null;
  const entityValue =
    typeof options.entity === 'function'
      ? options.entity(req)
      : options.entity ?? ip;
  const entity = entityValue ?? ip;
  const suffix =
    typeof options.identifier === 'function'
      ? options.identifier(req)
      : options.identifier ??
        `${new URL(req.url).pathname}:${req.method.toLowerCase()}`;
  const key = rateLimitKey(entity, suffix);
  const { allowed, resetAt } = await allowRequest(
    key,
    options.limit,
    options.windowMs
  );
  if (allowed) {
    return null;
  }

  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
  return jsonError(ApiErrorCode.RATE_LIMIT_EXCEEDED, 'Too many requests', {
    retryAfter,
    headers: { 'Retry-After': String(retryAfter) },
  });
}

function apiCodeForStatus(status: number): ApiErrorCode {
  if (status === 400) return ApiErrorCode.BAD_REQUEST;
  if (status === 401) return ApiErrorCode.AUTHENTICATION_ERROR;
  if (status === 403) return ApiErrorCode.AUTHORIZATION_ERROR;
  if (status === 404) return ApiErrorCode.NOT_FOUND;
  if (status === 409) return ApiErrorCode.CONFLICT;
  if (status === 429) return ApiErrorCode.RATE_LIMIT_EXCEEDED;
  if (status === 424 || status === 502) return ApiErrorCode.INTEGRATION_ERROR;
  if (status === 503) return ApiErrorCode.SERVICE_UNAVAILABLE;
  if (status === 504) return ApiErrorCode.TIMEOUT;
  return ApiErrorCode.INTERNAL_ERROR;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function respondWithError(
  logMessage: string,
  error: unknown,
  options: {
    status?: number;
    publicMessage?: string;
    context?: Record<string, unknown>;
  } = {}
) {
  const {
    status = 500,
    publicMessage = 'Internal server error',
    context = {},
  } = options;
  logger.error(logMessage, { ...context, error: toErrorMessage(error) });
  return jsonError(apiCodeForStatus(status), publicMessage, { status });
}
