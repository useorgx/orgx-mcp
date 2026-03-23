import { describe, expect, it, vi } from 'vitest';

import { handleMcpRequest } from '../src/mcpTransport';

const env = {} as Record<string, unknown>;

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
