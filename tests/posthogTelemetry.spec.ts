import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureWorkerPosthogEvent, resolveAnonymousDistinctId, workerTelemetryHealth } from '../src/posthogTelemetry';

describe('worker PostHog telemetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a canonical MCP surface envelope and binds delivery to waitUntil', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ status: 'Ok' }, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);

    captureWorkerPosthogEvent({
      env: {
        POSTHOG_KEY: 'phc_test',
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_TELEMETRY_ENVIRONMENT: 'production',
      },
      ctx: { waitUntil },
      event: 'mcp_tool_invocation',
      distinctId: 'user-1',
      properties: { tool_id: 'query_org_memory', latency_ms: 27 },
      serverVersion: '0.3.0-test',
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]?.[0];

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      batch: Array<{ properties: Record<string, unknown> }>;
    };
    expect(body.batch[0]?.properties).toMatchObject({
      $lib: 'orgx-mcp',
      $lib_version: '0.3.0-test',
      telemetry_schema_version: '2026-10-12',
      surface: 'mcp',
      event_origin: 'cloudflare_worker',
      environment: 'production',
      tool_id: 'query_org_memory',
      latency_ms: 27,
    });
  });
});

it('never creates one global anonymous person or treats Clerk as the account identity', async () => {
  const fetchMock = vi.fn(async () => Response.json({ status: 1 })); vi.stubGlobal('fetch', fetchMock);
  const deliveries: Promise<unknown>[] = [];
  for (let i = 0; i < 2; i++) captureWorkerPosthogEvent({ env: { POSTHOG_KEY: 'phc_test' }, ctx: { waitUntil: p => deliveries.push(p) }, event: 'mcp_tool_invocation', distinctId: 'user_clerk' });
  await Promise.all(deliveries);
  const events = fetchMock.mock.calls.map(call => JSON.parse(String((call as any)[1].body)).batch[0]);
  expect(events[0].distinct_id).not.toBe(events[1].distinct_id);
  expect(events[0].properties.$process_person_profile).toBe(false);
  expect(resolveAnonymousDistinctId(undefined)).not.toBe(resolveAnonymousDistinctId(undefined));
  vi.unstubAllGlobals();
});
it('bounds concurrent events and classifies unobserved HTTP success as unknown', async () => {
  let finish!: (value: Response) => void;
  const response = new Promise<Response>(r => { finish = r; });
  const fetchMock = vi.fn(() => response); vi.stubGlobal('fetch', fetchMock);
  const ctx = { waitUntil: vi.fn() }; const env = { POSTHOG_KEY: 'phc_test' };
  const before = workerTelemetryHealth.dropped;
  for (let i = 0; i < 110; i++) captureWorkerPosthogEvent({ env, ctx, event: 'mcp_tool_invocation', distinctId: '11111111-1111-4111-8111-111111111111', properties: { status: 'success', mcp_response_observed: false } });
  expect(fetchMock).toHaveBeenCalledTimes(100); expect(workerTelemetryHealth.dropped - before).toBe(10);
  const payload = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
  expect(payload.batch[0].properties.event_outcome).toBe('unknown');
  expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(16384);
  finish(new Response(null)); await Promise.all(ctx.waitUntil.mock.calls.map(call => call[0])); vi.unstubAllGlobals();
});
it('counts HTTP-200 quota rejection outside the exporter', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 1, quota_limited: ['events'] })));
  const ctx = { waitUntil: vi.fn() }; const before = workerTelemetryHealth.failed;
  captureWorkerPosthogEvent({ env: { POSTHOG_KEY: 'phc_test' }, ctx, event: 'mcp_tool_invocation', distinctId: 'user_clerk' });
  await ctx.waitUntil.mock.calls[0][0]; expect(workerTelemetryHealth.failed).toBe(before + 1); vi.unstubAllGlobals();
});

it('honors explicit consent opt-out before any queue or network work', () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  captureWorkerPosthogEvent({ env: { POSTHOG_KEY: 'phc_test' }, event: 'mcp_tool_invocation', distinctId: '11111111-1111-4111-8111-111111111111', optOut: true });
  expect(fetchMock).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});
