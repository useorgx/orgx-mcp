import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('landing page Meta pixel instrumentation', () => {
  const publicIndex = readFileSync(
    resolve(process.cwd(), 'public/index.html'),
    'utf8'
  );

  it('boots the OrgX MCP Meta pixel with the live pixel id', () => {
    expect(publicIndex).toContain(
      'https://connect.facebook.net/en_US/fbevents.js'
    );
    expect(publicIndex).toContain("window.ORGX_META_PIXEL_ID = '3332337890259808'");
    expect(publicIndex).toContain("fbq('init', window.ORGX_META_PIXEL_ID)");
    expect(publicIndex).toContain("fbq('track', 'PageView')");
    expect(publicIndex).toContain(
      'https://www.facebook.com/tr?id=3332337890259808&ev=PageView&noscript=1'
    );
  });

  it('tracks the core orgx mcp landing page interactions', () => {
    expect(publicIndex).toContain('id="hero-connect-client-cta"');
    expect(publicIndex).toContain('id="hero-see-tools-cta"');
    expect(publicIndex).toContain('function trackMetaStandard');
    expect(publicIndex).toContain('function trackMetaCustom');
    expect(publicIndex).toContain('function bindLandingPageTracking()');
    expect(publicIndex).toContain('function switchTab(tab, options = {})');
    expect(publicIndex).toContain("trackMetaCustom('OrgXMcpIntegrationTabViewed'");
    expect(publicIndex).toContain("trackMetaCustom('OrgXMcpConfigCopied'");
    expect(publicIndex).toContain("trackMetaCustom('OrgXMcpHeroConnectClicked'");
    expect(publicIndex).toContain("trackMetaCustom('OrgXMcpToolsViewed'");
    expect(publicIndex).toContain("trackMetaStandard('Lead'");
    expect(publicIndex).toContain("trackMetaStandard('ViewContent'");
  });
});
