import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const consentHtml = readFileSync(
  resolve(root, 'public/consent.html'),
  'utf8'
);
const staticHeaders = readFileSync(resolve(root, 'public/_headers'), 'utf8');

describe('consent page security policy', () => {
  it('delivers framing and form restrictions as response headers', () => {
    expect(staticHeaders).toContain('/consent.html');
    expect(staticHeaders).toContain("frame-ancestors 'none'");
    expect(staticHeaders).toContain(
      "form-action 'self' https://mcp.useorgx.com"
    );
    expect(staticHeaders).toContain('X-Frame-Options: DENY');
  });

  it('prevents Cloudflare analytics injection on the OAuth surface', () => {
    expect(staticHeaders).toContain('Cache-Control: no-store, no-transform');
    expect(staticHeaders).not.toContain('static.cloudflareinsights.com');
    expect(staticHeaders).not.toContain('cloudflareinsights.com');
  });

  it('does not attempt to deliver CSP through unsupported meta directives', () => {
    expect(consentHtml).not.toContain('http-equiv="Content-Security-Policy"');
  });

  it('posts only to the same-origin consent callback', () => {
    expect(consentHtml).toContain(
      '<form id="consent-form" method="post" action="/oauth/consent-callback"'
    );
  });
});
