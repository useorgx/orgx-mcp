import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation is diagnostic only: it never grants actor or workspace authority. */
export interface ApiDiagnostics {
  trace_id: string;
  last_request_id: string;
  calls: number;
  attempts: number;
  fallbacks: number;
  failures: number;
  timeouts: number;
  headers_ms: number;
  body_ms: number;
  last_status: number;
  last_error: string;
}

type Invocation = { traceparent: string; diagnostics: ApiDiagnostics };
const invocations = new AsyncLocalStorage<Invocation>();
const requests = new AsyncLocalStorage<ApiRequestObservation>();
const responses = new WeakMap<Response, ApiRequestObservation>();

export function validTraceparent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/.test(value)
    ? value
    : null;
}

function newTraceparent(): string {
  return `00-${crypto.randomUUID().replace(/-/g, '')}-${crypto
    .randomUUID()
    .replace(/-/g, '')
    .slice(0, 16)}-01`;
}

export function withInvocationDiagnostics<T>(extra: unknown, fn: () => T): T {
  const headers = (
    extra as { requestInfo?: { headers?: Record<string, unknown> } } | null
  )?.requestInfo?.headers;
  const traceparent =
    validTraceparent(headers?.traceparent) ?? newTraceparent();
  return invocations.run(
    {
      traceparent,
      diagnostics: {
        trace_id: traceparent.split('-')[1],
        last_request_id: '',
        calls: 0,
        attempts: 0,
        fallbacks: 0,
        failures: 0,
        timeouts: 0,
        headers_ms: 0,
        body_ms: 0,
        last_status: 0,
        last_error: '',
      },
    },
    fn
  );
}

export function invocationDiagnostics(): ApiDiagnostics | undefined {
  const current = invocations.getStore();
  return current ? { ...current.diagnostics } : undefined;
}

export class ApiRequestObservation {
  readonly requestId = crypto.randomUUID();
  readonly traceparent: string;
  private failed = false;
  private lastError = 'request_failed';
  private readonly diagnostics = invocations.getStore()?.diagnostics;
  constructor(headers: Headers) {
    this.traceparent =
      invocations.getStore()?.traceparent ??
      validTraceparent(headers.get('traceparent')) ??
      newTraceparent();
    headers.set('traceparent', this.traceparent);
    headers.set('X-Request-ID', this.requestId);
    headers.set('X-Correlation-ID', this.requestId);
    if (this.diagnostics) {
      this.diagnostics.calls++;
      this.diagnostics.last_request_id = this.requestId;
    }
  }
  run<T>(fn: () => T): T {
    return requests.run(this, fn);
  }
  failure(code = this.lastError, status?: number): void {
    if (this.failed) return;
    this.failed = true;
    if (this.diagnostics) {
      this.diagnostics.failures++;
      this.diagnostics.last_error = code;
      if (status) this.diagnostics.last_status = status;
    }
    this.log('orgx_api_failure', { outcome: code, status: status ?? 0 });
  }
  log(event: string, fields: Record<string, string | number | boolean>): void {
    // Never log URLs, queries, headers, bodies, actor IDs or exception messages.
    console.info(
      JSON.stringify({
        event,
        request_id: this.requestId,
        trace_id: this.traceparent.split('-')[1],
        ...fields,
      })
    );
  }
  async fetch(
    url: string,
    init: RequestInit,
    fallback: boolean
  ): Promise<Response> {
    const started = performance.now();
    let status = 0;
    let outcome = 'network_error';
    if (this.diagnostics) {
      this.diagnostics.attempts++;
      if (fallback) this.diagnostics.fallbacks++;
    }
    try {
      const response = await fetch(url, init);
      status = response.status;
      outcome = response.ok ? 'succeeded' : 'http_error';
      responses.set(response, this);
      return response;
    } catch (error) {
      if (init.signal?.aborted) {
        outcome =
          typeof init.signal.reason === 'string' &&
          init.signal.reason.startsWith('timeout after ')
            ? 'headers_timeout'
            : 'cancelled';
        if (outcome === 'headers_timeout' && this.diagnostics)
          this.diagnostics.timeouts++;
      }
      throw error;
    } finally {
      if (outcome !== 'succeeded') this.lastError = outcome;
      const duration = Math.max(0, Math.round(performance.now() - started));
      if (this.diagnostics) {
        this.diagnostics.headers_ms += duration;
        this.diagnostics.last_status = status;
        if (outcome !== 'succeeded') this.diagnostics.last_error = outcome;
      }
      const method = (init.method ?? 'GET').toUpperCase();
      this.log('orgx_api_attempt', {
        method: /^(GET|HEAD|OPTIONS|POST|PATCH|PUT|DELETE)$/.test(method)
          ? method
          : 'OTHER',
        fallback,
        status,
        outcome,
        headers_ms: duration,
      });
    }
  }
  body(duration: number, timedOut: boolean): void {
    if (timedOut) this.failure('body_timeout');
    if (this.diagnostics) {
      this.diagnostics.body_ms += duration;
      if (timedOut) {
        this.diagnostics.timeouts++;
      }
    }
    this.log('orgx_api_body', {
      body_ms: duration,
      outcome: timedOut ? 'body_timeout' : 'completed',
    });
  }
}

export function observedApiFetch(
  url: string,
  init: RequestInit,
  fallback: boolean
): Promise<Response> {
  const observation = requests.getStore();
  return observation
    ? observation.fetch(url, init, fallback)
    : fetch(url, init);
}

export function recordApiBody(
  response: Response,
  duration: number,
  timedOut: boolean
): void {
  (responses.get(response) ?? requests.getStore())?.body(duration, timedOut);
}

export function currentApiReferences(): Record<string, string> {
  const current = requests.getStore();
  return current
    ? {
        request_id: current.requestId,
        trace_id: current.traceparent.split('-')[1],
      }
    : {};
}

export function withResponseDiagnostics<T>(response: Response, fn: () => T): T {
  const observation = responses.get(response);
  return observation ? observation.run(fn) : fn();
}

/** Support references travel with widget results without exposing request content. */
export function attachDiagnosticReferences(value: unknown): unknown {
  const diagnostics = invocationDiagnostics();
  if (
    !diagnostics?.calls ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('content' in value || 'structuredContent' in value)
  )
    return value;
  const result = value as Record<string, unknown>;
  const meta =
    result._meta &&
    typeof result._meta === 'object' &&
    !Array.isArray(result._meta)
      ? (result._meta as Record<string, unknown>)
      : {};
  return {
    ...result,
    _meta: {
      ...meta,
      'orgx/diagnostics': {
        trace_id: diagnostics.trace_id,
        request_id: diagnostics.last_request_id,
      },
    },
  };
}
