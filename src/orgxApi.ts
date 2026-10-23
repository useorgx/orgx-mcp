import { ApiRequestObservation, currentApiReferences, observedApiFetch, recordApiBody, withResponseDiagnostics } from './apiDiagnostics';
import { markTransportFailure } from './remedyErrors';

export interface OrgxApiEnv {
  ORGX_API_URL: string;
  ORGX_API_FALLBACK_URL?: string;
  ORGX_SERVICE_KEY: string;
  ORGX_INTERNAL_SECRET?: string;
  ORGX_API_TIMEOUT_MS?: string;
  ORGX_API_PRIMARY_TIMEOUT_MS?: string;
  ORGX_BILLING_PLAN_TIMEOUT_MS?: string;
}

const DEFAULT_ORGX_API_TIMEOUT_MS = 30_000;
const DEFAULT_ORGX_API_PRIMARY_TIMEOUT_MS = 5_000;
const ACTOR_TOKEN_TTL_MS = 5 * 60 * 1000;
const ACTOR_TOKEN_CACHE_SKEW_MS = 30_000;
const ACTOR_TOKEN_CACHE_MAX_ENTRIES = 500;
const ACTOR_TOKEN_TYPE = 'orgx.mcp.actor.v1';
const ACTOR_TOKEN_AUD = 'orgx-api';

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();
const actorTokenCache = new Map<string, { token: string; expiresAt: number }>();
const responseOrigin = new WeakMap<Response, string>();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const cached = hmacKeyCache.get(secret);
  if (cached) return cached;

  const promise = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  hmacKeyCache.set(secret, promise);
  try {
    return await promise;
  } catch (error) {
    hmacKeyCache.delete(secret);
    throw error;
  }
}

function base64Url(input: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(input)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Delegation claims for run-token sessions: the agent run and workspace the
 * call is bound to, and the run's granted tool scopes. The API refuses calls
 * for a run that has ended or belongs to someone else, and pins the workspace.
 */
export type GatewayDelegationClaims = {
  runId?: string | null;
  workspaceId?: string | null;
  scopes?: readonly string[] | null;
};

async function signGatewayActorToken(
  opts: {
    userId: string;
    userEmail?: string | null;
    orgxUserId?: string | null;
    secret: string;
  } & GatewayDelegationClaims
): Promise<string> {
  const now = Date.now();
  const normalizedEmail = opts.userEmail?.trim().toLowerCase() ?? '';
  const orgxUserId = opts.orgxUserId ?? '';
  const runId = opts.runId?.trim() ?? '';
  const workspaceId = runId ? opts.workspaceId?.trim() ?? '' : '';
  const scopes = runId && opts.scopes ? [...opts.scopes] : null;
  const cacheKey = `${opts.secret}::${opts.userId}::${normalizedEmail}::${orgxUserId}::${runId}::${workspaceId}::${scopes?.join(',') ?? ''}`;
  const cached = actorTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  const payload = {
    type: ACTOR_TOKEN_TYPE,
    aud: ACTOR_TOKEN_AUD,
    iss: 'orgx-mcp',
    sub: opts.userId,
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
    // The internal Supabase UUID, when the session carries one. The API uses it
    // as a verified fast path (existence + email cross-check) and falls back to
    // resolving `sub` (Clerk id) + email when it is absent or disagrees.
    ...(orgxUserId ? { orgx_user_id: orgxUserId } : {}),
    ...(runId ? { rid: runId } : {}),
    ...(workspaceId ? { wid: workspaceId } : {}),
    ...(scopes ? { scp: scopes } : {}),
    iat: now,
    exp: now + ACTOR_TOKEN_TTL_MS,
  };
  const encoder = new TextEncoder();
  const payloadB64 = base64Url(encoder.encode(JSON.stringify(payload)).buffer);
  const key = await importHmacKey(opts.secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const token = `${payloadB64}.${base64Url(signature)}`;
  actorTokenCache.set(cacheKey, {
    token,
    expiresAt: payload.exp - ACTOR_TOKEN_CACHE_SKEW_MS,
  });
  if (actorTokenCache.size > ACTOR_TOKEN_CACHE_MAX_ENTRIES) {
    actorTokenCache.delete(actorTokenCache.keys().next().value as string);
  }
  return token;
}

function truncateForErrorBody(input: string, max = 2000) {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n…(truncated ${input.length - max} chars)`;
}

function looksLikeDefaultPlaceholder(value: string | undefined) {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return (
    v === 'set-me' ||
    v === 'replace-me' ||
    v === 'change-me' ||
    v.startsWith('change-me-')
  );
}

/**
 * Canonicalize the OrgX API origin so redirecting aliases cannot turn every
 * authenticated MCP request into a hard failure. Invalid values pass through
 * unchanged for the existing configuration error to report.
 */
export function canonicalizeOrgxApiBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.hostname.startsWith('www.')) url.hostname = url.hostname.slice(4);
    return url.toString().replace(/\/+$/, '');
  } catch {
    return value;
  }
}

function getOrgxApiBaseUrls(env: OrgxApiEnv): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of [env.ORGX_API_URL, env.ORGX_API_FALLBACK_URL]) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const canonical = canonicalizeOrgxApiBaseUrl(trimmed);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    urls.push(canonical);
  }
  return urls;
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getRequestTimeoutMs(
  env: OrgxApiEnv,
  hasFallbackRemaining: boolean
): number {
  if (hasFallbackRemaining) {
    return parseTimeoutMs(
      env.ORGX_API_PRIMARY_TIMEOUT_MS,
      DEFAULT_ORGX_API_PRIMARY_TIMEOUT_MS
    );
  }
  return parseTimeoutMs(env.ORGX_API_TIMEOUT_MS, DEFAULT_ORGX_API_TIMEOUT_MS);
}

async function readResponseTextWithTimeout(
  response: Response,
  timeoutMs: number,
  upstreamUrl: string
): Promise<string> {
  if (!response.body) return '';

  const bodyStarted = performance.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(
        markTransportFailure(createApiError(
          'The request took too long. Please try again.',
          `Response body timed out after ${timeoutMs}ms for ${upstreamUrl}`
        ), 'timeout')
      );
    }, timeoutMs);
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (value) body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (timedOut) {
      void reader
        .cancel('OrgX API response body timed out')
        .catch(() => undefined);
    }
    reader.releaseLock();
    recordApiBody(response, Math.max(0, Math.round(performance.now() - bodyStarted)), timedOut);
  }
}

const RETRY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Safe to send twice: a read, or a write the API deduplicates by key. */
export function isRetrySafe(method: string | undefined, headers: Headers): boolean {
  return (
    RETRY_SAFE_METHODS.has((method ?? 'GET').toUpperCase()) ||
    headers.has('Idempotency-Key')
  );
}

function shouldTryFallbackForStatus(status: number): boolean {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 524)
  );
}

function expectedResponseMediaType(accept: string | undefined): string | null {
  if (!accept) return null;
  const normalized = accept.toLowerCase();
  if (normalized.includes('application/json')) return 'application/json';
  if (normalized.includes('text/event-stream')) return 'text/event-stream';
  return null;
}

/**
 * Error class for OrgX API errors with separate user-facing and internal messages.
 * The `message` property contains a user-friendly error that's safe to expose.
 * The `internalDetails` contains technical info logged but not shown to users.
 */
/** Structured fields an OrgX API error body may carry beyond its message. */
export interface OrgXApiErrorStructure {
  /** Machine-readable backend code, e.g. `approval_required` or `version_conflict`. */
  backendCode?: string;
  /** Structured backend details (approver, scope, limits, versions...). */
  backendDetails?: Record<string, unknown>;
  /** Parsed `Retry-After` response header, in seconds. */
  retryAfterSeconds?: number;
}

export class OrgXApiError extends Error {
  readonly internalDetails: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly backendCode?: string;
  readonly backendDetails?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    userMessage: string,
    internalDetails: string,
    statusCode?: number,
    structure: OrgXApiErrorStructure = {}
  ) {
    super(userMessage);
    this.name = 'OrgXApiError';
    this.internalDetails = internalDetails;
    this.statusCode = statusCode;
    this.backendCode = structure.backendCode;
    this.backendDetails = structure.backendDetails;
    this.retryAfterSeconds = structure.retryAfterSeconds;
    const references = currentApiReferences();
    this.requestId = references.request_id;
    this.traceId = references.trace_id;
  }
}

/**
 * Log error details to console and return user-friendly error.
 */
export function createApiError(
  userMessage: string,
  internalDetails: string,
  statusCode?: number,
  structure?: OrgXApiErrorStructure
): OrgXApiError {
  console.error(JSON.stringify({ event: 'orgx_api_error', ...currentApiReferences(), status: statusCode ?? 0 }));
  return new OrgXApiError(userMessage, internalDetails, statusCode, structure);
}

const BACKEND_CODE_RE = /^[a-z][a-z0-9_.:-]{0,79}$/i;

/** Read the machine-readable code and details from a parsed error body. */
export function parseBackendErrorStructure(parsed: unknown): Pick<OrgXApiErrorStructure, 'backendCode' | 'backendDetails'> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const body = parsed as Record<string, unknown>;
  const nested = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : null;
  const code = [nested?.code, body.code, body.error_code, nested?.type]
    .find((value): value is string => typeof value === 'string' && BACKEND_CODE_RE.test(value.trim()));
  const details: Record<string, unknown> = {};
  for (const source of [body, nested, body.details, nested?.details]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (key === 'error' || key === 'message' || key === 'details' || key === 'stack' || key === 'code' || key === 'error_code') continue;
      if (details[key] === undefined) details[key] = value;
    }
  }
  return {
    ...(code ? { backendCode: code.trim().toLowerCase() } : {}),
    ...(Object.keys(details).length ? { backendDetails: details } : {}),
  };
}

/** Parse a Retry-After header (delta seconds or HTTP date). */
export function parseRetryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

export async function callOrgxApiRaw(
  env: OrgxApiEnv,
  path: string,
  init?: RequestInit,
  opts?: {
    accept?: string;
    userId?: string | null;
    userEmail?: string | null;
    orgxUserId?: string | null;
    runId?: string | null;
    workspaceId?: string | null;
    scopes?: readonly string[] | null;
    /**
     * Retry a configured secondary API origin when the primary is unavailable.
     * Disable this for non-idempotent operations that must fail closed rather
     * than risk executing against a different release or data plane.
     */
    allowFallback?: boolean;
  }
) {
  const headers = new Headers(init?.headers);
  const observation = new ApiRequestObservation(headers);
  return observation.run(async () => {
    try {
      return await callOrgxApiRawImplementation(env, path, { ...init, headers }, opts);
    } catch (error) {
      observation.failure(undefined, error instanceof OrgXApiError ? error.statusCode : undefined);
      throw error;
    }
  });
}

async function callOrgxApiRawImplementation(
  env: OrgxApiEnv, path: string, init: RequestInit,
  opts: Parameters<typeof callOrgxApiRaw>[3]
) {
  if (
    looksLikeDefaultPlaceholder(env.ORGX_SERVICE_KEY) ||
    !env.ORGX_SERVICE_KEY.startsWith('oxk-')
  ) {
    throw createApiError(
      'The OrgX service is not properly configured. Please contact your administrator.',
      'ORGX_SERVICE_KEY is not set or invalid (must start with "oxk-")'
    );
  }

  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${env.ORGX_SERVICE_KEY}`);
  if (opts?.userId && env.ORGX_INTERNAL_SECRET) {
    headers.set(
      'X-Orgx-Actor-Token',
      await signGatewayActorToken({
        userId: opts.userId,
        userEmail: opts.userEmail,
        orgxUserId: opts.orgxUserId,
        runId: opts.runId,
        workspaceId: opts.workspaceId,
        scopes: opts.scopes,
        secret: env.ORGX_INTERNAL_SECRET,
      })
    );
  }
  // Legacy compatibility for older API routes. New routes should verify
  // X-Orgx-Actor-Token instead of trusting these unsigned identity hints.
  if (opts?.userId) {
    headers.set('X-Orgx-User-Id', opts.userId);
  }
  if (opts?.userEmail) {
    headers.set('X-Orgx-User-Email', opts.userEmail);
  }
  // The login-resolved internal Supabase UUID (additive — X-Orgx-User-Id stays
  // the Clerk id). Trusted only behind service-key auth, like the headers above;
  // the API verifies it (existence + email cross-check) before using it.
  if (opts?.orgxUserId) {
    headers.set('X-Orgx-Orgx-User-Id', opts.orgxUserId);
  }
  if (!headers.has('Accept') && opts?.accept)
    headers.set('Accept', opts.accept);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }

  const configuredBaseUrls = getOrgxApiBaseUrls(env);
  // A request that may already have reached the primary is only re-sent when
  // repeating it is safe. A timed-out or 5xx POST (e.g. spawn) has often done
  // its work; re-sending it to the fallback risks doing it twice and reports
  // the fallback's failure for work that succeeded.
  const baseUrls =
    opts?.allowFallback === false || !isRetrySafe(init?.method, headers)
      ? configuredBaseUrls.slice(0, 1)
      : configuredBaseUrls;
  let lastRetryableFailure: string | null = null;
  let lastRetryableStatus: number | undefined;

  for (const [index, baseUrl] of baseUrls.entries()) {
    const isFallbackAttempt = index > 0;
    const hasFallbackRemaining = index < baseUrls.length - 1;
    const url = new URL(path, baseUrl);

    // IMPORTANT: do not auto-follow redirects; a common prod misconfig is redirecting /api/* to a different host.
    const controller = new AbortController();
    let timedOut = false;
    const requestTimeoutMs = getRequestTimeoutMs(env, hasFallbackRemaining);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(`timeout after ${requestTimeoutMs}ms`);
    }, requestTimeoutMs);
    const upstreamSignal = init?.signal ?? null;
    const forwardAbort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        controller.abort(upstreamSignal.reason);
      } else {
        upstreamSignal.addEventListener(
          'abort',
          forwardAbort,
          { once: true }
        );
      }
    }

    let response: Response;
    try {
      response = await observedApiFetch(url.toString(), {
        ...init,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      }, isFallbackAttempt);
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        if (timedOut) {
          lastRetryableFailure = `Request timed out after ${requestTimeoutMs}ms for ${url.toString()}`;
          if (hasFallbackRemaining) {
            console.warn('[orgx-api] trying fallback', currentApiReferences());
            continue;
          }
          throw markTransportFailure(createApiError(
            'The request took too long. Please try again.',
            lastRetryableFailure
          ), 'timeout');
        }
        throw createApiError(
          'The request was cancelled.',
          `Request aborted for ${url.toString()}`
        );
      }
      lastRetryableFailure = `Network error for ${url.toString()}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (hasFallbackRemaining) {
        console.warn('[orgx-api] trying fallback', currentApiReferences());
        continue;
      }
      throw markTransportFailure(error, 'network');
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', forwardAbort);
    }

    if (
      hasFallbackRemaining &&
      shouldTryFallbackForStatus(response.status)
    ) {
      lastRetryableFailure = `API ${response.status} from ${url.toString()}`;
      lastRetryableStatus = response.status;
      console.warn('[orgx-api] trying fallback', currentApiReferences());
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      throw createApiError(
        'Unable to connect to OrgX. The service configuration needs to be updated by your administrator.',
        `Redirect detected (${response.status}): ${url.toString()}${
          location ? ` → ${location}` : ''
        }. ` +
          'ORGX_API_URL likely points to a domain with redirect rules (e.g. apex→www).',
        response.status
      );
    }

    if (!response.ok) {
      const text = truncateForErrorBody(
        await readResponseTextWithTimeout(
          response,
          requestTimeoutMs,
          url.toString()
        ).catch((error) => {
          if (error instanceof OrgXApiError) throw error;
          return 'Unable to read error body';
        })
      );
      let parsedMessage: string | null = null;
      let structure: OrgXApiErrorStructure = {
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('retry-after')),
      };
      try {
        const parsed = JSON.parse(text) as {
          error?: string | { code?: string; message?: string };
          message?: string;
        };
        structure = { ...structure, ...parseBackendErrorStructure(parsed) };
        // Handle string error: { "error": "Something went wrong" }
        if (typeof parsed?.error === 'string' && parsed.error.trim()) {
          parsedMessage = parsed.error.trim();
        }
        // Handle nested error object: { "error": { "code": "...", "message": "..." } }
        else if (
          typeof parsed?.error === 'object' &&
          parsed.error !== null &&
          typeof parsed.error.message === 'string' &&
          parsed.error.message.trim()
        ) {
          parsedMessage = parsed.error.message.trim();
        }
        // Handle top-level message: { "message": "Something went wrong" }
        else if (typeof parsed?.message === 'string' && parsed.message.trim()) {
          parsedMessage = parsed.message.trim();
        }
      } catch {
        parsedMessage = null;
      }

      // Map status codes to user-friendly messages
      let userMessage: string;
      if (response.status === 401 || response.status === 403) {
        userMessage = 'Access denied. Please check your authentication.';
      } else if (response.status === 404) {
        userMessage = 'The requested resource was not found.';
      } else if (response.status >= 500) {
        userMessage = 'OrgX is temporarily unavailable. Please try again later.';
      } else {
        userMessage = 'Unable to complete the request. Please try again.';
      }

      if (parsedMessage) {
        userMessage = parsedMessage;
      }

      throw createApiError(
        userMessage,
        `API ${response.status} from ${url.toString()}: ${text}`,
        response.status,
        structure
      );
    }

    const expectedMediaType = expectedResponseMediaType(opts?.accept);
    const actualMediaType =
      response.headers.get('content-type')?.toLowerCase() ?? '';
    if (
      isFallbackAttempt &&
      response.ok &&
      expectedMediaType &&
      !actualMediaType.includes(expectedMediaType)
    ) {
      throw createApiError(
        'OrgX is temporarily unavailable. Please try again later.',
        `${lastRetryableFailure ?? 'Primary OrgX API request failed'}; ` +
          `fallback ${url.toString()} returned ${
            actualMediaType || 'an unknown content type'
          } instead of ${expectedMediaType}`,
        lastRetryableStatus
      );
    }

    if (isFallbackAttempt && lastRetryableFailure) {
      console.warn(
        '[orgx-api] fallback succeeded', currentApiReferences()
      );
    }
    responseOrigin.set(response, url.origin);
    return response;
  }

  // With no base URL there was nothing to call: that is a server setup
  // problem, not an outage, and retrying will not help.
  if (!lastRetryableFailure) {
    throw createApiError(
      'This OrgX connection is not configured. Retrying will not help; your administrator needs to set the OrgX API URL.',
      'No OrgX API base URL was configured'
    );
  }

  throw createApiError(
    'OrgX is temporarily unavailable. Please try again later.',
    lastRetryableFailure
  );
}

export async function callOrgxApiJson(
  env: OrgxApiEnv,
  path: string,
  init?: RequestInit,
  opts?: {
    userId?: string | null;
    userEmail?: string | null;
    orgxUserId?: string | null;
    allowFallback?: boolean;
  } & GatewayDelegationClaims
) {
  const response = await callOrgxApiRaw(env, path, init, {
    accept: 'application/json',
    userId: opts?.userId ?? undefined,
    userEmail: opts?.userEmail ?? undefined,
    orgxUserId: opts?.orgxUserId ?? undefined,
    runId: opts?.runId,
    workspaceId: opts?.workspaceId,
    scopes: opts?.scopes,
    allowFallback: opts?.allowFallback,
  });
  const resolvedOrigin =
    responseOrigin.get(response) ??
    new URL(response.url || env.ORGX_API_URL).origin;
  const resolvedUrl = response.url || new URL(path, resolvedOrigin).toString();
  const contentType = response.headers.get('content-type') ?? '';
  const responseBody = await withResponseDiagnostics(response, () => readResponseTextWithTimeout(
    response,
    parseTimeoutMs(env.ORGX_API_TIMEOUT_MS, DEFAULT_ORGX_API_TIMEOUT_MS),
    resolvedUrl
  ));
  if (!contentType.includes('application/json')) {
    const text = truncateForErrorBody(responseBody);
    throw createApiError(
      'Received an unexpected response from OrgX. Please try again.',
      `Non-JSON response (${contentType || 'unknown content-type'}) from ${
        response.url
      }: ${text}`
    );
  }
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('X-Orgx-Upstream-Origin', resolvedOrigin);
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * @internal test helper
 */
export function _clearOrgxApiCachesForTests(): void {
  hmacKeyCache.clear();
  actorTokenCache.clear();
}
