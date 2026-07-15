import * as Sentry from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';

export interface SentryWorkerEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  CF_VERSION_METADATA?: {
    id?: string;
    tag?: string;
    timestamp?: string;
  };
}

const SENSITIVE_KEY =
  /(?:^|[_-])(authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|session|prompt|input|output|completion|model[_-]?(?:input|output))(?:$|[_-])/i;

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\boxk_[A-Za-z0-9_-]+\b/g, 'oxk_[redacted]')
    .replace(/\bsntrys_[A-Za-z0-9_-]+\b/g, 'sntrys_[redacted]')
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    );
}

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? '[redacted]'
      : sanitize(entry, depth + 1);
  }
  return sanitized;
}

function parseSampleRate(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.1;
}

export function createSentryOptions(
  env: SentryWorkerEnv
): CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;

  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || 'production',
    release:
      env.SENTRY_RELEASE ||
      `orgx-mcp@${env.CF_VERSION_METADATA?.id || '1.1.0'}`,
    tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
    enableLogs: true,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 3,
    },
    enableRpcTracePropagation: true,
    beforeBreadcrumb: (breadcrumb) =>
      breadcrumb.category === 'console'
        ? null
        : (sanitize(breadcrumb) as typeof breadcrumb),
    beforeSend(event) {
      const sanitized = sanitize(event) as typeof event;
      sanitized.user = undefined;
      if (sanitized.request) {
        sanitized.request.headers = undefined;
        sanitized.request.cookies = undefined;
        sanitized.request.data = undefined;
        sanitized.request.query_string = undefined;
        if (sanitized.request.url) {
          sanitized.request.url = sanitized.request.url.split(/[?#]/, 1)[0];
        }
      }
      return sanitized;
    },
    beforeSendTransaction(event) {
      return sanitize(event) as typeof event;
    },
    beforeSendLog(log) {
      return sanitize(log) as typeof log;
    },
  };
}
