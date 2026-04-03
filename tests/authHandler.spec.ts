import { describe, expect, it, vi } from 'vitest';

import { authHandler } from '../src/authHandler';

function createCtx() {
  return { waitUntil: vi.fn() } as any;
}

describe('authHandler root landing page routing', () => {
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
});
