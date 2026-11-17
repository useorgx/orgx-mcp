import { AsyncLocalStorage } from 'node:async_hooks';

// Diagnostic timing only. Never persist it or accept a timestamp from a client.
const requests = new AsyncLocalStorage<{ startedAt: number }>();

export function withWorkerRequestTiming<T>(fn: () => T): T {
  return requests.run({ startedAt: Date.now() }, fn);
}

export function workerRequestStartedAt(): number | undefined {
  return requests.getStore()?.startedAt;
}

/** Include OAuth/body/preflight handling before the authenticated transport. */
export function workerTimingPerformance(
  requestStartedAt: number,
  responseHeadersMs: number,
  fullResponseMs: number,
  firstByteMs?: number
): Record<string, number> {
  const startedAt = workerRequestStartedAt();
  if (startedAt === undefined) return {};
  const beforeTransport = Math.max(0, requestStartedAt - startedAt);
  return {
    worker_pre_transport_ms: beforeTransport,
    worker_response_headers_ms: beforeTransport + responseHeadersMs,
    worker_full_response_ms: beforeTransport + fullResponseMs,
    ...(firstByteMs === undefined ? {} : { worker_first_response_byte_ms: beforeTransport + firstByteMs }),
  };
}
