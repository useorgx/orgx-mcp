import { describe, it, expect } from 'vitest';
import {
  sanitizeMcpAppsHtml,
  MCP_APPS_SHARED_COMPONENT_PATHS,
} from '../src/widgetConfig';

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

  it('inlines the final widget quality layer for Claude sandbox parity', () => {
    const html = `<link rel="stylesheet" href="shared/widget-quality.css?v=build123" />`;
    const cssBody = ':root { --ox-quality-target: 44px; }';
    const sanitized = sanitizeMcpAppsHtml(html, {
      sharedComponents: { 'shared/widget-quality.css': cssBody },
    });
    expect(sanitized).not.toMatch(/<link/);
    expect(sanitized).toMatch(
      /data-inline-asset="shared\/widget-quality\.css"/
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
