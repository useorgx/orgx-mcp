import { describe, expect, it, vi } from 'vitest';

import { callOrgxApiRaw } from '../src/orgxApi';

function decodeActorToken(token: string) {
  const [payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    type: string;
    aud: string;
    iss: string;
    sub: string;
    email?: string;
    exp: number;
  };
}

describe('callOrgxApiRaw actor token propagation', () => {
  it('sends a signed short-lived actor assertion with service requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await callOrgxApiRaw(
      {
        ORGX_API_URL: 'https://api.useorgx.test',
        ORGX_SERVICE_KEY: 'oxk-test',
        ORGX_INTERNAL_SECRET: 'test-internal-secret',
      },
      '/api/flywheel/briefs',
      undefined,
      { userId: 'user_123', userEmail: 'Hope@Example.com' }
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    const actorToken = headers.get('x-orgx-actor-token');
    expect(actorToken).toBeTruthy();

    const payload = decodeActorToken(actorToken!);
    expect(payload).toMatchObject({
      type: 'orgx.mcp.actor.v1',
      aud: 'orgx-api',
      iss: 'orgx-mcp',
      sub: 'user_123',
      email: 'hope@example.com',
    });
    expect(payload.exp).toBeGreaterThan(Date.now());
  });
});
