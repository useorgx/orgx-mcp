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
