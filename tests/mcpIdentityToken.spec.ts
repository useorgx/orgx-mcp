import { describe, expect, it, vi } from 'vitest';

import { authHandler } from '../src/authHandler';
import {
  signMcpIdentityToken,
  verifyMcpIdentityTokenDetailed,
} from '../src/mcpIdentityToken';

const SECRET = 'test-internal-secret';

function makeEnv() {
  const completeAuthorization = vi.fn(async () => ({
    redirectTo: 'https://client.example/callback?code=ok',
  }));
  const store = new Map<string, string>([
    [
      'auth_state:state-1',
      JSON.stringify({
        responseType: 'code',
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        scope: ['read', 'write'],
        state: 'client-state',
      }),
    ],
  ]);
  return {
    ORGX_API_URL: 'https://useorgx.com',
    ORGX_WEB_URL: 'https://useorgx.com',
    MCP_SERVER_URL: 'https://mcp.useorgx.com',
    AUTH_SERVER_URL: 'https://mcp.useorgx.com',
    MCP_JWT_SECRET: 'test-mcp-jwt-secret',
    ORGX_SERVICE_KEY: 'oxk-test',
    ORGX_INTERNAL_SECRET: SECRET,
    OAUTH_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      store,
    },
    OAUTH_PROVIDER: {
      completeAuthorization,
    },
    OAUTH_STATE: {},
    SCAFFOLD_SESSION: {},
    LIVE_FEED: {},
  } as any;
}

describe('MCP OAuth identity token', () => {
  it('verifies a signed web identity token bound to the OAuth state', async () => {
    const token = await signMcpIdentityToken({
      userId: 'user_123',
      email: 'Hope@Example.com',
      emailVerified: true,
      stateKey: 'state-1',
      secret: SECRET,
    });

    const result = await verifyMcpIdentityTokenDetailed(
      token,
      SECRET,
      'state-1'
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('user_123');
      expect(result.payload.email).toBe('hope@example.com');
    }
  });

  it('rejects a signed identity token for a different OAuth state', async () => {
    const token = await signMcpIdentityToken({
      userId: 'user_123',
      email: 'hope@example.com',
      stateKey: 'state-1',
      secret: SECRET,
    });

    await expect(
      verifyMcpIdentityTokenDetailed(token, SECRET, 'state-2')
    ).resolves.toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('rejects placeholder identities before OAuth is completed', async () => {
    const token = await signMcpIdentityToken({
      userId: 'user_123',
      email: 'user_123@placeholder.local',
      stateKey: 'state-1',
      secret: SECRET,
    });

    await expect(
      verifyMcpIdentityTokenDetailed(token, SECRET, 'state-1')
    ).resolves.toEqual({ ok: false, reason: 'placeholder_identity' });
  });

  it('stores the signed identity for consent instead of trusting raw browser params', async () => {
    const env = makeEnv();
    const token = await signMcpIdentityToken({
      userId: 'user_123',
      email: 'hope@example.com',
      stateKey: 'state-1',
      secret: SECRET,
    });

    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/oauth/callback?state_key=state-1&identity_token=${encodeURIComponent(
          token
        )}&user_id=attacker&user_email=attacker@example.com`
      ),
      env,
      {} as any
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/consent.html');
    expect(location.searchParams.get('state_key')).toBe('state-1');
    expect(location.searchParams.get('user_id')).toBeNull();
    expect(env.OAUTH_KV.store.get('auth_identity:state-1')).toBe(
      JSON.stringify({ userId: 'user_123', userEmail: 'hope@example.com' })
    );
    expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });

  it('rejects unsigned browser-supplied identity when the internal secret is configured', async () => {
    const env = makeEnv();

    const response = await authHandler.fetch(
      new Request(
        'https://mcp.useorgx.com/oauth/callback?state_key=state-1&user_id=victim&user_email=victim@example.com'
      ),
      env,
      {} as any
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=invalid_request');
    expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
    expect(env.OAUTH_KV.get).not.toHaveBeenCalled();
  });
});
