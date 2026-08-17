import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('public/consent.html'), 'utf8');
const staticHeaders = readFileSync(resolve('public/_headers'), 'utf8');

describe('OAuth consent page contract', () => {
  it('uses a two-stage configure and review flow with one final authorization', () => {
    expect(html).toContain('id="configure-stage"');
    expect(html).toContain('id="review-stage"');
    expect(html).toContain('Review access');
    expect(html).toContain('Review and connect');
    expect(html).toContain('id="authorize-button"');
    expect(html).toContain('Accessible workspaces');
  });

  it('submits approve and deny to the server instead of constructing client redirects', () => {
    expect(html).toContain(
      '<form id="consent-form" method="post" action="/oauth/consent-callback"'
    );
    expect(html).toContain("submitConsent('approve')");
    expect(html).toContain("submitConsent('deny')");
    expect(html).not.toContain("params.get('redirect_uri')");
    expect(html).not.toContain("params.get('oauth_state')");
  });

  it('loads resource/action copy from the canonical server policy', () => {
    expect(html).toContain('payload.authorization_policy');
    expect(html).toContain('policy.resources.map');
    expect(html).not.toContain("scope: 'memory:write'");
    expect(html).toContain('id="offline-toggle" type="checkbox" />');
    expect(html).not.toContain('id="offline-toggle" type="checkbox" checked');
  });

  it('has no third-party runtime assets and suppresses referrers', () => {
    expect(html).toContain('<meta name="referrer" content="no-referrer"');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('cdn.tailwindcss.com');
    expect(html).not.toContain('cdn.simpleicons.org');
    expect(staticHeaders).toContain("connect-src 'self'");
    expect(staticHeaders).toContain("form-action 'self'");
  });

  it('uses the canonical OrgX mark and a self-hosted client icon registry', () => {
    expect(html.match(/src="\/orgx-logo\.png"/g)).toHaveLength(2);
    expect(html).not.toContain('<div class="orgx-icon">OX</div>');
    expect(html).not.toContain('id="client-initial"');
    expect(html).toContain('id="client-icon"');
    expect(html).toContain('CLIENT_ICON_PATHS');
    for (const kind of [
      'chatgpt',
      'codex',
      'claude',
      'cursor',
      'vscode',
      'github_copilot',
      'windsurf',
      'zed',
      'cline',
      'roo_code',
      'continue',
      'raycast',
      'gemini',
      'goose',
      'openclaw',
      'opencode',
      'local',
      'unverified',
    ]) {
      expect(html).toContain(`kind === '${kind}'`);
    }
  });

  it('makes client identity provenance visible instead of treating a logo as verification', () => {
    expect(html).toContain('state.client.identity_trust');
    expect(html).toContain('Verified return domain');
    expect(html).toContain('Name supplied by this OAuth client');
    expect(html).toContain('Returns to an application on this device');
    expect(html).toContain('Unverified client');
  });

  it('uses a semantic OrgX execution field rather than a decorative image dependency', () => {
    expect(html).toContain('class="orgx-field"');
    expect(html).toContain('>INTENT<');
    expect(html).toContain('>WORK<');
    expect(html).toContain('>DECISION<');
    expect(html).toContain('>PROOF<');
    expect(html).toContain('.field-path.signal');
  });

  it('keeps responsive actions touch-sized and honors reduced motion', () => {
    expect(html).toContain('min-height: 46px');
    expect(html).toContain('@media (max-width: 520px)');
    expect(html).toContain('#review-button { grid-column: 1 / -1; }');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
