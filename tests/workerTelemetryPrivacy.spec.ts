import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureWorkerPosthogEvent } from '../src/posthogTelemetry';
import { sanitizeWorkerTelemetryProperties } from '../src/workerTelemetryPrivacy';

describe('worker analytics privacy boundary', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('rejects raw credentials, prompts, URLs, errors, paths and client-supplied identifiers', () => {
    const secret = 'sentinel_private_value@customer.example';
    const cleaned = sanitizeWorkerTelemetryProperties({
      error: secret, error_path: secret, prompt: secret, result: { text: secret },
      access_token: secret, state_key: secret, code_verifier: secret,
      conversation_id: secret, request_id: secret, step_id: secret,
      argument_keys: [secret], random_property: secret, redirect_uri: secret,
      client_name: secret, client_platform: secret, client_version: secret,
      tool_id: secret, error_code: secret, error_kind: secret,
      workspace_id: secret,
      search_results_by_type: { [secret]: 1, task: 2, artifact: secret },
      latency_ms: Infinity, cost_usd: -1,
    });
    expect(JSON.stringify(cleaned)).not.toContain(secret);
    expect(cleaned).toMatchObject({
      client_name: 'other', tool_id: 'other', error_code: 'other',
      search_results_by_type: { task: 2 },
    });
    for (const field of ['error', 'error_path', 'request_id', 'conversation_id',
      'argument_keys', 'workspace_id', 'latency_ms', 'cost_usd']) {
      expect(cleaned).not.toHaveProperty(field);
    }
  });

  it('preserves the bounded diagnostic and activation fields', () => {
    const props = {
      tool_id: 'orgx_search', error_code: '-32000', error_kind: 'authentication_required',
      latency_ms: 25, search_result_count: 2, search_results_by_type: { task: 2 },
      source_client: 'codex', client_name: 'openai-mcp (Codex)',
      client_version: '1.2.3', has_user_id: true,
      workspace_id: '11111111-1111-4111-8111-111111111111',
      request_uuid: '22222222-2222-4222-8222-222222222222',
      activation_stage: 'A1', activation_label: 'Workflow structure created',
      activation_track: 'mcp-skills',
      edge_rate_limit_source: 'memory', edge_rate_limit_degraded: 'upstash_unavailable',
    };
    expect(sanitizeWorkerTelemetryProperties(props)).toEqual(props);
  });

  it('enforces the policy on the actual outgoing batch and takes release from server bindings', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    let delivery: Promise<unknown> | undefined;
    captureWorkerPosthogEvent({
      env: { POSTHOG_KEY: 'test', SENTRY_RELEASE: 'abcdef1234567' },
      ctx: { waitUntil: (promise) => { delivery = promise; } },
      event: 'mcp_tool_failed', distinctId: 'canonical-user-id',
      properties: { error: 'secret-sentinel', error_kind: 'invalid_input',
        release: 'client-spoof', event_id: 'client-spoof', conversation_id: 'secret-sentinel' },
    });
    await delivery;
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(JSON.stringify(body)).not.toContain('secret-sentinel');
    expect(body.batch[0].properties).toMatchObject({
      error_kind: 'invalid_input', release: 'abcdef1234567', release_source: 'sentry_release',
    });
    expect(body.batch[0].uuid).toBe(body.batch[0].properties.event_id);
    expect(body.batch[0].uuid).not.toBe('client-spoof');
  });

  it('finishes failed capture within its deadline without leaking the failure payload', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('secret-sentinel')));
      })));
    let delivery: Promise<unknown> | undefined;
    captureWorkerPosthogEvent({
      env: { POSTHOG_KEY: 'test' }, event: 'mcp_tool_invocation', distinctId: 'user-id',
      ctx: { waitUntil: (promise) => { delivery = promise; } },
    });
    await vi.advanceTimersByTimeAsync(2000);
    await delivery;
    expect(warn).toHaveBeenCalledWith('[telemetry] PostHog capture unavailable', { event: 'mcp_tool_invocation' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-sentinel');
    warn.mockRestore();
  });

  it('uses the deployed Cloudflare version when a source revision is unavailable', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    let delivery: Promise<unknown> | undefined;
    captureWorkerPosthogEvent({
      env: { POSTHOG_KEY: 'test', CF_VERSION_METADATA: { id: '33333333-3333-4333-8333-333333333333' } },
      event: 'mcp_tool_invocation', distinctId: 'user',
      ctx: { waitUntil: (promise) => { delivery = promise; } },
    });
    await delivery;
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.batch[0].properties).toMatchObject({
      release: '33333333-3333-4333-8333-333333333333', release_source: 'cloudflare_version',
    });
  });
});
