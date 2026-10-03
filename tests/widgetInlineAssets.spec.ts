// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { INTERACTION_KIT_PATHS, minifyInlineAsset } from '../scripts/lib/inlineAssets.mjs';
import { MCP_APPS_SHARED_COMPONENT_PATHS, mcpAppsInlineAssetPath } from '../src/widgetConfig';

/**
 * The worker inlines public/widgets/inline/<path>, the minified copy
 * `pnpm widget:build` writes of each shared file (scripts/lib/inlineAssets.mjs).
 * The copies must be current, deterministic, never larger than the source, and
 * behave like the source (same globals).
 */
const WIDGETS = resolve(__dirname, '..', 'public', 'widgets');
const PATHS = [...MCP_APPS_SHARED_COMPONENT_PATHS, ...INTERACTION_KIT_PATHS];
const read = (path: string) => readFileSync(resolve(WIDGETS, path), 'utf8');

describe('minified inline assets', () => {
  it.each(PATHS)('%s has a current minified copy (run pnpm widget:build if this fails)', (path) => {
    const inline = mcpAppsInlineAssetPath(path);
    expect(existsSync(resolve(WIDGETS, inline)), inline).toBe(true);
    const source = read(path);
    const expected = minifyInlineAsset(path, source);
    expect(read(inline)).toBe(expected);
    expect(minifyInlineAsset(path, source)).toBe(expected);
    expect(Buffer.byteLength(expected)).toBeLessThanOrEqual(Buffer.byteLength(source));
  });

  it('strips comments from the readable sources', () => {
    const runtime = read(mcpAppsInlineAssetPath('shared/widget-runtime.js'));
    expect(runtime).not.toContain('One link builder for every OrgX URL');
    expect(read(mcpAppsInlineAssetPath('shared/widget-theme.css'))).not.toMatch(/\/\*/);
  });

  it('defines the same globals as the sources', () => {
    const globalsAfter = (files: string[]) => {
      const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://widget.test/widgets/x.html' });
      const before = new Set(Object.keys(dom.window));
      for (const file of files) dom.window.eval(read(file));
      return Object.keys(dom.window).filter((k) => !before.has(k)).sort();
    };
    const files = ['shared/agent-identity.js', 'shared/widget-runtime.js', 'shared/orgx-icons.js', 'shared/widget-state.js', 'shared/live-machine.js', 'shared/live-store.js', 'shared/live-panel.js'];
    const fromSource = globalsAfter(files);
    expect(fromSource).toEqual(expect.arrayContaining(['OrgXAgentIdentity', 'OrgXWidgetRuntime', 'OrgXTime', 'OrgXLinks', 'OrgXIcons']));
    expect(globalsAfter(files.map(mcpAppsInlineAssetPath))).toEqual(fromSource);
  });

  it('keeps the minified runtime working', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://widget.test/widgets/x.html' });
    dom.window.eval(read(mcpAppsInlineAssetPath('shared/widget-runtime.js')));
    const w = dom.window as unknown as { OrgXLinks: { decision(id: string): string }; OrgXTime: { relative(v: number, o: { now: number }): string } };
    expect(w.OrgXLinks.decision('d1')).toBe('https://useorgx.com/decisions/d1');
    const now = Date.UTC(2026, 9, 2, 17, 5);
    expect(w.OrgXTime.relative(now - 120_000, { now })).toBe('2m ago');
  });
});
