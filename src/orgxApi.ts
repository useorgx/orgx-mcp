export interface OrgxApiEnv {
  ORGX_API_URL: string;
  ORGX_SERVICE_KEY: string;
}

const ORGX_API_TIMEOUT_MS = 30_000;

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
  opts?: { accept?: string; userId?: string | null }
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

  const url = new URL(path, env.ORGX_API_URL);
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${env.ORGX_SERVICE_KEY}`);
  // Propagate authenticated user identity to the API.
  // The API trusts this header only when the service key is also valid.
  if (opts?.userId) {
    headers.set('X-Orgx-User-Id', opts.userId);
  }
  if (!headers.has('Accept') && opts?.accept)
    headers.set('Accept', opts.accept);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }

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
    if (controller.signal.aborted) {
      if (timedOut) {
        throw createApiError(
          'The request took too long. Please try again.',
          `Request timed out after ${ORGX_API_TIMEOUT_MS}ms for ${url.toString()}`
        );
      }
      throw createApiError(
        'The request was cancelled.',
        `Request aborted for ${url.toString()}`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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

  return response;
}

export async function callOrgxApiJson(
  env: OrgxApiEnv,
  path: string,
  init?: RequestInit,
  opts?: { userId?: string | null }
) {
  const response = await callOrgxApiRaw(env, path, init, {
    accept: 'application/json',
    userId: opts?.userId ?? undefined,
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
