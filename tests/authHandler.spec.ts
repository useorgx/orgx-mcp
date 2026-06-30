import { describe, expect, it, vi } from 'vitest';

import { authHandler } from '../src/authHandler';
import { signMcpIdentityToken } from '../src/mcpIdentityToken';

function createCtx() {
  return { waitUntil: vi.fn() } as any;
}

function createKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    store,
  };
}

describe('authHandler root landing page routing', () => {
  it('reports a healthy fallback upstream when the primary API is unreachable', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('primary timeout'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'healthy' })));
    vi.stubGlobal('fetch', fetchMock);

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/healthz?check=upstream'),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_API_URL: 'https://primary.useorgx.test',
        ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
        ORGX_WEB_URL: 'https://useorgx.com',
      },
      createCtx()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      upstream: 'fallback_healthy',
      apiUrl: 'https://fallback.useorgx.test',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves index.html for unauthenticated browser GET / requests when assets are available', async () => {
    const assetResponse = new Response('<html>landing</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const env = {
      MCP_SERVER_URL: 'https://mcp.useorgx.com',
      ORGX_WEB_URL: 'https://useorgx.com',
      ASSETS: {
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const request = input instanceof Request ? input : new Request(input);
          expect(new URL(request.url).pathname).toBe('/index.html');
          expect(request.method).toBe('GET');
          return assetResponse;
        }),
      },
    } as any;

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
      env,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('landing');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });

  it('redirects to /index.html when assets are unavailable', async () => {
    const env = {
      MCP_SERVER_URL: 'https://mcp.useorgx.com',
      ORGX_WEB_URL: 'https://useorgx.com',
      ASSETS: {
        fetch: vi.fn(async () => new Response('missing', { status: 404 })),
      },
    } as any;

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
      env,
      createCtx()
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://mcp.useorgx.com/index.html'
    );
  });

  it('serves the Hope UX walkthrough from the clean /hope-ux route', async () => {
    const env = {
      MCP_SERVER_URL: 'https://mcp.useorgx.com',
      ORGX_WEB_URL: 'https://useorgx.com',
      ASSETS: {
        fetch: vi.fn(async (input: RequestInfo | URL) => {
          const request = input instanceof Request ? input : new Request(input);
          expect(new URL(request.url).pathname).toBe('/hope-ux.html');
          return new Response('<html><title>Hope UX</title></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }),
      },
    } as any;

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/hope-ux', {
        method: 'GET',
        headers: { accept: 'text/html' },
      }),
      env,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hope UX');
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps Cursor generated config writes scoped to the OrgX namespace', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/cursor/config'),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
      },
      createCtx()
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      overlay?: {
        manifest?: string;
        lookupPaths?: string[];
        writePolicy?: {
          automaticWrites?: boolean;
          allowedPaths?: string[];
          deniedPaths?: string[];
        };
      };
      localWritePolicy?: {
        automaticWrites?: boolean;
        allowedPaths?: string[];
        deniedPaths?: string[];
      };
    };

    expect(body.overlay?.manifest).toBe('.cursor/orgx/manifest.json');
    expect(body.overlay?.lookupPaths).toEqual(['.cursor/orgx']);
    expect(body.localWritePolicy?.automaticWrites).toBe(false);
    expect(body.localWritePolicy?.allowedPaths).toEqual([
      '.cursor/orgx/**',
      '~/.cursor/mcp.json',
    ]);
    expect(body.localWritePolicy?.deniedPaths).toEqual([
      '.cursor/commands/**',
      '.cursor/rules/**',
      '.claude/**',
    ]);
    expect(body.overlay?.lookupPaths).not.toContain('.cursor/commands');
    expect(body.overlay?.lookupPaths).not.toContain('.cursor/rules');
  });

  it('does not advertise Claude local file writes in hosted config output', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/claude-code/config'),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
      },
      createCtx()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('.claude');
  });
});

describe('authHandler OAuth consent flow', () => {
  const secret = 'test-secret-for-mcp-identity-token';
  const authRequest = {
    responseType: 'code',
    clientId: 'chatgpt-test-client',
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: [
      'decisions:read',
      'decisions:write',
      'agents:read',
      'agents:write',
      'initiatives:read',
      'initiatives:write',
      'memory:read',
      'offline_access',
    ],
    state: 'client-state-1',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
  };

  it('redirects verified users to the consent page instead of auto-approving scopes', async () => {
    const stateKey = 'state-consent-1';
    const identityToken = await signMcpIdentityToken({
      userId: 'user-1',
      email: 'user@example.com',
      stateKey,
      secret,
    });
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
    });
    const completeAuthorization = vi.fn();

    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/oauth/callback?state_key=${stateKey}&identity_token=${encodeURIComponent(
          identityToken
        )}`
      ),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        ORGX_INTERNAL_SECRET: secret,
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/consent.html');
    expect(location.searchParams.get('state_key')).toBe(stateKey);
    expect(location.searchParams.get('scope')).toContain('decisions:write');
    expect(location.searchParams.get('user_id')).toBeNull();
    expect(kv.store.has(`auth_state:${stateKey}`)).toBe(true);
    expect(kv.store.has(`auth_identity:${stateKey}`)).toBe(true);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('completes authorization with consent-selected scopes clamped to requested supported scopes', async () => {
    const stateKey = 'state-consent-2';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: 'https://chatgpt.com/callback?code=abc&state=client-state-1',
    }));
    const finalScope = [
      'decisions:read',
      'memory:read',
      'memory:write',
      'planning:read',
      'initiatives:write',
      'offline_access',
    ].join(' ');

    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/oauth/consent-callback?state_key=${stateKey}&final_scope=${encodeURIComponent(
          finalScope
        )}`
      ),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        ORGX_INTERNAL_SECRET: secret,
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://chatgpt.com/callback?code=abc&state=client-state-1'
    );
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        request: authRequest,
        userId: 'user-1',
        scope: [
          'decisions:read',
          'memory:read',
          'initiatives:write',
          'offline_access',
        ],
        props: {
          userId: 'user-1',
          scope:
            'decisions:read memory:read initiatives:write offline_access',
          email: 'user@example.com',
        },
      })
    );
    expect(kv.store.has(`auth_state:${stateKey}`)).toBe(false);
    expect(kv.store.has(`auth_identity:${stateKey}`)).toBe(false);
  });
});
