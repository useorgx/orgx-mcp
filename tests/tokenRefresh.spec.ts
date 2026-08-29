import { describe, expect, it, vi } from 'vitest';

import { buildAuthErrorResponse, buildWwwAuthenticateHeader } from '../src/authErrors';
import { authenticateRequest } from '../src/requestAuth';
import {
  signSessionToken,
  verifySessionTokenDetailed,
} from '../src/sessionToken';
import {
  signStreamToken,
  verifyStreamTokenDetailed,
  withStreamTokenExpiry,
} from '../src/streamToken';

const TEST_SECRET = 'test-secret-for-token-refresh-tests-must-be-long-enough';

describe('buildWwwAuthenticateHeader', () => {
  it('formats RFC 6750 Bearer header with error + description', () => {
    const header = buildWwwAuthenticateHeader({
      error: 'invalid_token',
      description: 'Access token expired',
    });
    expect(header).toBe(
      'Bearer error="invalid_token", error_description="Access token expired"'
    );
  });

  it('appends resource_metadata when provided', () => {
    const header = buildWwwAuthenticateHeader({
      error: 'invalid_token',
      description: 'Token expired',
      resourceMetadataUrl: 'https://mcp.useorgx.com/.well-known/oauth-protected-resource',
    });
    expect(header).toContain(
      'resource_metadata="https://mcp.useorgx.com/.well-known/oauth-protected-resource"'
    );
  });

  it('escapes double quotes in the description', () => {
    const header = buildWwwAuthenticateHeader({
      error: 'invalid_token',
      description: 'Token "abc" expired',
    });
    expect(header).toContain('error_description="Token \\"abc\\" expired"');
  });
});

describe('buildAuthErrorResponse', () => {
  it('returns a 401 with WWW-Authenticate and a JSON body', async () => {
    const res = buildAuthErrorResponse({ reason: 'token_expired' });
    expect(res.status).toBe(401);

    const www = res.headers.get('WWW-Authenticate');
    expect(www).toContain('Bearer error="invalid_token"');
    expect(www).toContain('error_description="Access token expired');

    const body = (await res.json()) as {
      error: string;
      error_description: string;
      reason: string;
    };
    expect(body.error).toBe('invalid_token');
    expect(body.reason).toBe('token_expired');
    expect(body.error_description).toMatch(/expired/i);
  });

  it('marks the response as no-store so browsers never cache a 401', () => {
    const res = buildAuthErrorResponse({ reason: 'invalid_token' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('distinguishes stream and session expiry reasons in the body', async () => {
    const stream = buildAuthErrorResponse({ reason: 'stream_token_expired' });
    const streamBody = (await stream.json()) as { reason: string };
    expect(streamBody.reason).toBe('stream_token_expired');

    const session = buildAuthErrorResponse({ reason: 'session_expired' });
    const sessionBody = (await session.json()) as { reason: string };
    expect(sessionBody.reason).toBe('session_expired');
  });
});

describe('authenticateRequest', () => {
  const baseEnv = {
    MCP_SERVER_URL: 'https://mcp.useorgx.com',
    OAUTH_PROVIDER: {
      unwrapToken: vi.fn(),
    } as any,
  };

  it('returns anonymous when no Authorization header is present', async () => {
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path'),
      baseEnv
    );
    expect(result.response).toBeUndefined();
    expect(result.userId).toBeUndefined();
  });

  it('returns a 401 (not anonymous) when the Bearer token is invalid', async () => {
    const env = {
      ...baseEnv,
      OAUTH_PROVIDER: { unwrapToken: vi.fn().mockResolvedValue(null) } as any,
    };
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path', {
        headers: { authorization: 'Bearer bogus-token' },
      }),
      env
    );

    expect(result.userId).toBeUndefined();
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(401);
    const www = result.response!.headers.get('WWW-Authenticate');
    expect(www).toContain('Bearer error="invalid_token"');
    expect(www).toContain('resource_metadata=');
  });

  it('rejects a non-Bearer scheme with 401', async () => {
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path', {
        headers: { authorization: 'Basic Zm9vOmJhcg==' },
      }),
      baseEnv
    );
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(401);
  });

  it('rejects a malformed Bearer header with 401', async () => {
    // `authorization: 'Bearer '` — HTTP header normalization trims trailing
    // whitespace, so this lands as plain `'Bearer'` without a token. The
    // scheme check must still produce a 401, not silently fall through to
    // anonymous.
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path', {
        headers: { authorization: 'Bearer ' },
      }),
      baseEnv
    );
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(401);
    const www = result.response!.headers.get('WWW-Authenticate');
    expect(www).toContain('Bearer error="invalid_token"');
  });

  it('returns a 401 when unwrapToken throws', async () => {
    const env = {
      ...baseEnv,
      OAUTH_PROVIDER: {
        unwrapToken: vi.fn().mockRejectedValue(new Error('kv read failed')),
      } as any,
    };
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path', {
        headers: { authorization: 'Bearer token' },
      }),
      env
    );
    expect(result.response).toBeDefined();
    expect(result.response!.status).toBe(401);
    const body = (await result.response!.json()) as { error_description: string };
    // Exception details must never leak to the client.
    expect(body.error_description).not.toContain('kv read failed');
  });

  it('honours DEV_USER_ID for local development without requiring a token', async () => {
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path'),
      { ...baseEnv, DEV_USER_ID: 'dev-user-1' }
    );
    expect(result.response).toBeUndefined();
    expect(result.userId).toBe('dev-user-1');
  });

  it('returns authenticated props when unwrapToken succeeds', async () => {
    const orgxUserId = '5c52c8ca-c1d0-48cc-a177-9cf1ac2c5b06';
    const env = {
      ...baseEnv,
      OAUTH_PROVIDER: {
        unwrapToken: vi.fn().mockResolvedValue({
          grant: {
            props: {
              userId: 'u1',
              orgxUserId,
              scope: 'read write',
              email: 'u@example.com',
            },
          },
        }),
      } as any,
    };
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path', {
        headers: { authorization: 'Bearer valid-token' },
      }),
      env
    );
    expect(result.response).toBeUndefined();
    expect(result.userId).toBe('u1');
    expect(result.orgxUserId).toBe(orgxUserId);
    expect(result.scope).toBe('read write');
    expect(result.email).toBe('u@example.com');
  });

  it('drops a malformed canonical user id from OAuth grant props', async () => {
    const result = await authenticateRequest(
      new Request('https://mcp.useorgx.com/some/path', {
        headers: { authorization: 'Bearer valid-token' },
      }),
      {
        ...baseEnv,
        OAUTH_PROVIDER: {
          unwrapToken: vi.fn().mockResolvedValue({
            grant: {
              props: {
                userId: 'u1',
                orgxUserId: 'not-a-uuid',
                scope: 'read write',
                email: 'u@example.com',
              },
            },
          }),
        } as any,
      }
    );

    expect(result.userId).toBe('u1');
    expect(result.orgxUserId).toBeUndefined();
  });
});

describe('verifyStreamTokenDetailed', () => {
  it('returns { ok: true } for a valid token', async () => {
    const token = await signStreamToken({
      feedType: 'scaffold',
      feedId: 'sess-1',
      secret: TEST_SECRET,
    });
    const result = await verifyStreamTokenDetailed(token, TEST_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.ft).toBe('scaffold');
  });

  it('returns { ok: false, reason: "expired" } for an expired token', async () => {
    // Sign, then advance mocked clock past the 1h TTL.
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const token = await signStreamToken({
      feedType: 'scaffold',
      feedId: 'sess-1',
      secret: TEST_SECRET,
    });
    vi.setSystemTime(t0 + 60 * 60 * 1000 + 1000);
    const result = await verifyStreamTokenDetailed(token, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
    vi.useRealTimers();
  });

  it('returns { ok: false, reason: "invalid" } for a signature mismatch', async () => {
    const token = await signStreamToken({
      feedType: 'scaffold',
      feedId: 'sess-1',
      secret: TEST_SECRET,
    });
    const result = await verifyStreamTokenDetailed(token, 'wrong-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('returns { ok: false, reason: "invalid" } for malformed input', async () => {
    const result = await verifyStreamTokenDetailed('not-a-token', TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });
});

describe('verifySessionTokenDetailed', () => {
  it('returns { ok: true } for a valid token', async () => {
    const token = await signSessionToken({
      sessionId: 'sid-1',
      orgId: 'org-1',
      userId: 'u1',
      scopes: ['agents:read'],
      secret: TEST_SECRET,
    });
    const result = await verifySessionTokenDetailed(token, TEST_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.sid).toBe('sid-1');
  });

  it('returns { ok: false, reason: "expired" } past TTL', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const token = await signSessionToken({
      sessionId: 'sid-1',
      orgId: 'org-1',
      userId: 'u1',
      scopes: ['agents:read'],
      secret: TEST_SECRET,
    });
    vi.setSystemTime(t0 + 60 * 60 * 1000 + 1000);
    const result = await verifySessionTokenDetailed(token, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
    vi.useRealTimers();
  });

  it('returns { ok: false, reason: "invalid" } for bad signature', async () => {
    const token = await signSessionToken({
      sessionId: 'sid-1',
      orgId: 'org-1',
      userId: 'u1',
      scopes: ['agents:read'],
      secret: TEST_SECRET,
    });
    const result = await verifySessionTokenDetailed(token, 'wrong-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });
});

describe('withStreamTokenExpiry', () => {
  it('passes non-SSE responses through unchanged', () => {
    const res = new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    });
    const wrapped = withStreamTokenExpiry(res, Date.now() + 60_000);
    expect(wrapped).toBe(res);
  });

  it('emits event: auth_expired before exp and then closes the stream', async () => {
    // Build a real SSE-shaped response that keeps pushing events forever.
    const encoder = new TextEncoder();
    let pushInterval: ReturnType<typeof setInterval> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        pushInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode('data: ping\n\n'));
          } catch {
            // controller closed — stop pushing
            if (pushInterval) clearInterval(pushInterval);
          }
        }, 5);
      },
      cancel() {
        if (pushInterval) clearInterval(pushInterval);
      },
    });
    const res = new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });

    // Exp is 50ms from now; margin is 10ms → auth_expired fires at ~40ms.
    const expMs = Date.now() + 50;
    const wrapped = withStreamTokenExpiry(res, expMs, 10);

    const reader = wrapped.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawAuthExpired = false;
    const deadline = Date.now() + 500;
    // Pull until we either see the auth_expired event or time out. A healthy
    // implementation must emit the event and close the stream well before
    // the deadline — otherwise the test catches a regression.
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buf += decoder.decode(value);
      if (buf.includes('event: auth_expired')) {
        sawAuthExpired = true;
        break;
      }
    }

    expect(sawAuthExpired).toBe(true);
    expect(buf).toContain('stream_token_expired');

    // The stream must have actually closed so the client stops reading.
    const tail = await reader.read();
    expect(tail.done).toBe(true);

    if (pushInterval) clearInterval(pushInterval);
  });
});
