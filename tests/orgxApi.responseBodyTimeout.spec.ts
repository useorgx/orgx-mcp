import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOrgxApiJson, OrgXApiError } from '../src/orgxApi';

const env = {
  ORGX_API_URL: 'https://api.example.test',
  ORGX_SERVICE_KEY: 'oxk-test-service-key',
  ORGX_API_TIMEOUT_MS: '25',
};

describe('OrgX API response body deadline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('buffers a complete JSON body for downstream callers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ok: true, data: { id: 'initiative-1' } })
      )
    );

    const response = await callOrgxApiJson(env, '/api/test');

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { id: 'initiative-1' },
    });
  });

  it('fails with a structured error when headers arrive but the body stalls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":'));
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const startedAt = Date.now();
    await expect(callOrgxApiJson(env, '/api/stalled')).rejects.toMatchObject({
      name: 'OrgXApiError',
      message: 'The request took too long. Please try again.',
    } satisfies Partial<OrgXApiError>);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('retries a stalled successful read on the fallback within the primary deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const request = callOrgxApiJson({ ...env, ORGX_API_TIMEOUT_MS: '100', ORGX_API_PRIMARY_TIMEOUT_MS: '20', ORGX_API_FALLBACK_URL: 'https://fallback.example.test' }, '/api/stalled');

    await vi.advanceTimersByTimeAsync(20);

    await expect((await request).json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('retries a safely repeatable read whose body connection resets', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('connection reset')); },
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await callOrgxApiJson({ ...env, ORGX_API_FALLBACK_URL: 'https://fallback.example.test' }, '/api/reset');

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not contact a fallback after the total deadline is exhausted', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const rejected = expect(callOrgxApiJson({ ...env, ORGX_API_TIMEOUT_MS: '10', ORGX_API_PRIMARY_TIMEOUT_MS: '100', ORGX_API_FALLBACK_URL: 'https://fallback.example.test' }, '/api/stalled')).rejects.toThrow('took too long');

    await vi.advanceTimersByTimeAsync(10);

    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes caller cancellation listeners after a complete response', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));

    await callOrgxApiJson(env, '/api/complete', { signal: controller.signal });

    for (const [event, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(event, listener);
    }
    expect(add).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation after response headers without retrying the request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const request = callOrgxApiJson({ ...env, ORGX_API_FALLBACK_URL: 'https://fallback.example.test' }, '/api/stalled', { signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ message: 'The request was cancelled.' });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();

    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one deadline between response headers and body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } });
    }));
    let settled = false;
    const request = callOrgxApiJson({ ...env, ORGX_API_TIMEOUT_MS: '100' }, '/api/stalled');
    const rejected = expect(request).rejects.toMatchObject({ message: 'The request took too long. Please try again.' }).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps fallback headers and body inside the total request budget', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }))
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } });
      });
    vi.stubGlobal('fetch', fetchMock);
    let settled = false;
    const request = callOrgxApiJson({ ...env, ORGX_API_TIMEOUT_MS: '100', ORGX_API_PRIMARY_TIMEOUT_MS: '20', ORGX_API_FALLBACK_URL: 'https://fallback.example.test' }, '/api/stalled');
    const rejected = expect(request).rejects.toThrow('took too long').finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not re-send a mutation whose successful response body stalls', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const rejected = expect(callOrgxApiJson({ ...env, ORGX_API_FALLBACK_URL: 'https://fallback.example.test' }, '/api/tasks', { method: 'POST', body: '{}' })).rejects.toThrow('took too long');

    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a successful HTML fallback mask a structured primary failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'upstream_unavailable', message: 'try later' } },
          { status: 503 }
        )
      )
      .mockResolvedValueOnce(
        new Response('<!doctype html><title>Application</title>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callOrgxApiJson(
        {
          ...env,
          ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
        },
        '/api/v1/events/stream'
      )
    ).rejects.toMatchObject({
      name: 'OrgXApiError',
      message: 'OrgX is temporarily unavailable. Please try again later.',
      statusCode: 503,
      internalDetails: expect.stringContaining(
        'returned text/html; charset=utf-8 instead of application/json'
      ),
    } satisfies Partial<OrgXApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('OrgX API configuration failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reports a missing API URL as setup, not as an outage', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callOrgxApiJson({ ...env, ORGX_API_URL: '  ' }, '/api/test')
    ).rejects.toMatchObject({
      name: 'OrgXApiError',
      message: expect.stringContaining('not configured'),
      internalDetails: 'No OrgX API base URL was configured',
    } satisfies Partial<OrgXApiError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
