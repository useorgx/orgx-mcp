import { describe, expect, it, vi } from 'vitest';

import { handleMcpRequest } from '../src/mcpTransport';

const env = {} as unknown as Record<string, unknown>;

function createCtx() {
  return { waitUntil: vi.fn() } as any;
}

describe('mcpTransport', () => {
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
    expect(ctx.props).toEqual({ userId: 'user-123', scope: 'mcp:all' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    }
  );

  it('routes get_pending_decisions to list_entities and adds deprecation headers', async () => {
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

    expect(received?.params?.name).toBe('list_entities');
    expect(received?.params?.arguments).toEqual({
      type: 'decision',
      status: 'pending',
      limit: 3,
      initiative_id: 'init-123',
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'get_pending_decisions'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'list_entities'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
  });

  it('preserves deprecated tool calls that cannot be safely rerouted yet', async () => {
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

    expect(received?.params?.name).toBe('get_pending_decisions');
    expect(received?.params?.arguments).toEqual({ urgency_filter: 'high' });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'get_pending_decisions'
    );
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('false');
  });

  it('routes get_decision_history to query_org_memory when no legacy-only filters are used', async () => {
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

    expect(received?.params?.name).toBe('query_org_memory');
    expect(received?.params?.arguments).toEqual({
      query: 'pricing',
      scope: 'decisions',
      limit: 2,
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'get_decision_history'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe(
      'query_org_memory'
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
});
