import { describe, it, expect } from 'vitest';
import { buildAuthErrorResponse } from '../src/authErrors';

// Every auth failure surfaced to a client should name the remedy, so an expired
// token reads as "re-authorize" instead of an opaque error.
describe('auth error responses are actionable', () => {
  for (const reason of ['missing_token', 'invalid_token'] as const) {
    it(`${reason} tells the client to re-authorize`, async () => {
      const res = buildAuthErrorResponse({ reason });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string; error_description: string };
      expect(body.error).toBe('invalid_token');
      expect(body.error_description.toLowerCase()).toContain('re-authorize');
      const wwwAuth = res.headers.get('WWW-Authenticate') ?? '';
      expect(wwwAuth).toContain('error="invalid_token"');
      // WWW-Authenticate quoted strings must not contain a raw double-quote
      const desc = /error_description="([^"]*)"/.exec(wwwAuth)?.[1] ?? '';
      expect(desc.length).toBeGreaterThan(0);
    });
  }
});
