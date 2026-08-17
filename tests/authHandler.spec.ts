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

  it('publishes the same versioned authorization policy used by consent', async () => {
    const response = await authHandler.fetch(
      new Request(
        'https://mcp.useorgx.com/.well-known/orgx-authorization-policy'
      ),
      {},
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: '2026-08-15.v1',
      scopesSupported: expect.arrayContaining([
        'decisions:read',
        'initiatives:write',
        'offline_access',
      ]),
    });
  });

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
    expect([...location.searchParams.keys()]).toEqual(['state_key']);
    expect(location.searchParams.get('scope')).toBeNull();
    expect(location.searchParams.get('redirect_uri')).toBeNull();
    expect(location.searchParams.get('user_email')).toBeNull();
    expect(location.searchParams.get('user_id')).toBeNull();
    expect(kv.store.has(`auth_state:${stateKey}`)).toBe(true);
    expect(kv.store.has(`auth_identity:${stateKey}`)).toBe(true);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('fails closed on unsigned production callback identity when the signing secret is missing', async () => {
    const stateKey = 'state-unsigned-production';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
    });
    const completeAuthorization = vi.fn();

    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/oauth/callback?state_key=${stateKey}&user_id=victim&user_email=victim@example.com`
      ),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/error.html');
    expect(location.searchParams.get('error')).toBe('server_error');
    expect(kv.store.has(`auth_identity:${stateKey}`)).toBe(false);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('keeps unsigned query identity available only for loopback development', async () => {
    const stateKey = 'state-local-development';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
    });

    const response = await authHandler.fetch(
      new Request(
        `http://127.0.0.1:8787/oauth/callback?state_key=${stateKey}&user_id=local-user&user_email=local@example.com`
      ),
      {
        MCP_SERVER_URL: 'http://127.0.0.1:8787',
        ORGX_WEB_URL: 'http://127.0.0.1:3000',
        OAUTH_KV: kv,
      },
      createCtx()
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/consent.html');
    expect(kv.store.get(`auth_identity:${stateKey}`)).toBe(
      JSON.stringify({ userId: 'local-user', userEmail: 'local@example.com' })
    );
  });

  it('loads consent display data and the canonical policy from opaque server state', async () => {
    const stateKey = 'state-consent-display';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });

    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/oauth/consent-session?state_key=${stateKey}`
      ),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
      },
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({
      client: {
        id: 'chatgpt-test-client',
        name: 'ChatGPT',
        icon: 'chatgpt',
        identity_trust: 'verified_redirect',
        redirect_host: 'chatgpt.com',
      },
      account: {
        email: 'user@example.com',
        scope_boundary: 'accessible_workspaces',
      },
      authorization_policy: {
        version: '2026-08-15.v1',
      },
      offline_access_requested: true,
    });
    expect(body.requested_scopes).toContain('initiatives:write');
    expect(JSON.stringify(body)).not.toContain('client-state-1');
  });

  it('preserves the expected MCP client icon range without overstating registered names as verified', async () => {
    const registeredClients = [
      ['ChatGPT', 'chatgpt'],
      ['OpenAI Codex', 'codex'],
      ['Claude Code', 'claude'],
      ['Cursor', 'cursor'],
      ['Visual Studio Code', 'vscode'],
      ['GitHub Copilot', 'github_copilot'],
      ['Windsurf', 'windsurf'],
      ['Zed', 'zed'],
      ['Cline', 'cline'],
      ['Roo Code', 'roo_code'],
      ['Continue', 'continue'],
      ['Raycast', 'raycast'],
      ['Gemini CLI', 'gemini'],
      ['Goose', 'goose'],
      ['OpenClaw', 'openclaw'],
      ['OpenCode', 'opencode'],
    ] as const;

    for (const [clientName, icon] of registeredClients) {
      const kv = createKv();
      const parsedRequest = {
        ...authRequest,
        clientId: `registered-${icon}`,
        redirectUri: 'http://127.0.0.1:54321/oauth/callback',
      };
      const response = await authHandler.fetch(
        new Request(
          `https://mcp.useorgx.com/authorize?client_id=${parsedRequest.clientId}`
        ),
        {
          MCP_SERVER_URL: 'https://mcp.useorgx.com',
          ORGX_WEB_URL: 'https://useorgx.com',
          OAUTH_KV: kv,
          OAUTH_PROVIDER: {
            parseAuthRequest: vi.fn(async () => parsedRequest),
            lookupClient: vi.fn(async () => ({
              clientId: parsedRequest.clientId,
              clientName,
              redirectUris: [parsedRequest.redirectUri],
            })),
          },
        },
        createCtx()
      );

      expect(response.status).toBe(302);
      const stored = [...kv.store.entries()].find(([key]) =>
        key.startsWith('auth_state:')
      );
      expect(stored, `stored authorization state for ${clientName}`).toBeDefined();
      expect(JSON.parse(stored![1])).toMatchObject({
        clientPresentation: {
          name: clientName,
          icon,
          identityTrust: 'registered_metadata',
        },
      });
    }
  });

  it('marks only product-controlled callback domains as verified client identities', async () => {
    const verifiedClients = [
      ['https://chatgpt.com/connector_platform_oauth_redirect', 'chatgpt'],
      ['https://oauth.cursor.com/callback', 'cursor'],
      ['https://claude.ai/oauth/callback', 'claude'],
      ['https://vscode.dev/redirect', 'vscode'],
      ['https://windsurf.com/oauth/callback', 'windsurf'],
      ['https://zed.dev/oauth/callback', 'zed'],
      ['https://raycast.com/oauth/callback', 'raycast'],
      ['https://geminicli.com/oauth/callback', 'gemini'],
      ['https://cline.bot/oauth/callback', 'cline'],
      ['https://roocode.com/oauth/callback', 'roo_code'],
      ['https://continue.dev/oauth/callback', 'continue'],
      ['https://opencode.ai/oauth/callback', 'opencode'],
    ] as const;

    for (const [redirectUri, icon] of verifiedClients) {
      const stateKey = `verified-${icon}`;
      const kv = createKv({
        [`auth_state:${stateKey}`]: JSON.stringify({
          ...authRequest,
          clientId: `client-${icon}`,
          redirectUri,
        }),
        [`auth_identity:${stateKey}`]: JSON.stringify({
          userId: 'user-1',
          userEmail: 'user@example.com',
        }),
      });
      const response = await authHandler.fetch(
        new Request(
          `https://mcp.useorgx.com/oauth/consent-session?state_key=${stateKey}`
        ),
        {
          MCP_SERVER_URL: 'https://mcp.useorgx.com',
          ORGX_WEB_URL: 'https://useorgx.com',
          OAUTH_KV: kv,
        },
        createCtx()
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        client: { icon, identity_trust: 'verified_redirect' },
      });
    }
  });

  it('does not infer a trusted client brand from attacker-controlled substrings', async () => {
    const stateKey = 'state-unverified-client';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify({
        ...authRequest,
        clientId: 'codex-chatgpt-openai-looking-client',
        redirectUri: 'https://attacker.example/codex/chatgpt.com/callback',
      }),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });

    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/oauth/consent-session?state_key=${stateKey}`
      ),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
      },
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      client: {
        name: 'Unverified MCP application',
        icon: 'unverified',
        identity_trust: 'unverified',
      },
    });
  });

  it('rejects GET consent callbacks without consuming authorization state', async () => {
    const stateKey = 'state-consent-get';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });
    const completeAuthorization = vi.fn();

    const response = await authHandler.fetch(
      new Request(
        `https://mcp.useorgx.com/oauth/consent-callback?state_key=${stateKey}&action=approve`
      ),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(kv.store.has(`auth_state:${stateKey}`)).toBe(true);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('rejects approval when the explicit scope selection is missing', async () => {
    const stateKey = 'state-consent-missing-selection';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });
    const completeAuthorization = vi.fn();

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/oauth/consent-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state_key: stateKey,
          action: 'approve',
        }),
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(kv.store.has(`auth_state:${stateKey}`)).toBe(true);
  });

  it('never grants supported scopes that the client did not request', async () => {
    const stateKey = 'state-consent-empty-request';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify({ ...authRequest, scope: [] }),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });
    const completeAuthorization = vi.fn();

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/oauth/consent-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state_key: stateKey,
          final_scope: 'initiatives:write agents:write',
          action: 'approve',
        }),
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_request'
    );
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
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const finalScope = [
      'decisions:read',
      'memory:read',
      'memory:write',
      'planning:read',
      'initiatives:write',
      'offline_access',
    ].join(' ');

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/oauth/consent-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state_key: stateKey,
          final_scope: finalScope,
          action: 'approve',
        }),
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        ORGX_INTERNAL_SECRET: secret,
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );
    const logged = JSON.stringify(consoleInfo.mock.calls);
    consoleInfo.mockRestore();

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
    expect(logged).toContain('https://chatgpt.com/callback');
    expect(logged).not.toContain('code=abc');
    expect(logged).not.toContain('client-state-1');
  });

  it('denies through the stored callback instead of trusting browser redirect data', async () => {
    const stateKey = 'state-consent-deny';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });
    const completeAuthorization = vi.fn();

    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/oauth/consent-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state_key: stateKey,
          action: 'deny',
          redirect_uri: 'https://attacker.example/callback',
        }),
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
        OAUTH_PROVIDER: { completeAuthorization },
      },
      createCtx()
    );

    const location = new URL(response.headers.get('location')!);
    expect(response.status).toBe(302);
    expect(location.origin).toBe('https://chatgpt.com');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('client-state-1');
    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(kv.store.has(`auth_state:${stateKey}`)).toBe(false);
    expect(kv.store.has(`auth_identity:${stateKey}`)).toBe(false);
  });

  it('keeps consent state retryable when grant creation fails', async () => {
    const stateKey = 'state-consent-retry';
    const kv = createKv({
      [`auth_state:${stateKey}`]: JSON.stringify(authRequest),
      [`auth_identity:${stateKey}`]: JSON.stringify({
        userId: 'user-1',
        userEmail: 'user@example.com',
      }),
    });

    await authHandler.fetch(
      new Request('https://mcp.useorgx.com/oauth/consent-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state_key: stateKey,
          final_scope: 'initiatives:read',
          action: 'approve',
        }),
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://useorgx.com',
        OAUTH_KV: kv,
        OAUTH_PROVIDER: {
          completeAuthorization: vi.fn(async () => {
            throw new Error('provider temporarily unavailable');
          }),
        },
      },
      createCtx()
    );

    expect(kv.store.has(`auth_state:${stateKey}`)).toBe(true);
    expect(kv.store.has(`auth_identity:${stateKey}`)).toBe(true);
  });
});
