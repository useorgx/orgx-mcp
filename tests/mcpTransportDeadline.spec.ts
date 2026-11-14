import { afterEach, expect, it, vi } from 'vitest';
import { handleMcpRequest } from '../src/mcpTransport';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('finishes timeout telemetry while the client response stream remains open', async () => {
  vi.useFakeTimers();
  const records: any[] = [];
  const pending: Promise<unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    records.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true });
  }));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const request = new Request('https://mcp.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'orgx_search', arguments: { query: 'reliability' } } }),
  });
  const response = await handleMcpRequest(request,
    { ORGX_API_URL: 'https://api.test', ORGX_SERVICE_KEY: 'oxk-test-key' },
    { props: {}, waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as any,
    { fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) },
    async () => ({ userId: 'test-user' }));
  let finished = false;
  const drained = Promise.allSettled(pending).then(() => { finished = true; });
  try {
    await vi.advanceTimersByTimeAsync(30_001);
    expect(finished).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].metadata).toMatchObject({ response_read_error: true, mcp_response_observed: false });
  } finally {
    // The observer's deadline must not close or discard the client's branch.
    controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n'));
    controller.close();
    expect(await response.text()).toContain('"id":1');
    await drained;
  }
});
