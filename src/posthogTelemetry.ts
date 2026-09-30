import { sanitizeWorkerTelemetryProperties } from './workerTelemetryPrivacy';

export type PosthogTelemetryEnv = {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  MCP_SERVER_URL?: string;
  SENTRY_RELEASE?: string;
  CF_VERSION_METADATA?: { id?: string };
};

const TELEMETRY_SCHEMA_VERSION = '2026-09-30';
const CAPTURE_TIMEOUT_MS = 2000;

type WaitUntilLike = {
  waitUntil?: (promise: Promise<unknown>) => unknown;
};

export function resolveAnonymousDistinctId(ctx: unknown): string {
  try {
    const id = (ctx as { id?: { toString?: () => string } })?.id?.toString?.();
    if (typeof id === 'string' && id.length > 0) return `mcp:${id}`;
  } catch {
    // ignore
  }
  return 'mcp:anonymous';
}

export function captureWorkerPosthogEvent(params: {
  env: PosthogTelemetryEnv;
  ctx?: WaitUntilLike | null;
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  serverVersion?: string;
}): void {
  try {
    const apiKey = params.env.POSTHOG_KEY;
    if (!apiKey || apiKey === 'test-posthog-key') return;

    const host = (
      params.env.POSTHOG_HOST || 'https://us.i.posthog.com'
    ).replace(/\/+$/, '');

    const sentAt = new Date().toISOString();
    const eventProperties: Record<string, unknown> = {
      ...sanitizeWorkerTelemetryProperties(params.properties),
      $lib: 'orgx-mcp',
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      surface: 'mcp',
      event_origin: 'cloudflare_worker',
      environment: params.env.MCP_SERVER_URL?.includes('staging')
        ? 'preview'
        : 'production',
    };

    const release = params.env.SENTRY_RELEASE;
    const workerVersion = params.env.CF_VERSION_METADATA?.id;
    if (release && /^[0-9a-f]{7,40}$/i.test(release)) {
      eventProperties.release = release;
      eventProperties.release_source = 'sentry_release';
    } else if (workerVersion && /^[0-9a-f-]{36}$/i.test(workerVersion)) {
      eventProperties.release = workerVersion;
      eventProperties.release_source = 'cloudflare_version';
    } else {
      eventProperties.release_source = 'unknown';
    }
    const eventId = crypto.randomUUID();
    eventProperties.event_id = eventId;

    if (params.serverVersion) {
      eventProperties.$lib_version = params.serverVersion;
      eventProperties.mcp_server_version = params.serverVersion;
    }

    const payload = {
      api_key: apiKey,
      batch: [
        {
          type: 'capture',
          uuid: eventId,
          event: params.event,
          distinct_id: params.distinctId,
          properties: eventProperties,
          timestamp: sentAt,
        },
      ],
      sent_at: sentAt,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
    const request = fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          console.warn('[telemetry] PostHog capture rejected', {
            event: params.event,
            status: response.status,
          });
        }
      })
      .catch(() => {
        console.warn('[telemetry] PostHog capture unavailable', { event: params.event });
      })
      .finally(() => clearTimeout(timeout));

    params.ctx?.waitUntil?.(request);
  } catch {
    // ignore
  }
}
