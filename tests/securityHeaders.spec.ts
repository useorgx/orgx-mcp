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

  it('preserves stricter route-specific security headers', () => {
    const response = withSecurityHeaders(
      new Response('consent', {
        headers: {
          'content-security-policy':
            "default-src 'self'; form-action 'self' http://127.0.0.1:54321",
          'referrer-policy': 'no-referrer',
        },
      })
    );

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; form-action 'self' http://127.0.0.1:54321"
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
