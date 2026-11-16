import { describe, expect, it, vi } from 'vitest';
import { authHandler } from '../src/authHandler';

describe('OAuth authorization diagnostic privacy', () => {
  const callback = 'https://chatgpt.com/connector_platform_oauth_redirect?token=callback-private-fixture';
  const clientId = 'client-private-fixture';
  const scope = ['initiatives:read', 'memory:read'];
  const authRequest = {
    responseType: 'code', clientId, redirectUri: callback, scope,
    state: 'client-state-private-fixture', codeChallenge: 'pkce-private-fixture',
    codeChallengeMethod: 'S256',
  };

  it.each(['success', 'parse-error', 'client-metadata-error'])(
    'keeps callback and provider error material out of native logs (%s)',
    async (scenario) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stored = new Map<string, string>();
      const requestUrl = new URL('https://mcp.useorgx.com/authorize');
      requestUrl.searchParams.set('client_id', clientId);
      requestUrl.searchParams.set('redirect_uri', callback);
      requestUrl.searchParams.set('scope', scope.join(' '));
      requestUrl.searchParams.set('response_type', 'code');
      requestUrl.searchParams.set('code_challenge_method', 'S256');
      const providerError = new Error(`provider-error-private-fixture: ${requestUrl}`);
      try {
        const response = await authHandler.fetch(new Request(requestUrl, {
          headers: { 'user-agent': 'user-agent-private-fixture', 'cf-worker': 'worker-header-private-fixture' },
        }), {
          MCP_SERVER_URL: 'https://mcp.useorgx.com', ORGX_WEB_URL: 'https://useorgx.com',
          OAUTH_KV: {
            put: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
          },
          OAUTH_PROVIDER: {
            parseAuthRequest: vi.fn(async () => {
              if (scenario === 'parse-error') throw providerError;
              return authRequest;
            }),
            lookupClient: vi.fn(async () => {
              if (scenario === 'client-metadata-error') throw providerError;
              return null;
            }),
          },
        } as any, { waitUntil: vi.fn() } as any);
        expect(response.status).toBe(302);
        const logText = JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
        for (const privateValue of [callback, clientId, ...scope, 'provider-error-private-fixture',
          'user-agent-private-fixture', 'worker-header-private-fixture', authRequest.state, authRequest.codeChallenge]) {
          expect(logText).not.toContain(privateValue);
        }
        expect(logText).toContain('hasRedirectUri');
        if (scenario === 'parse-error') {
          expect(stored.size).toBe(0);
          expect(new URL(response.headers.get('location')!).pathname).toBe('/error.html');
        } else {
          expect(stored.size).toBe(1);
          // Only diagnostics change: the provider-validated request stays exact in KV.
          expect(JSON.parse([...stored.values()][0])).toMatchObject(authRequest);
          expect(new URL(response.headers.get('location')!).pathname).toBe('/sign-in');
          expect(logText).toContain('scopeCount');
        }
      } finally {
        info.mockRestore(); error.mockRestore(); warn.mockRestore();
      }
    }
  );
});
