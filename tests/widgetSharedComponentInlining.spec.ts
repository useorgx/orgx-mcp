import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';
import {
  sanitizeMcpAppsHtml,
  MCP_APPS_SHARED_COMPONENT_PATHS,
  parseWidgetResourceUri,
} from '../src/widgetConfig';
import { WIDGET_RESOURCES } from '../src/toolDefinitions';

/**
 * Claude's MCP Apps widget sandbox treats served resource documents as
 * self-contained — external fetches of our own shared modules may not
 * resolve even when CSP `resourceDomains` allows the origin. The serving
 * pipeline therefore inlines `shared/components/*.{js,css}` referenced
 * by a widget before returning the resource.
 *
 * This spec locks the inlining contract: if a widget references any path
 * from MCP_APPS_SHARED_COMPONENT_PATHS, and the serving pipeline provides
 * the asset body, the rendered resource must contain the body inline.
 *
 * Pairs with tests/widgetPrimaryPalette.spec.ts (design-system parity) to
 * form the two-part widget contract: palette correctness + resource
 * self-containment.
 */

describe('MCP Apps shared-component inlining', () => {
  it('has at least one enforced shared component path', () => {
    expect(MCP_APPS_SHARED_COMPONENT_PATHS.length).toBeGreaterThan(0);
  });

  it('inlines a referenced shared component CSS as a <style> block', () => {
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="shared/components/domain-accent.css" />
    </head><body></body></html>`;
    const cssBody = '.agent-chip { color: red; }';
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/components/domain-accent.css': cssBody },
    });
    expect(sanitized).not.toMatch(/<link[^>]*domain-accent\.css/);
    expect(sanitized).toMatch(
      /<style data-inline-asset="shared\/components\/domain-accent\.css">/
    );
    expect(sanitized).toContain(cssBody);
  });

  it('inlines a referenced shared component JS as a <script> block', () => {
    const html = `<!DOCTYPE html><html><head>
      <script src="shared/components/liveness-indicator.js"></script>
    </head><body></body></html>`;
    const jsBody = 'window.OrgxLiveness = { attach() {} };';
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/components/liveness-indicator.js': jsBody },
    });
    expect(sanitized).not.toMatch(/<script[^>]*liveness-indicator\.js[^>]*><\/script>/);
    expect(sanitized).toMatch(
      /<script data-inline-asset="shared\/components\/liveness-indicator\.js">/
    );
    expect(sanitized).toContain(jsBody);
  });

  it('inlines the official MCP Apps SDK so the widget is self-contained', () => {
    const html = `<script src="shared/mcp-apps-sdk.umd.js"></script>`;
    const sdkBody = 'window.McpApps = { App: class App {} };';
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/mcp-apps-sdk.umd.js': sdkBody },
    });
    expect(sanitized).not.toMatch(
      /<script[^>]*\bsrc=["'][^"']*mcp-apps-sdk\.umd\.js/
    );
    expect(sanitized).toMatch(
      /<script data-inline-asset="shared\/mcp-apps-sdk\.umd\.js">/
    );
    expect(sanitized).toContain(sdkBody);
  });

  it('does not expand replacement tokens inside the real MCP Apps SDK bundle', () => {
    const html = `<html><head><script src="shared/mcp-apps-sdk.umd.js"></script></head><body><main>Widget content</main></body></html>`;
    const sdkBody = readFileSync(
      resolve(process.cwd(), 'public/widgets/shared/mcp-apps-sdk.umd.js'),
      'utf8'
    );
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/mcp-apps-sdk.umd.js': sdkBody },
    });
    const document = new JSDOM(sanitized).window.document;

    expect(sanitized).toContain(sdkBody);
    expect(
      sanitized.match(
        /<script\b[^>]*\bsrc=["'][^"']*mcp-apps-sdk\.umd\.js/g
      )
    ).toBeNull();
    expect(document.body.textContent).toBe('Widget content');
    expect(
      document.querySelectorAll(
        'script[data-inline-asset="shared/mcp-apps-sdk.umd.js"]'
      )
    ).toHaveLength(1);
  });

  it('keeps the SDK source inside script elements for every registered widget resource', () => {
    const sharedComponents = Object.fromEntries(
      MCP_APPS_SHARED_COMPONENT_PATHS.map((path) => [
        path,
        readFileSync(resolve(process.cwd(), 'public/widgets', path), 'utf8'),
      ])
    );
    const interactionKitCss = readFileSync(
      resolve(
        process.cwd(),
        'public/widgets/shared/interaction-kit.css'
      ),
      'utf8'
    );
    const interactionKitJs = readFileSync(
      resolve(process.cwd(), 'public/widgets/shared/interaction-kit.js'),
      'utf8'
    );

    for (const resource of WIDGET_RESOURCES) {
      const { widgetFile } = parseWidgetResourceUri(resource.uri);
      const html = readFileSync(
        resolve(process.cwd(), 'public/widgets', widgetFile),
        'utf8'
      );
      const sanitized = sanitizeMcpAppsHtml(html, {
        interactionKitCss,
        interactionKitJs,
        sharedComponents,
      });
      const dom = new JSDOM(sanitized);
      const { document, NodeFilter } = dom.window;
      const textWalker = document.createTreeWalker(
        document.documentElement,
        NodeFilter.SHOW_TEXT
      );
      const visibleText: string[] = [];
      while (textWalker.nextNode()) {
        const parent = textWalker.currentNode.parentElement;
        if (parent?.closest('script, style')) continue;
        visibleText.push(textWalker.currentNode.textContent || '');
      }

      expect(visibleText.join(' '), resource.name).not.toContain(
        'Cannot specify both `message` and `error` params'
      );
      expect(
        document.querySelectorAll(
          'script[data-inline-asset="shared/mcp-apps-sdk.umd.js"]'
        ),
        resource.name
      ).toHaveLength(1);
      expect(
        document.querySelectorAll(
          'script[data-inline-asset="shared/widget-runtime.js"]'
        ),
        resource.name
      ).toHaveLength(1);

      if (resource.name === 'morning-brief-widget') {
        expect(
          document.querySelectorAll(
            'script[data-inline-asset="shared/icons.js"]'
          )
        ).toHaveLength(1);
        expect(sanitized).not.toContain("from './shared/icons.js'");
        expect(sanitized).not.toContain("from './shared/utils.js'");
      }
    }
  });

  it('preserves replacement tokens in interaction-kit assets', () => {
    const html = `<link rel="stylesheet" href="shared/interaction-kit.css" />
      <script src="shared/interaction-kit.js"></script>`;
    const sanitized = sanitizeMcpAppsHtml(html, {
      interactionKitCss: '.token::after { content: "$&"; }',
      interactionKitJs: 'window.replacementToken = "$&";',
    });

    expect(sanitized).toContain('content: "$&"');
    expect(sanitized).toContain('window.replacementToken = "$&";');
    expect(sanitized).not.toContain('src="shared/interaction-kit.js"');
    expect(sanitized).not.toContain('href="shared/interaction-kit.css"');
  });

  it('keeps literal closing script tags inside an inlined asset body', () => {
    const html = `<script src="shared/icons.js"></script><script src="shared/interaction-kit.js"></script><main>Still visible</main>`;
    const sanitized = sanitizeMcpAppsHtml(html, {
      interactionKitJs: 'window.kitMarkup = "<main>kit</main>"; // </script>',
      sharedComponents: {
        'shared/icons.js':
          'window.exampleMarkup = "<script>example<\\/script>"; // </script>',
      },
    });
    const document = new JSDOM(sanitized).window.document;

    expect(
      document.querySelector('script[data-inline-asset="shared/icons.js"]')
        ?.textContent
    ).toContain('<\\/script>');
    expect(
      document.querySelector('script[data-inline-asset="interaction-kit.js"]')
        ?.textContent
    ).toContain('<\\/script>');
    expect(document.body.textContent).toBe('Still visible');
  });

  it('inlines the shared host runtime after the official SDK', () => {
    const html = `<script src="shared/mcp-apps-sdk.umd.js"></script>
      <script src="shared/widget-runtime.js"></script>`;
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: {
        'shared/mcp-apps-sdk.umd.js': 'window.McpApps = {};',
        'shared/widget-runtime.js': 'window.OrgXWidgetRuntime = {};',
      },
    });
    expect(sanitized).not.toMatch(/<script[^>]*\bsrc=["'][^"']*widget-runtime\.js/);
    expect(sanitized).toMatch(
      /<script data-inline-asset="shared\/widget-runtime\.js">/
    );
    expect(sanitized.indexOf('window.McpApps')).toBeLessThan(
      sanitized.indexOf('window.OrgXWidgetRuntime')
    );
  });

  it('survives versioned query strings on the reference', () => {
    const html = `<link rel="stylesheet" href="shared/components/domain-accent.css?v=abc123" />`;
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/components/domain-accent.css': '.x{}' },
    });
    expect(sanitized).not.toMatch(/<link/);
    expect(sanitized).toMatch(/data-inline-asset="shared\/components\/domain-accent\.css"/);
  });

  it('leaves other external references alone', () => {
    const html = `<link rel="stylesheet" href="shared/tokens.css" />
      <script src="shared/components/domain-accent.js"></script>`;
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/components/domain-accent.js': 'var x=1;' },
    });
    // tokens.css was not in the sharedComponents map — stays external
    expect(sanitized).toContain('shared/tokens.css');
    // domain-accent.js was inlined
    expect(sanitized).toMatch(/data-inline-asset="shared\/components\/domain-accent\.js"/);
  });

  it('skips inlining when body is null', () => {
    const html = `<script src="shared/components/liveness-indicator.js"></script>`;
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/components/liveness-indicator.js': null },
    });
    // The original tag must survive so the browser can still fetch it — the
    // inlining is best-effort, not destructive.
    expect(sanitized).toContain('liveness-indicator.js');
  });
});
