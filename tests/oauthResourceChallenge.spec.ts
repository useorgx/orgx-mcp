import { describe, expect, it } from 'vitest';

import { withPathScopedResourceChallenge } from '../src/oauthResourceChallenge';

function oauthChallenge(metadataUrl: string): Response {
  return Response.json(
    {
      error: 'invalid_token',
      error_description: 'Missing or invalid access token',
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${metadataUrl}", error="invalid_token"`,
      },
    }
  );
}

describe('withPathScopedResourceChallenge', () => {
  it.each(['/mcp', '/sse'])(
    'advertises path-specific protected-resource metadata for %s',
    async (path) => {
      const original = oauthChallenge(
        'https://mcp.useorgx.com/.well-known/oauth-protected-resource'
      );

      const response = withPathScopedResourceChallenge(
        new Request(`https://mcp.useorgx.com${path}`),
        original
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(
        `resource_metadata="https://mcp.useorgx.com/.well-known/oauth-protected-resource${path}"`
      );
      expect(await response.json()).toEqual({
        error: 'invalid_token',
        error_description: 'Missing or invalid access token',
      });
    }
  );

  it('appends resource metadata when a Bearer challenge omits it', () => {
    const response = withPathScopedResourceChallenge(
      new Request('http://127.0.0.1:8787/mcp'),
      new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="OAuth"' },
      })
    );

    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it.each([
    ['non-401 responses', new Request('https://mcp.useorgx.com/mcp'), new Response('ok')],
    [
      'unprotected paths',
      new Request('https://mcp.useorgx.com/health'),
      oauthChallenge('https://mcp.useorgx.com/.well-known/oauth-protected-resource'),
    ],
    [
      'non-Bearer challenges',
      new Request('https://mcp.useorgx.com/mcp'),
      new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="legacy"' },
      }),
    ],
  ])('leaves %s unchanged', (_label, request, original) => {
    expect(withPathScopedResourceChallenge(request, original)).toBe(original);
  });
});
