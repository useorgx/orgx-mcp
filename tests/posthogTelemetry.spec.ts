import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureWorkerPosthogEvent } from '../src/posthogTelemetry';

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
      telemetry_schema_version: '2026-07-14',
      surface: 'mcp',
      event_origin: 'cloudflare_worker',
      environment: 'production',
      tool_id: 'query_org_memory',
      latency_ms: 27,
    });
  });
});
