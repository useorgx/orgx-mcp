import { describe, expect, it, vi } from 'vitest';

import { authHandler } from '../src/authHandler';

describe('authHandler widget compatibility routes', () => {
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
});
