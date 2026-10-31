import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMcpRequest } from '../src/mcpTransport';
import { authenticateRequest } from '../src/requestAuth';

const account = '11111111-1111-4111-8111-111111111111';
const attempt = '22222222-2222-4222-8222-222222222222';
const forged = '33333333-3333-4333-8333-333333333333';
afterEach(() => vi.unstubAllGlobals());

describe('trusted OAuth grant telemetry through the canonical invocation', () => {
  it.each([false, true])('carries attempt and preserves grant optout=%s without a DNT request header', async (telemetryOptOut) => {
    const fetchMock = vi.fn(async () => Response.json({ status: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const props = { userId: 'user_clerk', orgxUserId: account, scope: 'memory:read', pairingAttemptId: attempt, telemetryOptOut };
    const env = { MCP_SERVER_URL: 'https://mcp.useorgx.test', POSTHOG_KEY: 'phc_fixture',
      OAUTH_PROVIDER: { unwrapToken: vi.fn(async () => ({ grant: { props } })) } };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext;
    const request = new Request('https://mcp.useorgx.test/mcp', { method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orgx_search',
        arguments: { query: 'status', pairing_attempt_id: forged, _context: { pairing_attempt_id: forged } } } }) });
    const handler = { fetch: vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1,
      result: { content: [], structuredContent: { ok: true, results: [] } } })) };
    expect((await handleMcpRequest(request, env, ctx, handler, authenticateRequest)).status).toBe(200);
    while (pending.length) await Promise.all(pending.splice(0));
    if (telemetryOptOut) expect(fetchMock).not.toHaveBeenCalled();
    else {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(payload.batch[0]).toMatchObject({ event: 'mcp_tool_invocation', distinct_id: account,
        properties: { pairing_attempt_id: attempt, event_outcome: 'success', mcp_response_observed: true } });
      expect(JSON.stringify(payload)).not.toContain(forged);
    }
  });
});
