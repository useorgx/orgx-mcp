/** Opt-in OTLP diagnostics; fixed bodies, no console/error/argument interception. */
import { canonicalAccountId, safeCorrelation, TELEMETRY_SCHEMA_VERSION, telemetryAudience } from './telemetryContract';
export type DiagnosticEnv = {
  key?: string; host?: string; enabled?: boolean; disabled?: boolean;
  service: 'orgx-app' | 'orgx-mcp'; environment?: string; release?: string; audience?: string;
};
export type DiagnosticCode = 'mcp_invocation_failed' | 'mcp_pairing_failed' | 'onboarding_completed';
export const diagnosticHealth = { delivered: 0, failed: 0, dropped: 0 };
let windowStarted = 0;
let windowCount = 0;
let inFlight = 0;
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
export function exportPosthogDiagnostic(env: DiagnosticEnv, code: DiagnosticCode, context: {
  userId?: unknown; sessionId?: unknown; requestId?: unknown; traceId?: unknown; spanId?: unknown;
} = {}): Promise<void> {
  if (!env.enabled || env.disabled || !env.key || env.key === 'test-posthog-key') return Promise.resolve();
  if (!['mcp_invocation_failed', 'mcp_pairing_failed', 'onboarding_completed'].includes(code)) return Promise.resolve();
  const now = Date.now();
  if (now - windowStarted >= 60_000) { windowStarted = now; windowCount = 0; }
  if (windowCount >= 50 || inFlight >= 4) { diagnosticHealth.dropped++; return Promise.resolve(); }
  windowCount++; inFlight++;
  const userId = canonicalAccountId(context.userId);
  const sessionId = safeCorrelation(context.sessionId, 'uuid');
  const requestId = safeCorrelation(context.requestId, 'uuid');
  const traceId = safeCorrelation(context.traceId, 'trace');
  const spanId = traceId ? safeCorrelation(context.spanId, 'span') : undefined;
  const attributes = [attr('telemetry_schema_version', TELEMETRY_SCHEMA_VERSION),
    attr('telemetry_audience', telemetryAudience(env.audience)),
    ...(userId ? [attr('posthogDistinctId', userId)] : []),
    ...(sessionId ? [attr('posthogSessionId', sessionId)] : []),
    ...(requestId ? [attr('request_id', requestId)] : [])];
  const body = { resourceLogs: [{ resource: { attributes: [attr('service.name', env.service),
    attr('deployment.environment', ['production', 'preview', 'development', 'test'].includes(env.environment ?? '') ? env.environment! : 'unknown'),
    ...(env.release && /^[0-9a-f-]{7,40}$/i.test(env.release) ? [attr('service.version', env.release)] : [])] },
    scopeLogs: [{ scope: { name: 'orgx.safe-diagnostics', version: TELEMETRY_SCHEMA_VERSION }, logRecords: [{
      timeUnixNano: String(now * 1_000_000), severityNumber: code === 'onboarding_completed' ? 9 : 17,
      severityText: code === 'onboarding_completed' ? 'INFO' : 'ERROR', body: { stringValue: code }, attributes,
      ...(traceId ? { traceId } : {}), ...(spanId ? { spanId } : {}),
    }] }] }] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  return Promise.resolve().then(() => fetch(`${(env.host ?? 'https://us.i.posthog.com').replace(/\/+$/, '')}/i/v1/logs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.key}` },
    body: JSON.stringify(body), signal: controller.signal,
  })).then(async (response) => {
    let rejected = !response.ok;
    if (response.body) {
      const reader = response.body.getReader();
      let raw = ''; let bytes = 0;
      try {
        while (bytes <= 1024) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 1024) { rejected = true; break; }
          raw += new TextDecoder().decode(part.value);
        }
        if (raw) {
          const acknowledgement = JSON.parse(raw) as { partialSuccess?: { rejectedLogRecords?: string | number; errorMessage?: string } };
          if (Number(acknowledgement.partialSuccess?.rejectedLogRecords ?? 0) > 0 || acknowledgement.partialSuccess?.errorMessage) rejected = true;
        }
      } catch { rejected = true; }
      finally { await reader.cancel().catch(() => undefined); }
    }
    if (rejected) { diagnosticHealth.failed++; console.warn('[telemetry] diagnostic rejected', { status: response.status }); }
    else diagnosticHealth.delivered++;
  }).catch(() => { diagnosticHealth.failed++; console.warn('[telemetry] diagnostic unavailable'); })
    .finally(() => { clearTimeout(timer); inFlight--; });
}
