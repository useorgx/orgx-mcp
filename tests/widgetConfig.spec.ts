import { describe, expect, it } from 'vitest';

import {
  buildMcpAppsMeta,
  rewriteWidgetHtmlAssetUrls,
  sanitizeMcpAppsHtml,
} from '../src/widgetConfig';

describe('widgetConfig', () => {
  it('rewrites relative and root-relative asset URLs without relying on a base tag', () => {
    const html = `<!doctype html>
<html>
  <head>
    <base href="https://mcp.useorgx.com/widgets/" />
    <link rel="stylesheet" href="shared/interaction-kit.css" />
    <script src="shared/interaction-kit.js"></script>
    <link rel="preload" as="image" href="/orgx-logo.png" />
  </head>
  <body>
    <img src="/orgx-logo.png" srcset="shared/foo.png 1x, /bar.png 2x" />
    <a href="#section">Anchor</a>
    <script src="https://assets.example.com/widget.js"></script>
  </body>
</html>`;

    const rewritten = rewriteWidgetHtmlAssetUrls(
      html,
      'https://mcp.useorgx.com/widgets/'
    );

    expect(rewritten).not.toContain('<base ');
    expect(rewritten).toContain(
      'href="https://mcp.useorgx.com/widgets/shared/interaction-kit.css"'
    );
    expect(rewritten).toContain(
      'src="https://mcp.useorgx.com/widgets/shared/interaction-kit.js"'
    );
    expect(rewritten).toContain(
      'href="https://mcp.useorgx.com/orgx-logo.png"'
    );
    expect(rewritten).toContain(
      'src="https://mcp.useorgx.com/orgx-logo.png"'
    );
    expect(rewritten).toContain(
      'srcset="https://mcp.useorgx.com/widgets/shared/foo.png 1x, https://mcp.useorgx.com/bar.png 2x"'
    );
    expect(rewritten).toContain('href="#section"');
    expect(rewritten).toContain('src="https://assets.example.com/widget.js"');
  });

  it('includes baseUriDomains for MCP Apps sandbox compatibility', () => {
    const meta = buildMcpAppsMeta({
      MCP_SERVER_URL: 'https://mcp.useorgx.com',
      ORGX_WEB_URL: 'https://www.useorgx.com',
    });

    expect(meta.ui.csp.resourceDomains).toContain('https://mcp.useorgx.com');
    expect(meta.ui.csp.baseUriDomains).toContain('https://mcp.useorgx.com');
    expect(meta.ui.csp.baseUriDomains).toContain('https://www.useorgx.com');
  });

  it('sanitizes MCP Apps HTML by removing icon links and inlining shared assets', () => {
    const html = `<!doctype html>
<html>
  <head>
    <link rel="icon" href="data:image/svg+xml,%3Csvg%3E" />
    <link rel="stylesheet" href="https://mcp.useorgx.com/widgets/shared/interaction-kit.css" />
    <script src="https://mcp.useorgx.com/widgets/shared/interaction-kit.js"></script>
  </head>
  <body>
    <div>Widget</div>
  </body>
</html>`;

    const sanitized = sanitizeMcpAppsHtml(html, {
      interactionKitCss: '.ox-test { color: red; }',
      interactionKitJs: 'window.__oxTest = true;',
    });

    expect(sanitized).not.toContain('rel="icon"');
    expect(sanitized).toContain('data-inline-asset="interaction-kit.css"');
    expect(sanitized).toContain('.ox-test { color: red; }');
    expect(sanitized).toContain('data-inline-asset="interaction-kit.js"');
    expect(sanitized).toContain('window.__oxTest = true;');
    expect(sanitized).not.toContain(
      'href="https://mcp.useorgx.com/widgets/shared/interaction-kit.css"'
    );
    expect(sanitized).not.toContain(
      'src="https://mcp.useorgx.com/widgets/shared/interaction-kit.js"'
    );
  });
});
