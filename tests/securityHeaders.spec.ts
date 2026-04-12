import { describe, expect, it } from 'vitest';

import { SECURITY_HEADERS, withSecurityHeaders } from '../src/securityHeaders';

describe('securityHeaders', () => {
  it('adds hardening headers while preserving response status and existing headers', async () => {
    const response = withSecurityHeaders(
      new Response('missing token', {
        status: 401,
        headers: {
          'content-type': 'text/plain',
          'www-authenticate': 'Bearer realm="mcp"',
        },
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer realm="mcp"'
    );
    expect(await response.text()).toBe('missing token');

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it('does not wrap WebSocket upgrade responses', () => {
    const response = { status: 101 } as Response;

    expect(withSecurityHeaders(response)).toBe(response);
  });
});
