import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOrgxApiJson } from '../src/orgxApi';
import {
  installSessionToolObservationWrapper,
  type SessionToolCompletion,
} from '../src/sessionSummary';
import { validTraceparent } from '../src/apiDiagnostics';

const env = {
  ORGX_API_URL: 'https://primary.example.test',
  ORGX_API_FALLBACK_URL: 'https://fallback.example.test',
  ORGX_SERVICE_KEY: 'oxk-secret',
  ORGX_API_TIMEOUT_MS: '30',
  ORGX_API_PRIMARY_TIMEOUT_MS: '10',
};

function wrapped(handler: (...args: unknown[]) => unknown) {
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
    (result) => completions.push(result)
  );
  server.registerTool('orgx_search', {}, handler);
  return { run, completions };
}

describe('MCP API diagnostics', () => {
  afterEach(() => {
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
    });
    const result = (await tool.run({}, { requestId: 'widget' })) as any;
    expect(result._meta['openai/outputTemplate']).toBe('widget');
    expect(result._meta['orgx/diagnostics']).toEqual({
      trace_id: tool.completions[0].apiDiagnostics!.trace_id,
      request_id: tool.completions[0].apiDiagnostics!.last_request_id,
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

  it('identifies body timeouts separately from response headers and redacts error bodies', async () => {
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
    await expect(tool.run({}, { requestId: 'slow-body' })).rejects.toThrow(
      'took too long'
    );
    expect(tool.completions[0].apiDiagnostics).toMatchObject({
      attempts: 1,
      failures: 1,
      timeouts: 1,
      last_error: 'body_timeout',
      last_status: 200,
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('secret');
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
