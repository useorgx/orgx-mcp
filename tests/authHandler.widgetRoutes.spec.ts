import { describe, expect, it, vi } from 'vitest';

import { authHandler } from '../src/authHandler';

describe('authHandler widget compatibility routes', () => {
  it('serves a derived Smithery server card from the worker origin', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/.well-known/mcp/server-card.json'),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://www.useorgx.com',
      },
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      serverInfo?: { name?: string; version?: string };
      authentication?: { required?: boolean; schemes?: string[] };
      tools?: Array<{ name?: string; inputSchema?: { type?: string } }>;
    };
    expect(body.serverInfo?.name).toBe('OrgX MCP');
    expect(body.serverInfo?.version).toBeTruthy();
    expect(body.authentication).toEqual({
      required: true,
      schemes: ['oauth2'],
    });
    expect(body.tools?.length).toBeGreaterThan(0);
    expect(body.tools?.[0]?.inputSchema?.type).toBe('object');
  });

  it('serves the live server.json manifest from the worker origin', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/server.json'),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://www.useorgx.com',
      },
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as {
      name?: string;
      websiteUrl?: string;
    };
    expect(body.name).toBe('com.useorgx/orgx-mcp');
    expect(body.websiteUrl).toBe('https://useorgx.com');
  });

  it('proxies /api/chatgpt/widgets requests through the assets binding', async () => {
    const assetsFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      expect(url).toBe(
        'https://mcp.useorgx.com/widgets/scaffolded-initiative.html'
      );
      return new Response('<html>scaffolded</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await authHandler.fetch(
      new Request(
        'https://mcp.useorgx.com/api/chatgpt/widgets/scaffolded-initiative.html',
        {
          headers: { accept: 'text/html' },
        }
      ),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://www.useorgx.com',
        ASSETS: {
          fetch: assetsFetch,
        },
      },
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('scaffolded');
    expect(assetsFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns an OAuth challenge for non-browser GET / discovery requests', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/', {
        headers: { accept: 'application/json' },
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://www.useorgx.com',
      },
      {} as ExecutionContext
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.useorgx.com/.well-known/oauth-protected-resource"'
    );
    const body = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(body.error).toBe('invalid_token');
    expect(body.error_description).toBe('Missing or invalid access token');
  });

  it('keeps GET / browser navigations on the landing page', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/', {
        headers: {
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'upgrade-insecure-requests': '1',
        },
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://www.useorgx.com',
      },
      {} as ExecutionContext
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://mcp.useorgx.com/index.html'
    );
  });

  it('keeps text/html callers on the landing page even without browser navigation headers', async () => {
    const response = await authHandler.fetch(
      new Request('https://mcp.useorgx.com/', {
        headers: { accept: 'text/html' },
      }),
      {
        MCP_SERVER_URL: 'https://mcp.useorgx.com',
        ORGX_WEB_URL: 'https://www.useorgx.com',
      },
      {} as ExecutionContext
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://mcp.useorgx.com/index.html'
    );
  });
});
