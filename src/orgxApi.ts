export interface OrgxApiEnv {
  ORGX_API_URL: string;
  ORGX_API_FALLBACK_URL?: string;
  ORGX_SERVICE_KEY: string;
  ORGX_INTERNAL_SECRET?: string;
  ORGX_API_TIMEOUT_MS?: string;
  ORGX_API_PRIMARY_TIMEOUT_MS?: string;
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

async function signGatewayActorToken(opts: {
  userId: string;
  userEmail?: string | null;
  orgxUserId?: string | null;
  secret: string;
}): Promise<string> {
  const now = Date.now();
  const normalizedEmail = opts.userEmail?.trim().toLowerCase() ?? '';
  const orgxUserId = opts.orgxUserId ?? '';
  const cacheKey = `${opts.secret}::${opts.userId}::${normalizedEmail}::${orgxUserId}`;
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

function getOrgxApiBaseUrls(env: OrgxApiEnv): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of [env.ORGX_API_URL, env.ORGX_API_FALLBACK_URL]) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(
        createApiError(
          'The request took too long. Please try again.',
          `Response body timed out after ${timeoutMs}ms for ${upstreamUrl}`
        )
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
  }
}

function shouldTryFallbackForStatus(status: number): boolean {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 524)
  );
}

/**
 * Error class for OrgX API errors with separate user-facing and internal messages.
 * The `message` property contains a user-friendly error that's safe to expose.
 * The `internalDetails` contains technical info logged but not shown to users.
 */
export class OrgXApiError extends Error {
  readonly internalDetails: string;
  readonly statusCode?: number;

  constructor(
    userMessage: string,
    internalDetails: string,
    statusCode?: number
  ) {
    super(userMessage);
    this.name = 'OrgXApiError';
    this.internalDetails = internalDetails;
    this.statusCode = statusCode;
  }
}

/**
 * Log error details to console and return user-friendly error.
 */
export function createApiError(
  userMessage: string,
  internalDetails: string,
  statusCode?: number
): OrgXApiError {
  console.error(`[orgx-api] ${internalDetails}`);
  return new OrgXApiError(userMessage, internalDetails, statusCode);
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
  }
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

  const baseUrls = getOrgxApiBaseUrls(env);
  let lastRetryableFailure: string | null = null;

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
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        controller.abort(upstreamSignal.reason);
      } else {
        upstreamSignal.addEventListener(
          'abort',
          () => controller.abort(upstreamSignal.reason),
          { once: true }
        );
      }
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...init,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        if (timedOut) {
          lastRetryableFailure = `Request timed out after ${requestTimeoutMs}ms for ${url.toString()}`;
          if (hasFallbackRemaining) {
            console.warn(`[orgx-api] ${lastRetryableFailure}; trying fallback`);
            continue;
          }
          throw createApiError(
            'The request took too long. Please try again.',
            lastRetryableFailure
          );
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
        console.warn(`[orgx-api] ${lastRetryableFailure}; trying fallback`);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (
      hasFallbackRemaining &&
      shouldTryFallbackForStatus(response.status)
    ) {
      lastRetryableFailure = `API ${response.status} from ${url.toString()}`;
      console.warn(`[orgx-api] ${lastRetryableFailure}; trying fallback`);
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
      try {
        const parsed = JSON.parse(text) as {
          error?: string | { code?: string; message?: string };
          message?: string;
        };
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
        response.status
      );
    }

    if (isFallbackAttempt && lastRetryableFailure) {
      console.warn(
        `[orgx-api] Fallback succeeded for ${url.toString()} after ${lastRetryableFailure}`
      );
    }
    return response;
  }

  throw createApiError(
    'OrgX is temporarily unavailable. Please try again later.',
    lastRetryableFailure ?? 'No OrgX API base URL was configured'
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
  }
) {
  const response = await callOrgxApiRaw(env, path, init, {
    accept: 'application/json',
    userId: opts?.userId ?? undefined,
    userEmail: opts?.userEmail ?? undefined,
    orgxUserId: opts?.orgxUserId ?? undefined,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const responseBody = await readResponseTextWithTimeout(
    response,
    parseTimeoutMs(env.ORGX_API_TIMEOUT_MS, DEFAULT_ORGX_API_TIMEOUT_MS),
    response.url || new URL(path, env.ORGX_API_URL).toString()
  );
  if (!contentType.includes('application/json')) {
    const text = truncateForErrorBody(responseBody);
    throw createApiError(
      'Received an unexpected response from OrgX. Please try again.',
      `Non-JSON response (${contentType || 'unknown content-type'}) from ${
        response.url
      }: ${text}`
    );
  }
  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * @internal test helper
 */
export function _clearOrgxApiCachesForTests(): void {
  hmacKeyCache.clear();
  actorTokenCache.clear();
}
