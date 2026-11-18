import * as Sentry from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { boundMcpRequestBody } from '../src/mcpInputLimits';
import { createSentryOptions } from '../src/sentryConfig';
import type { SentryWorkerEnv } from '../src/sentryConfig';

const ENV = { SENTRY_DSN: 'https://public@example.invalid/1' };

// Exercise the pinned SDK's exported fetch wrapper and integration selection.
// Only event delivery is local; request capture and dispatch are the real SDK.
function wrap(handler: (request: Request) => Promise<Response>, overrides: Partial<CloudflareOptions> = {}, env: SentryWorkerEnv = ENV) {
  const pending: Promise<unknown>[] = [];
  const options = createSentryOptions(env);
  const send = vi.fn(async () => ({ statusCode: 200 }));
  const worker = Sentry.withSentry(() => ({
    ...options,
    enableLogs: false,
    tracesSampleRate: 0,
    transport: () => ({
      send,
      flush: async () => true,
    }),
    ...overrides,
  }), { fetch: handler });
  return {
    fetch(request: Request) {
      return worker.fetch!(request, env, {
        waitUntil(promise: Promise<unknown>) { pending.push(promise); },
      } as ExecutionContext);
    },
    send,
    async dispose() { await Promise.allSettled(pending); },
  };
}

function post(body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('https://mcp.example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal,
    ...((body instanceof ReadableStream) ? { duplex: 'half' } : {}),
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('real Sentry request body admission', () => {
  it('observes the old default body read before handler entry as a regression control', async () => {
    const request = post('{"fixture":"private-body"}');
    const clone = vi.spyOn(request, 'clone');
    const worker = wrap(async (incoming) => {
      expect(clone).toHaveBeenCalled();
      expect(Sentry.getIsolationScope().getScopeData().sdkProcessingMetadata.normalizedRequest)
        .toMatchObject({ data: '{"fixture":"private-body"}' });
      expect(await incoming.text()).toBe('{"fixture":"private-body"}');
      return new Response(null, { status: 204 });
    }, { integrations: [] });
    try {
      expect((await worker.fetch(request)).status).toBe(204);
    } finally { await worker.dispose(); }
  });

  it('keeps the body unread until the handler and retains other default integrations', async () => {
    const request = post('{"fixture":"private-body"}');
    const clone = vi.spyOn(request, 'clone');
    const worker = wrap(async (incoming) => {
      expect(clone).not.toHaveBeenCalled();
      expect(incoming.bodyUsed).toBe(false);
      const client = Sentry.getClient()!;
      expect(client.getIntegrationByName('HttpServer')).toMatchObject({ maxRequestBodySize: 'none' });
      expect(client.getIntegrationByName('InboundFilters')).toBeDefined();
      expect(client.getIntegrationByName('RequestData')).toBeDefined();
      expect(client.getDataCollectionOptions().httpBodies).toEqual([]);
      expect(Sentry.getIsolationScope().getScopeData().sdkProcessingMetadata.normalizedRequest).not.toHaveProperty('data');
      const bounded = await boundMcpRequestBody(incoming);
      expect(bounded.response).toBeUndefined();
      expect(await bounded.request.text()).toBe('{"fixture":"private-body"}');
      return new Response(null, { status: 204 });
    });
    try {
      expect((await worker.fetch(request)).status).toBe(204);
      expect(clone).not.toHaveBeenCalled();
    } finally { await worker.dispose(); }
  });

  it('also skips body capture without a DSN and keeps event delivery disabled', async () => {
    expect(createSentryOptions({})).toBeUndefined();
    const request = post('{"fixture":"unconfigured-body"}');
    const clone = vi.spyOn(request, 'clone');
    const worker = wrap(async (incoming) => {
      expect(clone).not.toHaveBeenCalled();
      expect(incoming.bodyUsed).toBe(false);
      expect(Sentry.getClient()?.getOptions().dsn).toBeUndefined();
      expect(Sentry.getClient()?.getIntegrationByName('HttpServer')).toBeUndefined();
      Sentry.captureMessage('local no-DSN fixture');
      return new Response(null, { status: 204 });
    }, {}, {});
    try {
      expect((await worker.fetch(request)).status).toBe(204);
    } finally { await worker.dispose(); }
    expect(worker.send).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  });

  it.each([undefined, '1'])('lets the streamed byte guard cancel an oversized body (Content-Length %s)', async (length) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65)); },
      cancel,
    });
    const request = post(body, length === undefined ? {} : { 'content-length': length });
    const clone = vi.spyOn(request, 'clone');
    const worker = wrap(async (incoming) => {
      expect(clone).not.toHaveBeenCalled();
      expect(incoming.bodyUsed).toBe(false);
      const bounded = await boundMcpRequestBody(incoming, 64);
      return bounded.response!;
    });
    try {
      const response = await worker.fetch(request);
      expect(response.status).toBe(413);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(clone).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    } finally { await worker.dispose(); }
  });

  it('rejects a declared oversized body without consuming it in the SDK or handler', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = post(body, { 'content-length': '65' });
    const clone = vi.spyOn(request, 'clone');
    const worker = wrap(async (incoming) => {
      expect(clone).not.toHaveBeenCalled();
      expect(incoming.bodyUsed).toBe(false);
      return (await boundMcpRequestBody(incoming, 64)).response!;
    });
    try {
      expect((await worker.fetch(request)).status).toBe(413);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(clone).not.toHaveBeenCalled();
    } finally { await worker.dispose(); }
  });

  it('lets the handler guard cancel a stalled request without an SDK clone retaining it', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = post(body, {}, abort.signal);
    const clone = vi.spyOn(request, 'clone');
    const worker = wrap(async (incoming) => {
      expect(clone).not.toHaveBeenCalled();
      expect(incoming.bodyUsed).toBe(false);
      const guarded = boundMcpRequestBody(incoming);
      abort.abort();
      return (await guarded).response!;
    });
    try {
      expect((await worker.fetch(request)).status).toBe(400);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(clone).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    } finally { await worker.dispose(); }
  });

  it('keeps concurrent request telemetry scopes and bodies isolated', async () => {
    let arrivals = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => { release = resolve; });
    const worker = wrap(async (incoming) => {
      const id = incoming.headers.get('x-fixture-request')!;
      const scope = Sentry.getIsolationScope();
      scope.setTag('fixture_request', id);
      const guarded = await boundMcpRequestBody(incoming);
      expect(guarded.response).toBeUndefined();
      if (++arrivals === 2) release();
      await bothEntered;
      expect(Sentry.getIsolationScope().getScopeData().tags.fixture_request).toBe(id);
      expect(Sentry.getIsolationScope().getScopeData().sdkProcessingMetadata.normalizedRequest).not.toHaveProperty('data');
      return new Response(await guarded.request.text());
    });
    const requests = ['first', 'second'].map((id) => post(JSON.stringify({ fixture: id }), { 'x-fixture-request': id }));
    const clones = requests.map((request) => vi.spyOn(request, 'clone'));
    try {
      const responses = await Promise.all(requests.map((request) => worker.fetch(request)));
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
        { fixture: 'first' }, { fixture: 'second' },
      ]);
      for (const clone of clones) expect(clone).not.toHaveBeenCalled();
    } finally { await worker.dispose(); }
  });
});
