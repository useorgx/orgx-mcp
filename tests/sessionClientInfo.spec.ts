import { describe, expect, it, vi } from 'vitest';

import { handleMcpRequest } from '../src/mcpTransport';
import {
  getSessionClientInfo,
  parseInitializeClientInfo,
  putSessionClientInfo,
  resolveSessionClientInfoKv,
  SESSION_CLIENT_INFO_KV_PREFIX,
  SESSION_CLIENT_INFO_TTL_SECONDS,
} from '../src/sessionClientInfo';

function createFakeKv() {
  const store = new Map<string, unknown>();
  const puts: Array<{ key: string; options?: { expirationTtl?: number } }> = [];
  return {
    store,
    puts,
    kv: {
      get: vi.fn(async (key: string, _type: 'json') => store.get(key) ?? null),
      put: vi.fn(
        async (
          key: string,
          value: string,
          options?: { expirationTtl?: number }
        ) => {
          store.set(key, JSON.parse(value));
          puts.push({ key, options });
        }
      ),
    },
  };
}

function createTrackedCtx() {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(Promise.resolve(promise));
  });
  return {
    ctx: { waitUntil } as any,
    async drain() {
      while (pending.length > 0) {
        await Promise.allSettled(pending.splice(0));
      }
    },
  };
}

describe('sessionClientInfo', () => {
  it('parses clientInfo from an initialize request only', () => {
    expect(
      parseInitializeClientInfo({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'claude-code', version: '2.1.0' },
          capabilities: {},
        },
      })
    ).toEqual({ name: 'claude-code', version: '2.1.0' });

    expect(
      parseInitializeClientInfo({
        method: 'initialize',
        params: { clientInfo: { name: '   ' } },
      })
    ).toBeNull();
    expect(
      parseInitializeClientInfo({
        method: 'tools/call',
        params: { name: 'orgx_search' },
      })
    ).toBeNull();
    expect(parseInitializeClientInfo(null)).toBeNull();
  });

  it('round-trips clientInfo through KV with a bounded TTL', async () => {
    const { kv, puts } = createFakeKv();

    await putSessionClientInfo(kv, 'sess-1', {
      name: 'codex',
      version: '0.9.1',
    });
    expect(puts[0]).toEqual({
      key: `${SESSION_CLIENT_INFO_KV_PREFIX}sess-1`,
      options: { expirationTtl: SESSION_CLIENT_INFO_TTL_SECONDS },
    });
    expect(await getSessionClientInfo(kv, 'sess-1')).toEqual({
      name: 'codex',
      version: '0.9.1',
    });
    expect(await getSessionClientInfo(kv, 'sess-unknown')).toBeNull();
  });

  it('duck-types the OAUTH_KV binding', () => {
    const { kv } = createFakeKv();
    expect(resolveSessionClientInfoKv({ OAUTH_KV: kv })).toBe(kv);
    expect(resolveSessionClientInfoKv({})).toBeNull();
    expect(resolveSessionClientInfoKv({ OAUTH_KV: {} })).toBeNull();
    expect(resolveSessionClientInfoKv(undefined)).toBeNull();
  });

  it('persists initialize clientInfo keyed by the session id the server assigns', async () => {
    const { kv, store } = createFakeKv();
    const tracked = createTrackedCtx();
    const handler = {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-new',
          },
        })
      ),
    };

    await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            clientInfo: { name: 'claude-code', version: '2.1.0' },
            capabilities: {},
          },
        }),
      }),
      { OAUTH_KV: kv } as any,
      tracked.ctx,
      handler,
      vi.fn(async () => ({ userId: 'user-123' }))
    );
    await tracked.drain();

    expect(store.get(`${SESSION_CLIENT_INFO_KV_PREFIX}sess-new`)).toEqual({
      name: 'claude-code',
      version: '2.1.0',
    });
  });

  it('falls back to the handshake clientInfo for tool-call telemetry when the agent sent no _context', async () => {
    const { kv } = createFakeKv();
    await putSessionClientInfo(kv, 'sess-1', {
      name: 'claude-code',
      version: '2.1.0',
    });

    const telemetryFetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/internal/mcp/tool-invocations')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', telemetryFetch);

    try {
      const tracked = createTrackedCtx();
      const handler = {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          })
        ),
      };

      await handleMcpRequest(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-1',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'req-9',
            method: 'tools/call',
            params: {
              name: 'orgx_emit_activity',
              arguments: {
                initiative_id: '9b543d86-ea3e-47b8-8109-7160547f2745',
                message: 'progress',
              },
            },
          }),
        }),
        {
          ORGX_API_URL: 'https://useorgx.test',
          ORGX_SERVICE_KEY: 'oxk-service-test',
          OAUTH_KV: kv,
        } as any,
        tracked.ctx,
        handler,
        vi.fn(async () => ({ userId: 'user-123' }))
      );
      await tracked.drain();

      const backendCall = telemetryFetch.mock.calls.find(([url]) =>
        String(url).includes('/api/internal/mcp/tool-invocations')
      );
      expect(backendCall).toBeTruthy();
      const payload = JSON.parse(backendCall?.[1].body as string);
      expect(payload).toMatchObject({
        tool_id: 'orgx_emit_activity',
        client_name: 'claude-code',
        client_platform: 'claude',
        client_version: '2.1.0',
        metadata: expect.objectContaining({
          client_name: 'claude-code',
          client_version: '2.1.0',
          client_name_source: 'initialize_handshake',
        }),
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it('keeps explicit agent-supplied _context authoritative over the handshake', async () => {
    const { kv } = createFakeKv();
    await putSessionClientInfo(kv, 'sess-1', {
      name: 'claude-code',
      version: '2.1.0',
    });

    const telemetryFetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/internal/mcp/tool-invocations')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', telemetryFetch);

    try {
      const tracked = createTrackedCtx();
      const handler = {
        fetch: vi.fn(async () =>
          new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          })
        ),
      };

      await handleMcpRequest(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-1',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'req-10',
            method: 'tools/call',
            params: {
              name: 'orgx_emit_activity',
              arguments: {
                initiative_id: '9b543d86-ea3e-47b8-8109-7160547f2745',
                message: 'progress',
                _context: { client: { name: 'cursor', version: '1.5.0' } },
              },
            },
          }),
        }),
        {
          ORGX_API_URL: 'https://useorgx.test',
          ORGX_SERVICE_KEY: 'oxk-service-test',
          OAUTH_KV: kv,
        } as any,
        tracked.ctx,
        handler,
        vi.fn(async () => ({ userId: 'user-123' }))
      );
      await tracked.drain();

      const backendCall = telemetryFetch.mock.calls.find(([url]) =>
        String(url).includes('/api/internal/mcp/tool-invocations')
      );
      const payload = JSON.parse(backendCall?.[1].body as string);
      expect(payload).toMatchObject({
        client_name: 'cursor',
        client_platform: 'cursor',
        client_version: '1.5.0',
      });
      expect(payload.metadata.client_name_source).toBeUndefined();
      // No KV read was needed: agent context already carried the identity.
      expect(kv.get).not.toHaveBeenCalledWith(
        `${SESSION_CLIENT_INFO_KV_PREFIX}sess-1`,
        'json'
      );
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.unstubAllGlobals();
    }
  });
});
