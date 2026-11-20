import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOrgxApiJson } from '../src/orgxApi';

const env = {
  ORGX_API_URL: 'https://primary.example.test',
  ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
  ORGX_SERVICE_KEY: 'oxk-operation-deadline-test',
};

function stalledFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
  }));
}

describe('per-operation API deadline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shares the shorter operation budget across stalled primary and fallback headers', async () => {
    vi.useFakeTimers();
    const fetch = stalledFetch();
    vi.stubGlobal('fetch', fetch);
    let settled = false;
    const rejected = expect(callOrgxApiJson(env, '/api/read', undefined, { timeoutMs: 10_000 }))
      .rejects.toThrow('took too long').finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still recovers a stalled primary using the remaining operation budget', async () => {
    vi.useFakeTimers();
    const stalled = stalledFetch();
    const fetch = vi.fn()
      .mockImplementationOnce(stalled)
      .mockResolvedValueOnce(Response.json({ data: { workspace: { id: 'authorized-workspace' } } }));
    vi.stubGlobal('fetch', fetch);
    const request = callOrgxApiJson(env, '/api/read', undefined, { timeoutMs: 10_000 });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect((await request).json()).resolves.toMatchObject({ data: { workspace: { id: 'authorized-workspace' } } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes stalled body delivery on both origins in the operation budget', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const rejected = expect(callOrgxApiJson(env, '/api/read', undefined, { timeoutMs: 10_000 }))
      .rejects.toThrow('took too long');

    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never extends a shorter configured budget', async () => {
    vi.useFakeTimers();
    const fetch = stalledFetch();
    vi.stubGlobal('fetch', fetch);
    const rejected = expect(callOrgxApiJson({ ...env, ORGX_API_TIMEOUT_MS: '100' }, '/api/read', undefined, { timeoutMs: 10_000 }))
      .rejects.toThrow('took too long');

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the active origin without starting fallback when the caller leaves', async () => {
    vi.useFakeTimers();
    const fetch = stalledFetch();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const rejected = expect(callOrgxApiJson(env, '/api/read', { signal: controller.signal }, { timeoutMs: 10_000 }))
      .rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(1);

    controller.abort();

    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
