import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WIDGET_THEME_CSS } from '../src/generated/widgetThemeCss';
import { buildLiveFeedWidget } from '../src/liveFeedWidget';

/**
 * The server-generated widgets ship as self-contained HTML content blocks, so
 * they cannot link shared/widget-theme.css the way the static widgets do. Each
 * therefore carried a hand-written copy of the --ox-* tokens, and they drifted:
 * the live feed widget had --ox-border at rgba(0,0,0,.08) against the canonical
 * rgba(15,23,42,.1). The CSS is now generated into the bundle from the one
 * source file; these tests keep the two from separating again.
 */

const ROOT = join(__dirname, '..');
const SOURCE = join(ROOT, 'public', 'widgets', 'shared', 'widget-theme.css');

describe('generated widget theme', () => {
  it('is in sync with the stylesheet it is generated from', () => {
    // Regenerating must be a no-op; if it is not, someone edited the generated
    // file or changed the source without rebuilding.
    const before = readFileSync(join(ROOT, 'src', 'generated', 'widgetThemeCss.ts'), 'utf8');
    execFileSync('node', ['scripts/generate-widget-theme.mjs'], { cwd: ROOT });
    const after = readFileSync(join(ROOT, 'src', 'generated', 'widgetThemeCss.ts'), 'utf8');
    expect(after).toBe(before);
  });

  it('carries every token the source declares', () => {
    const source = readFileSync(SOURCE, 'utf8');
    const declared = new Set(source.match(/--ox-[a-z0-9-]+/g) ?? []);
    expect(declared.size).toBeGreaterThan(20);
    for (const token of declared) {
      expect(WIDGET_THEME_CSS, `${token} missing from generated theme`).toContain(token);
    }
  });

  it('keeps the light, dark and accent selectors intact through minification', () => {
    expect(WIDGET_THEME_CSS).toContain(':root[data-theme="light"]');
    expect(WIDGET_THEME_CSS).toContain('prefers-color-scheme:dark');
    expect(WIDGET_THEME_CSS).toContain(':root[data-theme="dark"]');
    expect(WIDGET_THEME_CSS).toContain('[data-accent="teal"]');
  });

  it('is smaller than the source but not suspiciously so', () => {
    const source = readFileSync(SOURCE, 'utf8');
    expect(WIDGET_THEME_CSS.length).toBeLessThan(source.length);
    expect(WIDGET_THEME_CSS.length).toBeGreaterThan(source.length * 0.5);
  });
});

describe('live feed widget uses the canonical theme', () => {
  const html = buildLiveFeedWidget({
    feedType: 'agent-status',
    feedId: 'init-1',
    streamBaseUrl: 'https://mcp.useorgx.com',
    streamToken: 'tok',
  });

  it('embeds the generated theme rather than its own token block', () => {
    expect(html).toContain('--ox-border');
    // The value the fork had drifted to must be gone.
    expect(html).not.toContain('--ox-border:rgba(0,0,0,.08)');
    expect(html).not.toContain('--ox-border:rgba(0, 0, 0, .08)');
  });

  it('agrees with the static widgets on the canonical border token', () => {
    const source = readFileSync(SOURCE, 'utf8');
    const canonical = source.match(/--ox-border:\s*([^;]+);/)?.[1]?.trim();
    expect(canonical).toBeTruthy();
    // Minification drops the spaces inside rgba(), so compare on value not form.
    const collapse = (value: string) => value.replace(/\s+/g, '');
    expect(collapse(html)).toContain(`--ox-border:${collapse(canonical!)}`);
  });

  it('still declares the domain and status colors the theme does not own', () => {
    for (const token of ['--d-engineering', '--s-running', '--s-blocked', '--ox-mono']) {
      expect(html).toContain(token);
    }
  });

  it('declares each theme block exactly once', () => {
    // A second copy would mean the fork came back alongside the generated one.
    expect(html.split(':root[data-theme="light"]').length - 1).toBe(1);
  });
});
