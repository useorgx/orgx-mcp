import { fetchContextPack } from '../src/contextPack';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOrgxApiJson } from '../src/orgxApi';
import {
  installSessionToolObservationWrapper,
  type SessionToolCompletion,
} from '../src/sessionSummary';
import { invocationDiagnostics, validTraceparent } from '../src/apiDiagnostics';

const env = {
  ORGX_API_URL: 'https://primary.example.test',
  ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
  ORGX_SERVICE_KEY: 'oxk-secret',
  ORGX_API_TIMEOUT_MS: '30',
  ORGX_API_PRIMARY_TIMEOUT_MS: '10',
};

function wrapped(handler: (...args: unknown[]) => unknown, onComplete?: () => void) {
  const completions: SessionToolCompletion[] = [];
  let run!: (...args: unknown[]) => unknown;
  const server = {
    registerTool: (_name: string, _config: unknown, fn: typeof run) => {
      run = fn;
    },
  };
  installSessionToolObservationWrapper(
    server as never,
    () => {},
    (result) => { completions.push(result); onComplete?.(); }
  );
  server.registerTool('orgx_search', {}, handler);
  return { run, completions };
}

describe('MCP API diagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('joins retries to one request and tool trace without retaining private data', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = wrapped(() =>
      callOrgxApiJson(
        env,
        '/api/entities?query=private-goal&token=secret',
        undefined,
        { userId: 'private-user' }
      )
    );
    await tool.run({}, { requestId: 'rpc-1', sessionId: 'session-1' });
    const [a, b] = fetchMock.mock.calls.map(
      (call) => new Headers(call[1].headers)
    );
    expect(a.get('X-Request-ID')).toBe(b.get('X-Request-ID'));
    expect(a.get('traceparent')).toBe(b.get('traceparent'));
    expect(validTraceparent(a.get('traceparent'))).toBeTruthy();
    const diagnostics = tool.completions[0].apiDiagnostics!;
    expect(diagnostics).toMatchObject({
      calls: 1,
      attempts: 2,
      fallbacks: 1,
      failures: 0,
      last_status: 200,
    });
    expect(diagnostics.trace_id).toBe(a.get('traceparent')!.split('-')[1]);
    expect(diagnostics.last_request_id).toBe(a.get('X-Request-ID'));
    const recorded = JSON.stringify({ diagnostics, logs: logs.mock.calls });
    for (const privateValue of [
      'private-goal',
      'private-user',
      'secret',
      'primary.example.test',
    ])
      expect(recorded).not.toContain(privateValue);
  });

  it('preserves widget metadata and returns support references only for API-backed results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
    const tool = wrapped(async () => {
      await callOrgxApiJson(env, '/api/entities');
      return {
        content: [],
        structuredContent: { items: [] },
        _meta: { 'openai/outputTemplate': 'widget' },
      };
    }, () => { void callOrgxApiJson(env, '/api/internal/mcp/tool-invocations'); });
    const result = (await tool.run({}, { requestId: 'widget' })) as any;
    expect(result._meta['openai/outputTemplate']).toBe('widget');
    expect(result._meta['orgx/diagnostics']).toEqual({
      trace_id: tool.completions[0].apiDiagnostics!.trace_id,
      request_id: tool.completions[0].apiDiagnostics!.last_request_id,
    });
    expect(result._meta['orgx/performance']).toEqual({
      tool_execution_ms: expect.any(Number),
      api_calls: 1, api_attempts: 1, api_fallbacks: 0,
      api_failures: 0, api_timeouts: 0,
      api_headers_ms: expect.any(Number), api_body_ms: expect.any(Number),
    });
    const local = wrapped(() => ({ content: [], _meta: { local: true } }));
    expect(await local.run({}, {})).toEqual({
      content: [],
      _meta: { local: true },
    });
  });

  it('keeps overlapping tool invocations isolated and preserves incoming trace context', async () => {
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await pause;
        return Response.json({});
      })
    );
    const tool = wrapped(async () => {
      await callOrgxApiJson(env, '/api/entities');
      await callOrgxApiJson(env, '/api/entities');
    });
    const parent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const first = tool.run(
      {},
      { requestId: 'one', requestInfo: { headers: { traceparent: parent } } }
    );
    const second = tool.run(
      {},
      { requestId: 'two', requestInfo: { headers: { traceparent: 'invalid' } } }
    );
    release();
    await Promise.all([first, second]);
    const one = tool.completions.find((c) => c.requestId === 'one')!
      .apiDiagnostics!;
    const two = tool.completions.find((c) => c.requestId === 'two')!
      .apiDiagnostics!;
    expect(one.trace_id).toBe('a'.repeat(32));
    expect(two.trace_id).not.toBe(one.trace_id);
    expect(one.calls).toBe(2);
    expect(two.calls).toBe(2);
    expect(one.last_request_id).not.toBe(two.last_request_id);
  });

  it('sums fixed origin phase samples across concurrent calls and fallback attempts without changing tool wall time', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503, headers: { 'server-timing': 'orgx_mcp_total;dur=100,private_name;dur=999' } }))
      .mockResolvedValueOnce(Response.json({}, { headers: { 'server-timing': 'orgx_mcp_total;dur=200,orgx_mcp_identity;dur=20' } }))
      .mockResolvedValueOnce(Response.json({}, { headers: { 'server-timing': 'orgx_mcp_total;dur=300,orgx_mcp_identity;dur=30' } })));
    const tool = wrapped(async () => {
      await Promise.all([callOrgxApiJson(env, '/api/entities'), callOrgxApiJson(env, '/api/context')]);
      return { content: [], _meta: { 'orgx/performance': { tool_execution_ms: 999999 } } };
    });
    const result = await tool.run({}, { requestId: 'origin-samples' }) as any;
    const diagnostics = tool.completions[0].apiDiagnostics!;
    expect(diagnostics).toMatchObject({ calls: 2, attempts: 3, fallbacks: 1,
      origin_timings: { total: { sum_ms: 600, count: 3 }, identity: { sum_ms: 50, count: 2 } } });
    expect(result._meta['orgx/performance']).toMatchObject({
      origin_total_ms: 600, origin_total_count: 3, origin_identity_ms: 50, origin_identity_count: 2,
      tool_execution_ms: expect.any(Number),
    });
    expect(result._meta['orgx/performance']).not.toHaveProperty('private_name');
    expect(result._meta['orgx/performance']).not.toHaveProperty('origin_metering_ms');
    expect(result._meta['orgx/performance'].tool_execution_ms).not.toBe(999999);
    expect(result._meta['orgx/performance'].tool_execution_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(diagnostics)).not.toContain('private_name');
  });

  it('logs context preparation and scope for the matching inspection attempt only', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetch = vi.fn(async () => Response.json({ ok: true, data: { hydrated: true } }, {
      headers: { 'server-timing': 'context_prepare;dur=40,context_scope;dur=6.125,private-stage;dur=2' },
    }));
    vi.stubGlobal('fetch', fetch);
    const tool = wrapped(async () => {
      const [pack] = await Promise.all([
        fetchContextPack(env, 'private-user', { type: 'task', id: 'private-anchor' }),
        callOrgxApiJson(env, '/api/entities?query=private-query'),
      ]);
      return { content: [], structuredContent: { pack } };
    });
    const result = await tool.run({}, { requestId: 'inspection' }) as any;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toEqual({ pack: { hydrated: true } });
    const attempts = logs.mock.calls.map(([raw]) => JSON.parse(String(raw)))
      .filter((log) => log.event === 'orgx_api_attempt');
    expect(attempts).toHaveLength(2);
    const trace = result._meta['orgx/diagnostics'].trace_id;
    expect(attempts.find((log) => log.method === 'POST')).toMatchObject({
      trace_id: trace, context_prepare_ms: 40, context_scope_ms: 6.125,
    });
    const entity = attempts.find((log) => log.method === 'GET');
    expect(entity.trace_id).toBe(trace);
    expect(entity).not.toHaveProperty('context_prepare_ms');
    expect(entity).not.toHaveProperty('context_scope_ms');
    expect(JSON.stringify(result)).not.toContain('context_prepare_ms');
    expect(JSON.stringify(result)).not.toContain('context_scope_ms');
    expect(JSON.stringify(attempts)).not.toMatch(/private-|server-timing|api\/entities/i);
  });

  it('isolates timing sums between invocations and freezes snapshots before later API telemetry', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      await pause;
      return Response.json({}, { headers: { 'server-timing': `orgx_mcp_total;dur=${url.includes('/one') ? 11 : 22}` } });
    }));
    let snapshot: ReturnType<typeof invocationDiagnostics>;
    const one = wrapped(async () => {
      await callOrgxApiJson(env, '/one');
      snapshot = invocationDiagnostics();
      await callOrgxApiJson(env, '/one');
      return { content: [] };
    });
    const two = wrapped(async () => { await callOrgxApiJson(env, '/two'); return { content: [] }; });
    const first = one.run({}, { requestId: 'one' });
    const second = two.run({}, { requestId: 'two' });
    release();
    const [a, b] = await Promise.all([first, second]) as any[];
    expect(a._meta['orgx/performance']).toMatchObject({ origin_total_ms: 22, origin_total_count: 2 });
    expect(b._meta['orgx/performance']).toMatchObject({ origin_total_ms: 22, origin_total_count: 1 });
    expect(snapshot!.origin_timings).toEqual({ total: { sum_ms: 11, count: 1 } });
  });

  it('identifies body timeouts separately from response headers and redacts error bodies', async () => {
    // Advance both the timers and the shared monotonic deadline together.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{'));
              },
            }),
            { headers: { 'content-type': 'application/json' } }
          )
      )
    );
    const tool = wrapped(() =>
      callOrgxApiJson(env, '/api/entities?token=secret')
    );
    const rejection = expect(tool.run({}, { requestId: 'slow-body' })).rejects.toThrow(
      'took too long'
    );
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    expect(tool.completions[0].apiDiagnostics).toMatchObject({
      attempts: 2,
      fallbacks: 1,
      failures: 1,
      timeouts: 2,
      last_error: 'body_timeout',
      last_status: 200,
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('secret');
  });

  it('counts a recovered body timeout without reporting the successful call as failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(Response.json({ ok: true })));
    const tool = wrapped(() => callOrgxApiJson(env, '/api/entities'));

    const result = tool.run({}, { requestId: 'recovered-body' });
    await vi.advanceTimersByTimeAsync(10);
    await result;

    expect(tool.completions[0].apiDiagnostics).toMatchObject({
      calls: 1,
      attempts: 2,
      fallbacks: 1,
      failures: 0,
      timeouts: 1,
      last_status: 200,
    });
  });

  it('records HTTP failures without disclosing the upstream body or exception message', async () => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'private failure details' }, { status: 403 })
      )
    );
    const tool = wrapped(() => callOrgxApiJson(env, '/api/entities'));
    await expect(tool.run({}, { requestId: 'denied' })).rejects.toThrow();
    expect(tool.completions[0].apiDiagnostics).toMatchObject({
      failures: 1,
      last_error: 'http_error',
      last_status: 403,
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(
      'private failure details'
    );
  });

  it.each([
    `00-${'0'.repeat(32)}-${'a'.repeat(16)}-01`,
    `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`,
    `00-${'a'.repeat(32)}-${'b'.repeat(16)}-ff`,
  ])('rejects invalid traceparent %s', (value) => {
    expect(validTraceparent(value)).toBeNull();
  });
});
