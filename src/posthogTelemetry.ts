import { exportPosthogDiagnostic } from './posthogDiagnostics';
import { sanitizeWorkerTelemetryProperties } from './workerTelemetryPrivacy';
import { canonicalAccountId, invocationOutcome, TELEMETRY_SCHEMA_VERSION, TELEMETRY_LIMITS, telemetryAudience } from './telemetryContract';

export type PosthogTelemetryEnv = {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  ORGX_TELEMETRY_AUDIENCE?: string;
  ORGX_TELEMETRY_DISABLED?: string;
  ORGX_POSTHOG_LOGS_ENABLED?: string;
  ORGX_TELEMETRY_ENVIRONMENT?: string;
  MCP_SERVER_URL?: string;
  SENTRY_RELEASE?: string;
  CF_VERSION_METADATA?: { id?: string };
};

const CAPTURE_TIMEOUT_MS = TELEMETRY_LIMITS.timeoutMs;
const pending = new WeakMap<object, number>();
export const workerTelemetryHealth = { delivered: 0, failed: 0, dropped: 0 };


type WaitUntilLike = {
  props?: { telemetryOptOut?: unknown };
  waitUntil?: (promise: Promise<unknown>) => unknown;
};

export function resolveAnonymousDistinctId(ctx: unknown): string {
  try {
    const id = (ctx as { id?: { toString?: () => string } })?.id?.toString?.();
    if (typeof id === 'string' && id.length > 0) return `mcp:${id}`;
  } catch {
    // ignore
  }
  return `mcp:${crypto.randomUUID()}`;
}

export function captureWorkerPosthogEvent(params: {
  env: PosthogTelemetryEnv;
  ctx?: WaitUntilLike | null;
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  serverVersion?: string;
  /** Membership/credential-admitted scope only; never raw tool arguments. */
  workspaceId?: string;
  optOut?: boolean;
}): void {
  try {
    const apiKey = params.env.POSTHOG_KEY;
    if (params.optOut || params.ctx?.props?.telemetryOptOut === true || !apiKey || apiKey === 'test-posthog-key' || params.env.ORGX_TELEMETRY_DISABLED === '1') return;
    if (!/^[a-z][a-z0-9_]{1,100}$/.test(params.event)) return;
    const owner = params.ctx ?? params.env;
    const count = pending.get(owner) ?? 0;
    if (count >= TELEMETRY_LIMITS.maxQueueEvents) { workerTelemetryHealth.dropped++; return; }
    const accountId = canonicalAccountId(params.distinctId);
    const distinctId = accountId ?? (/^mcp:[a-zA-Z0-9-]{1,160}$/.test(params.distinctId) ? params.distinctId : resolveAnonymousDistinctId(undefined));
    const workspaceId = canonicalAccountId(params.workspaceId);

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
      telemetry_source: 'orgx-mcp',
      identity_namespace: accountId ? 'orgx_account' : 'anonymous',
      telemetry_audience: telemetryAudience(params.env.ORGX_TELEMETRY_AUDIENCE),
      $process_person_profile: Boolean(accountId),
      ...(workspaceId ? { $groups: { workspace: workspaceId } } : {}),
      ...(params.event === 'mcp_tool_invocation' ? { event_outcome: invocationOutcome(params.properties?.status, params.properties?.mcp_response_observed) } : {}),
      environment: ['production', 'preview', 'development', 'test'].includes(params.env.ORGX_TELEMETRY_ENVIRONMENT ?? '')
        ? params.env.ORGX_TELEMETRY_ENVIRONMENT : 'unknown',
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
          distinct_id: distinctId,
          properties: eventProperties,
          timestamp: sentAt,
        },
      ],
      sent_at: sentAt,
    };

    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > TELEMETRY_LIMITS.maxEventBytes) { workerTelemetryHealth.dropped++; return; }
    pending.set(owner, count + 1);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
    const request = fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok || !(await acceptedCaptureResponse(response))) {
          workerTelemetryHealth.failed++;
          console.warn('[telemetry] PostHog capture rejected', {
            event: params.event,
            status: response.status,
          });
        } else workerTelemetryHealth.delivered++;
      })
      .catch(() => {
        workerTelemetryHealth.failed++;
        console.warn('[telemetry] PostHog capture unavailable', { event: params.event });
      })
      .finally(() => { clearTimeout(timeout); pending.set(owner, Math.max(0, (pending.get(owner) ?? 1) - 1)); });

    const diagnostic = params.event === 'mcp_tool_invocation' && eventProperties.event_outcome === 'failure'
      ? exportPosthogDiagnostic({ key: apiKey, host, service: 'orgx-mcp',
          enabled: params.env.ORGX_POSTHOG_LOGS_ENABLED === '1', environment: String(eventProperties.environment),
          release: typeof eventProperties.release === 'string' ? eventProperties.release : undefined,
          audience: params.env.ORGX_TELEMETRY_AUDIENCE }, 'mcp_invocation_failed', {
          userId: accountId, requestId: eventProperties.request_id ?? eventProperties.request_uuid,
          traceId: eventProperties.trace_id, spanId: eventProperties.span_id,
        }) : Promise.resolve();
    params.ctx?.waitUntil?.(Promise.allSettled([request, diagnostic]));
  } catch {
    // ignore
  }
}

/** Inspect bounded ingestion acknowledgements, including HTTP-200 quota rejection. */
async function acceptedCaptureResponse(response: Response): Promise<boolean> {
  if (!response.body) return true;
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (bytes <= 1024) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1024) return false;
      chunks.push(part.value);
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder().decode(all);
    if (!raw) return true;
    const result = JSON.parse(raw) as { status?: unknown; quota_limited?: unknown; error?: unknown };
    return !result.error && !(Array.isArray(result.quota_limited) && result.quota_limited.length > 0)
      && (result.status === undefined || result.status === 1 || result.status === 'Ok');
  } catch { return false; }
  finally { await reader.cancel().catch(() => undefined); }
}
