import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Security headers for directly-served widget assets.
 *
 * Production was serving every widget HTML document with no CSP, no nosniff,
 * no HSTS and no referrer policy — confirmed against mcp.useorgx.com. These are
 * inline-script documents that run inside someone else's client, so shipping
 * them bare is worth a rule even though the MCP delivery path inlines them and
 * lets the host apply its own sandbox CSP.
 */

const HEADERS_FILE = readFileSync(join(__dirname, '..', 'public', '_headers'), 'utf8');

/** Parse `_headers` into rule → header map. */
function parseRules(): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of HEADERS_FILE.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!raw.startsWith(' ') && !raw.startsWith('\t')) {
      current = new Map();
      rules.set(raw.trim(), current);
      continue;
    }
    const index = raw.indexOf(':');
    if (index === -1 || !current) continue;
    current.set(raw.slice(0, index).trim(), raw.slice(index + 1).trim());
  }
  return rules;
}

describe('widget asset headers', () => {
  const rules = parseRules();
  const widget = rules.get('/widgets/*');

  it('has a rule covering every widget document', () => {
    expect(widget, '/widgets/* rule missing from public/_headers').toBeDefined();
  });

  it('sets the headers production was missing entirely', () => {
    expect(widget!.get('Content-Security-Policy')).toBeTruthy();
    expect(widget!.get('X-Content-Type-Options')).toBe('nosniff');
    expect(widget!.get('Strict-Transport-Security')).toContain('max-age=');
    expect(widget!.get('Referrer-Policy')).toBeTruthy();
  });

  it('allows the inline scripts and styles a widget is built from', () => {
    // Widgets are single self-contained documents by design; a policy that
    // forbade inline would break every one of them.
    const csp = widget!.get('Content-Security-Policy')!;
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('allows the same-origin connection the live feed needs', () => {
    expect(widget!.get('Content-Security-Policy')).toContain("connect-src 'self'");
  });

  it('does not forbid framing, because being framed is the point', () => {
    // The consent page denies framing outright; copying that here would break
    // every host that embeds a widget.
    expect(widget!.get('X-Frame-Options')).toBeUndefined();
    expect(widget!.get('Content-Security-Policy')).not.toContain('frame-ancestors');
  });

  it('still denies framing on the consent page', () => {
    const consent = rules.get('/consent.html');
    expect(consent?.get('X-Frame-Options')).toBe('DENY');
    expect(consent?.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('blocks form submission and plugins from a widget', () => {
    const csp = widget!.get('Content-Security-Policy')!;
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});
