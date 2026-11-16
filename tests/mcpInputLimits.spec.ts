import { afterEach, describe, expect, it, vi } from 'vitest';

import { boundMcpRequestBody } from '../src/mcpInputLimits';
import { LEGACY_SCAFFOLD_BATCH_CAPABILITY } from '../src/generated/legacyScaffoldBatchProfile';
import { MAX_MCP_REQUEST_BODY_BYTES } from '../src/mcpInputLimits';

function post(body: BodyInit, headers?: Record<string, string>, signal?: AbortSignal) {
  return new Request('https://mcp.useorgx.test/mcp?profile=v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local-fixture', ...headers },
    body,
    signal,
    ...((body instanceof ReadableStream) ? { duplex: 'half' } : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MCP pre-parse body budget', () => {
  it('keeps the published hierarchy-batch byte allowance', () => {
    expect(MAX_MCP_REQUEST_BODY_BYTES).toBe(LEGACY_SCAFFOLD_BATCH_CAPABILITY.max_request_bytes);
  });

  it.each([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orgx_search', arguments: { query: 'résumé' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ],
  ])('preserves an accepted normal or batch request, auth and URL', async (input) => {
    const json = JSON.stringify(input);
    const request = post(json);
    const result = await boundMcpRequestBody(request);
    expect(result.response).toBeUndefined();
    expect(result.request.url).toBe(request.url);
    expect(result.request.headers.get('authorization')).toBe('Bearer local-fixture');
    expect(await result.request.text()).toBe(json);
    expect(result.request.headers.get('content-length')).toBe(String(new TextEncoder().encode(json).byteLength));
  });

  it('rejects an oversized declared length before reading the body', async () => {
    const result = await boundMcpRequestBody(post('{}', { 'content-length': '65' }), 64);
    expect(result.response?.status).toBe(413);
    expect(await result.response?.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
  });

  it('counts UTF-8 bytes even when Content-Length underreports the body', async () => {
    const json = JSON.stringify('😄'.repeat(20));
    expect(json.length).toBeLessThan(64);
    const result = await boundMcpRequestBody(post(json, { 'content-length': '1' }), 64);
    expect(result.response?.status).toBe(413);
  });

  it('cancels an oversized chunked body without trusting Content-Length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
      },
      cancel,
    });
    const result = await boundMcpRequestBody(post(body), 64);
    expect(result.response?.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('accepts a body exactly at the byte limit', async () => {
    const json = JSON.stringify('x'.repeat(62));
    const result = await boundMcpRequestBody(post(json), 64);
    expect(result.response).toBeUndefined();
    expect(await result.request.text()).toBe(json);
  });

  it('coalesces a very fragmented valid request without changing its UTF-8 body', async () => {
    const json = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'orgx_search', arguments: { query: 'é'.repeat(10_000) } },
    });
    const encoded = new TextEncoder().encode(json);
    expect(encoded.byteLength).toBeGreaterThan(16 * 1024);
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next === encoded.byteLength) controller.close();
        else controller.enqueue(encoded.subarray(next, ++next));
      },
    });
    const result = await boundMcpRequestBody(post(body), encoded.byteLength);
    expect(result.response).toBeUndefined();
    expect(result.request.headers.get('content-length')).toBe(String(encoded.byteLength));
    expect(result.request.headers.get('authorization')).toBe('Bearer local-fixture');
    expect(await result.request.text()).toBe(json);
    expect(body.locked).toBe(false);
  });

  it('leaves GET transport requests untouched', async () => {
    const request = new Request('https://mcp.useorgx.test/sse');
    expect(await boundMcpRequestBody(request)).toEqual({ request });
  });

  it('times out a stalled body without waiting for its stalled cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const result = boundMcpRequestBody(post(body), 64, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).response?.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('honors caller cancellation (already aborted: %s)', async (alreadyAborted) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    if (alreadyAborted) controller.abort('private caller reason');
    const result = boundMcpRequestBody(post(body, undefined, controller.signal), 64, 100);
    if (!alreadyAborted) controller.abort('private caller reason');
    const response = (await result).response;
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain('was cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces elapsed time when immediately fulfilled chunks prevent timers firing', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(100);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel,
    });
    const result = await boundMcpRequestBody(post(body), 64, 100);
    expect(result.response?.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});
