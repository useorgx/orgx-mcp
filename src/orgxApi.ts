export interface OrgxApiEnv {
  ORGX_API_URL: string;
  ORGX_API_FALLBACK_URL?: string;
  ORGX_SERVICE_KEY: string;
  ORGX_INTERNAL_SECRET?: string;
}

const ORGX_API_TIMEOUT_MS = 30_000;
const ACTOR_TOKEN_TTL_MS = 5 * 60 * 1000;
const ACTOR_TOKEN_TYPE = 'orgx.mcp.actor.v1';
const ACTOR_TOKEN_AUD = 'orgx-api';

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
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
  secret: string;
}): Promise<string> {
  const now = Date.now();
  const payload = {
    type: ACTOR_TOKEN_TYPE,
    aud: ACTOR_TOKEN_AUD,
    iss: 'orgx-mcp',
    sub: opts.userId,
    ...(opts.userEmail ? { email: opts.userEmail.trim().toLowerCase() } : {}),
    iat: now,
    exp: now + ACTOR_TOKEN_TTL_MS,
  };
  const encoder = new TextEncoder();
  const payloadB64 = base64Url(encoder.encode(JSON.stringify(payload)).buffer);
  const key = await importHmacKey(opts.secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  return `${payloadB64}.${base64Url(signature)}`;
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

function shouldTryFallbackForStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
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
  opts?: { accept?: string; userId?: string | null; userEmail?: string | null }
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
        secret: env.ORGX_INTERNAL_SECRET,
      })
    );
  }
  // Legacy compatibility for older API routes. New routes should verify
  // X-Orgx-Actor-Token instead of trusting this unsigned identity hint.
  if (opts?.userId) {
    headers.set('X-Orgx-User-Id', opts.userId);
  }
  if (opts?.userEmail) {
    headers.set('X-Orgx-User-Email', opts.userEmail);
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
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(`timeout after ${ORGX_API_TIMEOUT_MS}ms`);
    }, ORGX_API_TIMEOUT_MS);
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
          lastRetryableFailure = `Request timed out after ${ORGX_API_TIMEOUT_MS}ms for ${url.toString()}`;
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
        await response.text().catch(() => 'Unable to read error body')
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
  opts?: { userId?: string | null; userEmail?: string | null }
) {
  const response = await callOrgxApiRaw(env, path, init, {
    accept: 'application/json',
    userId: opts?.userId ?? undefined,
    userEmail: opts?.userEmail ?? undefined,
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = truncateForErrorBody(
      await response.text().catch(() => 'Unable to read non-JSON body')
    );
    throw createApiError(
      'Received an unexpected response from OrgX. Please try again.',
      `Non-JSON response (${contentType || 'unknown content-type'}) from ${
        response.url
      }: ${text}`
    );
  }
  return response;
}
