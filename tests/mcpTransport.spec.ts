import { describe, expect, it, vi } from 'vitest';

import { normalizeAgentDispatchPayload } from '../src/agentDispatchPayload';
import {
  buildMcpTransportExceptionResponse,
  handleMcpRequest,
  withCorsAndHeaders,
} from '../src/mcpTransport';
import {
  DEPRECATION_SUNSET_AT_ISO,
  DEPRECATION_SUNSET_HEADER,
  DEPRECATION_WINDOW_DAYS,
} from '../src/deprecatedTools';

const env = {} as unknown as Record<string, unknown>;

function createCtx() {
  return { waitUntil: vi.fn() } as any;
}

function createTrackedCtx() {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(Promise.resolve(promise));
  });
  return {
    ctx: { waitUntil } as any,
    waitUntil,
    async drain() {
      while (pending.length > 0) {
        await Promise.allSettled(pending.splice(0));
      }
    },
  };
}

describe('mcpTransport', () => {
  it('rejects an untrusted browser Origin before a mutating tool reaches auth or dispatch', async () => {
    const handler = { fetch: vi.fn(async () => Response.json({ ok: true })) };
    const authenticateRequest = vi.fn(async () => ({ userId: 'user-123' }));
    const request = new Request('https://mcp.useorgx.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'orgx_write', arguments: { type: 'task' } },
      }),
    });

    const response = await handleMcpRequest(
      request,
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
      },
      createCtx(),
      handler,
      authenticateRequest
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('x-orgx-mcp-error-code')).toBe(
      'invalid_origin'
    );
    expect(authenticateRequest).not.toHaveBeenCalled();
    expect(handler.fetch).not.toHaveBeenCalled();
  });

  it('accepts the trusted Claude Origin for the non-destructive directory profile and echoes narrow CORS', async () => {
    const handler = { fetch: vi.fn(async () => Response.json({ ok: true })) };
    const request = new Request(
      'https://mcp.useorgx.com/mcp?profile=claude-directory',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://claude.ai',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'orgx_search', arguments: { query: 'status' } },
        }),
      }
    );

    const response = await handleMcpRequest(
      request,
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
      },
      createCtx(),
      handler,
      vi.fn(async () => ({ userId: 'reviewer-123' }))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://claude.ai'
    );
    expect(response.headers.get('Vary')).toContain('Origin');
    expect(handler.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'orgx-mcp:spawn_agent_task',
    'OrgX:spawn_agent_task',
    'orgx-mcp.spawn_agent_task',
    'orgx-mcp/spawn_agent_task',
    'mcp__orgx__spawn_agent_task',
    'mcp__orgx-mcp__spawn_agent_task',
  ])(
    'normalizes tool name prefix "%s" for tools/call requests',
    async (toolName) => {
      let received: any = null;
      const handler = {
        fetch: vi.fn(async (req: Request) => {
          received = await req.json();
          return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const authenticateRequest = vi.fn(async () => ({
      userId: 'user-123',
      scope: 'mcp:all',
    }));

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: toolName },
      }),
    });

    const ctx = createCtx();
    const response = await handleMcpRequest(
      request,
      env,
      ctx,
      handler,
      authenticateRequest
    );

    expect(received?.params?.name).toBe('spawn_agent_task');
    expect(ctx.props).toEqual({
      userId: 'user-123',
      scope: 'mcp:all',
      email: undefined,
      profile: 'v2',
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
  );

  it('preserves request context and fails unknown profiles closed before dispatch', async () => {
    const ctx = {
      waitUntil: vi.fn(),
      props: { sourceClient: 'codex', workspace_id: 'ws-1' },
    } as any;
    const handler = {
      fetch: vi.fn(async () => Response.json({ ok: true })),
    };

    await handleMcpRequest(
      new Request('http://localhost/mcp?profile=typo-admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'orgx_search' } }),
      }),
      env,
      ctx,
      handler,
      vi.fn(async () => ({ userId: 'user-123', scope: 'mcp:all' }))
    );

    expect(ctx.props).toMatchObject({
      sourceClient: 'codex',
      workspace_id: 'ws-1',
      userId: 'user-123',
      profile: 'read-only',
    });
  });

  it('routes get_pending_decisions to the decisions widget affordance and adds deprecation headers', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'get_pending_decisions',
          arguments: { limit: 3, initiative_id: 'init-123' },
        },
      }),
    });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params?.name).toBe('approve_agent_work');
    expect(received?.params?.arguments).toEqual({
      action: 'list',
      limit: 3,
      initiative_id: 'init-123',
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'get_pending_decisions'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'approve_agent_work'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
  });

  it('routes get_pending_decisions urgency filters through the decisions widget affordance', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'get_pending_decisions',
          arguments: { urgency_filter: 'high' },
        },
      }),
    });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params?.name).toBe('approve_agent_work');
    expect(received?.params?.arguments).toEqual({
      action: 'list',
      urgency_filter: 'high',
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'get_pending_decisions'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'approve_agent_work'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
  });

  it('routes get_decision_history to recall_memory when no legacy-only filters are used', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'mcp__orgx__get_decision_history',
          arguments: { topic: 'pricing', limit: 2 },
        },
      }),
    });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params?.name).toBe('recall_memory');
    expect(received?.params?.arguments).toEqual({
      query: 'pricing',
      scope: 'decisions',
      limit: 2,
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'get_decision_history'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'recall_memory'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
  });

  it('routes score_next_up_queue to recommend_next_action', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'score_next_up_queue',
          arguments: { workspace_id: 'ws-123', limit: 4 },
        },
      }),
    });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params?.name).toBe('recommend_next_action');
    expect(received?.params?.arguments).toEqual({
      entity_type: 'workspace',
      workspace_id: 'ws-123',
      limit: 4,
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'score_next_up_queue'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'recommend_next_action'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
  });

  it('routes create_checkout_session to account_upgrade', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'mcp__orgx__create_checkout_session',
          arguments: {
            plan: 'team',
            billing_cycle: 'annual',
            user_id: 'user-123',
          },
        },
      }),
    });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params?.name).toBe('account_upgrade');
    expect(received?.params?.arguments).toEqual({
      target_plan: 'pro',
      billing_cycle: 'annual',
      user_id: 'user-123',
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'create_checkout_session'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'account_upgrade'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
    expect(response.headers.get('x-orgx-deprecation-sunset-at')).toBe(
      DEPRECATION_SUNSET_AT_ISO
    );
    expect(response.headers.get('x-orgx-deprecation-window-days')).toBe(
      String(DEPRECATION_WINDOW_DAYS)
    );
    expect(response.headers.get('Sunset')).toBe(DEPRECATION_SUNSET_HEADER);
  });

  it('captures telemetry for deprecated tool usage when PostHog is configured', async () => {
    const tracked = createTrackedCtx();
    const { ctx, waitUntil } = tracked;
    const telemetryFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', telemetryFetch);

    try {
      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'create_checkout_session',
            arguments: { plan: 'starter', user_id: 'user-123' },
          },
        }),
      });

      await handleMcpRequest(
        request,
        {
          POSTHOG_KEY: 'phc_test_key',
          POSTHOG_HOST: 'https://app.posthog.com',
        } as any,
        ctx,
        {
          fetch: vi.fn(async () =>
            new Response(JSON.stringify({ ok: true }), {
              headers: { 'content-type': 'application/json' },
            })
          ),
        },
        vi.fn(async () => ({ userId: 'user-123', scope: 'mcp:all' }))
      );
      await tracked.drain();

      expect(waitUntil).toHaveBeenCalledTimes(2);
      expect(telemetryFetch).toHaveBeenCalledTimes(2);
      expect(telemetryFetch).toHaveBeenCalledWith(
        'https://app.posthog.com/batch/',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const payloads = telemetryFetch.mock.calls.map((call) =>
        JSON.parse(call[1].body as string)
      ) as Array<{
        batch: Array<{ event: string; properties: Record<string, unknown> }>;
      }>;
      const deprecatedPayload = payloads.find(
        (payload) => payload.batch[0]?.event === 'mcp_deprecated_tool_called'
      );
      const invocationPayload = payloads.find(
        (payload) => payload.batch[0]?.event === 'mcp_tool_invocation'
      );
      expect(deprecatedPayload?.batch[0]?.properties).toMatchObject({
        deprecated_tool_id: 'create_checkout_session',
        replacement_tool_id: 'account_upgrade',
        routed: true,
        auth_scope: 'mcp:all',
        has_user_id: true,
        deprecation_sunset_at: DEPRECATION_SUNSET_AT_ISO,
        deprecation_window_days: DEPRECATION_WINDOW_DAYS,
        $lib: 'orgx-mcp',
      });
      expect(invocationPayload?.batch[0]?.properties).toMatchObject({
        tool_id: 'account_upgrade',
        status: 'success',
        tool_family: 'mcp_tool',
        auth_scope: 'mcp:all',
        has_user_id: true,
        $lib: 'orgx-mcp',
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it('captures generic MCP tool invocation visibility in PostHog and backend telemetry', async () => {
    const tracked = createTrackedCtx();
    const { ctx, waitUntil } = tracked;
    const telemetryFetch = vi.fn(async (url: string) => {
      if (url.includes('/api/internal/mcp/tool-invocations')) {
        return new Response(JSON.stringify({ ok: true, id: 'inv-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', telemetryFetch);

    try {
      const handler = {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ ok: true }), {
            headers: {
              'content-type': 'application/json',
              'server-timing':
                'edge_rate_limit;dur=1.25, rate_limit_backend;dur=0.2, rate_limit_identity;dur=0, rate_limit_billing;dur=0',
              'x-orgx-rate-limit-strategy': 'base_allowance',
            },
          })
        ),
      };
      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'tools/call',
          params: {
            name: 'orgx_write',
            arguments: {
              type: 'task',
              operation: 'create',
              workspace_id: '4be1ff06-a5e5-4b34-8974-3348c47ea4f1',
              initiative_id: '9b543d86-ea3e-47b8-8109-7160547f2745',
              _context: {
                client: {
                  name: 'claude-code',
                  platform: 'macos',
                  version: '1.2.3',
                },
                conversation: { id: 'conv-1' },
                user: { workingDirectory: '/repo' },
              },
            },
          },
        }),
      });

      await handleMcpRequest(
        request,
        {
          POSTHOG_KEY: 'phc_test_key',
          POSTHOG_HOST: 'https://app.posthog.com',
          ORGX_API_URL: 'https://useorgx.test',
          ORGX_SERVICE_KEY: 'oxk-service-test',
        } as any,
        ctx,
        handler,
        vi.fn(async () => ({ userId: 'user-123', scope: 'mcp:all' }))
      );
      await tracked.drain();

      expect(waitUntil).toHaveBeenCalledTimes(1);
      const posthogCall = telemetryFetch.mock.calls.find(
        ([url]) => url === 'https://app.posthog.com/batch/'
      );
      expect(posthogCall).toBeTruthy();
      const posthogPayload = JSON.parse(posthogCall?.[1].body as string) as {
        batch: Array<{ event: string; properties: Record<string, unknown> }>;
      };
      expect(posthogPayload.batch[0]?.event).toBe('mcp_tool_invocation');
      expect(posthogPayload.batch[0]?.properties).toMatchObject({
        tool_id: 'orgx_write',
        status: 'success',
        tool_family: 'entity_write',
        workspace_id: '4be1ff06-a5e5-4b34-8974-3348c47ea4f1',
        source_client: 'claude',
        entity_type: 'task',
        action: 'create',
        has_initiative_id: true,
        client_name: 'claude-code',
        client_platform: 'macos',
        has_conversation_id: true,
        has_working_directory: true,
        request_id: 'req-1',
        edge_rate_limit_ms: 1.25,
        edge_rate_limit_backend_ms: 0.2,
        edge_rate_limit_identity_ms: 0,
        edge_rate_limit_billing_ms: 0,
        edge_rate_limit_strategy: 'base_allowance',
        $lib: 'orgx-mcp',
      });

      const backendCall = telemetryFetch.mock.calls.find(([url]) =>
        String(url).includes('/api/internal/mcp/tool-invocations')
      );
      expect(backendCall).toBeTruthy();
      const backendPayload = JSON.parse(backendCall?.[1].body as string);
      expect(backendPayload).toMatchObject({
        tool_id: 'orgx_write',
        status: 'success',
        source: 'mcp_worker',
        client_name: 'claude-code',
        client_platform: 'claude',
        tool_family: 'entity_write',
        auth_source: 'session',
        is_widget_tool: false,
        request_id: 'req-1',
        conversation_id: 'conv-1',
        user_id: 'user-123',
        workspace_id: '4be1ff06-a5e5-4b34-8974-3348c47ea4f1',
        metadata: expect.objectContaining({
          tool_family: 'entity_write',
          entity_type: 'task',
          action: 'create',
          edge_rate_limit_ms: 1.25,
          edge_rate_limit_backend_ms: 0.2,
          edge_rate_limit_identity_ms: 0,
          edge_rate_limit_billing_ms: 0,
          edge_rate_limit_strategy: 'base_allowance',
        }),
      });
      expect(backendPayload.metadata).not.toHaveProperty(
        'response_size_header_bytes'
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it('classifies HTTP-200 structured tool errors and records response journey telemetry', async () => {
    const tracked = createTrackedCtx();
    const telemetryFetch = vi.fn(async (url: string) => {
      if (url.includes('/api/internal/mcp/tool-invocations')) {
        return Response.json({ ok: true, id: 'inv-logical-error' });
      }
      return new Response(null, { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', telemetryFetch);

    const payload = {
      jsonrpc: '2.0',
      id: 'req-logical-error',
      result: {
        content: [
          { type: 'text', text: 'The requested scope is unavailable.' },
        ],
        structuredContent: {
          error: { code: 'invalid_scope', kind: 'authorization' },
        },
      },
    };
    const serializedPayload = JSON.stringify(payload);

    try {
      const request = new Request('http://localhost/mcp?profile=executor', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'session-redacted',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-logical-error',
          method: 'tools/call',
          params: {
            name: 'orgx_write',
            arguments: {
              type: 'task',
              operation: 'create',
              _context: {
                client: { name: 'codex', platform: 'macos' },
                conversation: { id: 'conv-journey' },
                journey: {
                  step_id: 'step-2',
                  step_index: 2,
                  previous_tool: 'orgx_search',
                  expected_next_tool: 'orgx_attach',
                  previous_expected_next_tool: 'orgx_write',
                },
              },
            },
          },
        }),
      });

      await handleMcpRequest(
        request,
        {
          POSTHOG_KEY: 'phc_test_key',
          POSTHOG_HOST: 'https://app.posthog.com',
          ORGX_API_URL: 'https://useorgx.test',
          ORGX_SERVICE_KEY: 'oxk-service-test',
        } as any,
        tracked.ctx,
        {
          fetch: vi.fn(async () =>
            new Response(serializedPayload, {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'server-timing':
                  'session;dur=2, response_build;dur=3.5',
              },
            })
          ),
        },
        vi.fn(async () => ({ userId: 'user-123', scope: 'mcp:all' }))
      );
      await tracked.drain();

      const posthogCall = telemetryFetch.mock.calls.find(
        ([url]) => url === 'https://app.posthog.com/batch/'
      );
      const posthogPayload = JSON.parse(posthogCall?.[1].body as string) as {
        batch: Array<{ event: string; properties: Record<string, unknown> }>;
      };
      expect(posthogPayload.batch[0]?.properties).toMatchObject({
        tool_id: 'orgx_write',
        status: 'error',
        error_code: 'invalid_scope',
        error_kind: 'authorization',
        mcp_logical_error: true,
        source_client: 'codex',
        profile: 'executor',
        session_present: true,
        conversation_id: 'conv-journey',
        step_id: 'step-2',
        step_index: 2,
        previous_tool_id: 'orgx_search',
        expected_next_tool_id: 'orgx_attach',
        previous_expected_next_tool_id: 'orgx_write',
        followed_expected_next_tool: true,
        session_ms: 2,
        response_shaping_ms: 3.5,
        response_size_bytes: new TextEncoder().encode(serializedPayload)
          .byteLength,
        response_size_source: 'body_clone',
        response_read_error: false,
        response_parse_truncated: false,
        response_measurement_point: 'worker_response_clone',
        journey_phase: 'complete',
      });
      expect(posthogPayload.batch[0]?.properties).not.toHaveProperty(
        'response_size_header_bytes'
      );
      for (const field of [
        'auth_ms',
        'handler_ms',
        'response_headers_ms',
        'first_response_byte_ms',
        'full_response_ms',
      ]) {
        expect(posthogPayload.batch[0]?.properties[field]).toEqual(
          expect.any(Number)
        );
      }

      const backendCall = telemetryFetch.mock.calls.find(([url]) =>
        String(url).includes('/api/internal/mcp/tool-invocations')
      );
      const backendPayload = JSON.parse(backendCall?.[1].body as string);
      expect(backendPayload).toMatchObject({
        tool_id: 'orgx_write',
        status: 'error',
        error_code: 'invalid_scope',
        conversation_id: 'conv-journey',
        metadata: expect.objectContaining({
          error_kind: 'authorization',
          mcp_logical_error: true,
          response_size_bytes: new TextEncoder().encode(serializedPayload)
            .byteLength,
          step_id: 'step-2',
          previous_tool_id: 'orgx_search',
        }),
      });
      expect(backendPayload.metadata).not.toHaveProperty(
        'response_size_header_bytes'
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it('preserves existing Server-Timing entries when rate-limit timings are added', () => {
    const response = withCorsAndHeaders(
      new Response(null, {
        headers: { 'server-timing': 'origin;dur=12' },
      }),
      { 'Server-Timing': 'edge_rate_limit;dur=1' }
    );

    expect(response.headers.get('server-timing')).toContain('origin;dur=12');
    expect(response.headers.get('server-timing')).toContain(
      'edge_rate_limit;dur=1'
    );
  });

  it('captures failed MCP tool visibility when the handler throws', async () => {
    const tracked = createTrackedCtx();
    const { ctx } = tracked;
    const telemetryFetch = vi.fn(async (url: string) => {
      if (url.includes('/api/internal/mcp/tool-invocations')) {
        return new Response(JSON.stringify({ ok: true, id: 'inv-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', telemetryFetch);

    try {
      const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-fail',
          method: 'tools/call',
          params: {
            name: 'orgx_decide',
            arguments: {
              workspace_id: '4be1ff06-a5e5-4b34-8974-3348c47ea4f1',
              _context: { client: { name: 'codex' } },
            },
          },
        }),
      });

      await expect(
        handleMcpRequest(
          request,
          {
            POSTHOG_KEY: 'phc_test_key',
            POSTHOG_HOST: 'https://app.posthog.com',
            ORGX_API_URL: 'https://useorgx.test',
            ORGX_SERVICE_KEY: 'oxk-service-test',
          } as any,
          ctx,
          {
            fetch: vi.fn(async () => {
              throw new TypeError('boom');
            }),
          },
          vi.fn(async () => ({ userId: 'user-123', scope: 'mcp:all' }))
        )
      ).rejects.toThrow('boom');
      await tracked.drain();

      const posthogCall = telemetryFetch.mock.calls.find(
        ([url]) => url === 'https://app.posthog.com/batch/'
      );
      const posthogPayload = JSON.parse(posthogCall?.[1].body as string) as {
        batch: Array<{ event: string; properties: Record<string, unknown> }>;
      };
      expect(posthogPayload.batch[0]?.properties).toMatchObject({
        tool_id: 'orgx_decide',
        status: 'error',
        tool_family: 'decision',
        error_code: 'exception_typeerror',
        http_status: 500,
      });

      const backendCall = telemetryFetch.mock.calls.find(([url]) =>
        String(url).includes('/api/internal/mcp/tool-invocations')
      );
      const backendPayload = JSON.parse(backendCall?.[1].body as string);
      expect(backendPayload).toMatchObject({
        tool_id: 'orgx_decide',
        status: 'error',
        tool_family: 'decision',
        error_code: 'exception_typeerror',
        request_id: 'req-fail',
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it('routes compatible batch_create_entities initiative hierarchies to scaffold_initiative', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'batch_create_entities',
          arguments: {
            owner_id: 'user-123',
            concurrency: 2,
            continue_on_error: false,
            entities: [
              {
                type: 'initiative',
                ref: 'init',
                title: 'Launch OrgX MCP',
                summary: 'Ship the launch hierarchy',
                workspace_id: 'ws-123',
              },
              {
                type: 'workstream',
                ref: 'ws-eng',
                title: 'Engineering',
                initiative_ref: 'init',
              },
              {
                type: 'milestone',
                ref: 'ms-worker',
                title: 'Worker ready',
                initiative_ref: 'init',
                workstream_ref: 'ws-eng',
              },
              {
                type: 'task',
                title: 'Ship worker',
                initiative_ref: 'init',
                workstream_ref: 'ws-eng',
                milestone_ref: 'ms-worker',
              },
            ],
          },
        },
      }),
    });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params?.name).toBe('scaffold_initiative');
    expect(received?.params?.arguments).toEqual({
      title: 'Launch OrgX MCP',
      summary: 'Ship the launch hierarchy',
      workspace_id: 'ws-123',
      owner_id: 'user-123',
      continue_on_error: false,
      concurrency: 2,
      workstreams: [
        {
          ref: 'ws-eng',
          title: 'Engineering',
          milestones: [
            {
              ref: 'ms-worker',
              title: 'Worker ready',
              tasks: [{ title: 'Ship worker' }],
            },
          ],
        },
      ],
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'batch_create_entities'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'scaffold_initiative'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
  });

  it('preserves batch_create_entities when the payload is not a single initiative hierarchy', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    };

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'tools/call',
        params: {
          name: 'batch_create_entities',
          arguments: {
            entities: [
              { type: 'initiative', ref: 'init-a', title: 'Init A' },
              { type: 'initiative', ref: 'init-b', title: 'Init B' },
            ],
          },
        },
      }),
    });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params?.name).toBe('batch_create_entities');
    expect(received?.params?.arguments).toEqual({
      entities: [
        { type: 'initiative', ref: 'init-a', title: 'Init A' },
        { type: 'initiative', ref: 'init-b', title: 'Init B' },
      ],
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'batch_create_entities'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('false');
  });

  it('hydrates spawn_agent_task payload with domain and workspace from initiative context', async () => {
    const lookupEntity = vi.fn(async (type: string, id: string) => {
      if (type === 'initiative' && id === 'init-1') {
        return { id, command_center_id: 'ws-1', name: 'Pipeline Refresh' };
      }
      if (type === 'command_center' && id === 'ws-1') {
        return { id, name: 'Core Platform' };
      }
      return null;
    });

    const result = await normalizeAgentDispatchPayload({
      toolId: 'spawn_agent_task',
      args: { agent: 'engineering-agent', initiative_id: 'init-1' },
      data: {
        run_id: 'run-1',
        initiative_id: 'init-1',
        task_summary: 'Ship it',
      },
      lookupEntity,
    });

    expect(result).toMatchObject({
      agent_id: 'engineering-agent',
      agent_name: 'Eli',
      domain: 'Engineering',
      workspace_id: 'ws-1',
      command_center_id: 'ws-1',
      workspace_name: 'Core Platform',
      initiative_name: 'Pipeline Refresh',
    });
  });

  it('hydrates handoff_task payload with workspace from task context and session fallback', async () => {
    const lookupEntity = vi.fn(async (type: string, id: string) => {
      if (type === 'task' && id === 'task-1') {
        return { id, workspace_id: 'ws-2', initiative_id: 'init-2' };
      }
      if (type === 'command_center' && id === 'ws-2') {
        return { id, name: 'Revenue Ops' };
      }
      return null;
    });

    const result = await normalizeAgentDispatchPayload({
      toolId: 'handoff_task',
      args: { task_id: 'task-1', agent: 'sales-agent' },
      data: { task_id: 'task-1', run_id: 'run-2' },
      sessionContext: {
        workspaceId: 'ws-2',
        workspaceName: 'Revenue Ops',
      },
      lookupEntity,
    });

    expect(result).toMatchObject({
      agent_id: 'sales-agent',
      agent_name: 'Sage',
      domain: 'Sales',
      workspace_id: 'ws-2',
      command_center_id: 'ws-2',
      workspace_name: 'Revenue Ops',
    });
  });

  it('hydrates handoff_task payload from alternate routing keys', async () => {
    const result = await normalizeAgentDispatchPayload({
      toolId: 'handoff_task',
      args: {
        task_id: 'task-1',
        target_agent_id: 'design-agent',
      },
      data: {
        task_id: 'task-1',
        workspaceName: 'The Loop Ships',
        commandCenterId: 'ws-loop',
      },
    });

    expect(result).toMatchObject({
      agent_id: 'design-agent',
      agent_name: 'Dana',
      domain: 'Design',
      workspace_id: 'ws-loop',
      command_center_id: 'ws-loop',
      workspace_name: 'The Loop Ships',
    });
  });

  it('preserves non-tools/call payloads', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return new Response('ok');
      }),
    };

    const authenticateRequest = vi.fn(async () => ({}));

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'tools/list' }),
    });

    await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      authenticateRequest
    );

    expect(received).toEqual({ method: 'tools/list' });
  });

  it('returns 204 with CORS headers for OPTIONS preflight', async () => {
    const handler = { fetch: vi.fn(async () => new Response('ok')) };
    const authenticateRequest = vi.fn(async () => ({}));
    const request = new Request('http://localhost/mcp', { method: 'OPTIONS' });

    const response = await handleMcpRequest(
      request,
      env,
      createCtx(),
      handler,
      authenticateRequest
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'POST'
    );
  });

  it('formats pre-tool transport exceptions as detectable JSON-RPC errors', async () => {
    const request = new Request('https://mcp.useorgx.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'bootstrap-1',
        method: 'tools/call',
        params: {
          name: 'orgx_bootstrap',
          arguments: { client_name: 'claude-code' },
        },
      }),
    });

    const response = await buildMcpTransportExceptionResponse(
      request,
      new TypeError('provider crashed'),
      { stage: 'oauth_provider' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-orgx-mcp-error-code')).toBe(
      'mcp_transport_exception'
    );
    expect(response.headers.get('x-orgx-mcp-error-kind')).toBe(
      'exception_typeerror'
    );
    expect(response.headers.get('x-orgx-mcp-error-stage')).toBe(
      'oauth_provider'
    );
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 'bootstrap-1',
      error: {
        code: -32603,
        data: {
          code: 'mcp_transport_exception',
          error_kind: 'exception_typeerror',
          stage: 'oauth_provider',
          retryable: true,
          health_check_url: 'https://mcp.useorgx.com/healthz?check=upstream',
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain('provider crashed');
  });
});
