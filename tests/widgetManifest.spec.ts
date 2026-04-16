import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_APPS_SHARED_COMPONENT_PATHS } from '../src/widgetConfig';

/**
 * Widget manifest consistency test (Stage A of the widget build pipeline).
 *
 * The manifest at public/widgets/_manifest.json is the single source of
 * truth for:
 *   - which widgets ship
 *   - what primary color each one uses
 *   - which shared modules each widget imports
 *
 * This test enforces three invariants:
 *   1. Manifest exists (build has run). `pretest` hook runs `widget:build`.
 *   2. Every `MCP_APPS_SHARED_COMPONENT_PATHS` entry is reachable from at
 *      least one widget — otherwise it's dead inlining logic in the server.
 *   3. Every widget's `sharedRefs` is a subset of the manifest allowlist.
 *
 * If the build script (scripts/build-widgets.mjs) itself fails, the
 * pretest hook fails first — this test never runs on broken input.
 */

type WidgetManifest = {
  version: number;
  generatedAt: string;
  allowlist: string[];
  canonicalPrimaries: Record<string, string>;
  widgets: Record<string, {
    file: string;
    bytes: number;
    hash: string;
    primaryRgb: string | null;
    sharedRefs: string[];
    demoOnly: boolean;
  }>;
};

const MANIFEST_PATH = join(__dirname, '..', 'public', 'widgets', '_manifest.json');

function loadManifest(): WidgetManifest {
  expect(existsSync(MANIFEST_PATH), `manifest missing — run "pnpm widget:build"`).toBe(true);
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as WidgetManifest;
}

describe('widget manifest (Stage A)', () => {
  it('exists and parses', () => {
    const m = loadManifest();
    expect(m.version).toBe(1);
    expect(Object.keys(m.widgets).length).toBeGreaterThan(0);
  });

  it('every MCP_APPS_SHARED_COMPONENT_PATHS entry is referenced by at least one widget', () => {
    const m = loadManifest();
    const referenced = new Set<string>();
    for (const w of Object.values(m.widgets)) {
      for (const ref of w.sharedRefs) referenced.add(ref);
    }

    const unreachable = MCP_APPS_SHARED_COMPONENT_PATHS.filter(
      (path) => !referenced.has(path)
    );
    expect(
      unreachable,
      `shared modules in MCP_APPS_SHARED_COMPONENT_PATHS not used by any widget`
    ).toEqual([]);
  });

  it('every widget shared ref is on the manifest allowlist', () => {
    const m = loadManifest();
    const allowlist = new Set(m.allowlist);
    const violations: Array<{ widget: string; ref: string }> = [];
    for (const [name, w] of Object.entries(m.widgets)) {
      for (const ref of w.sharedRefs) {
        if (!allowlist.has(ref)) violations.push({ widget: name, ref });
      }
    }
    expect(violations).toEqual([]);
  });

  it('no widget name ends in -stream (forks are disallowed)', () => {
    const m = loadManifest();
    const forks = Object.keys(m.widgets).filter((name) => name.endsWith('-stream'));
    expect(
      forks,
      `found disallowed -stream forks — collapse into main widget with ?live=true`
    ).toEqual([]);
  });

  it('no widget has drifted palette (manifest mirrors canonicalPrimaries)', () => {
    const m = loadManifest();
    const drift: Array<{ widget: string; actual: string | null; expected: string }> = [];
    for (const [name, expected] of Object.entries(m.canonicalPrimaries)) {
      const actual = m.widgets[name]?.primaryRgb ?? null;
      if (actual !== expected) drift.push({ widget: name, actual, expected });
    }
    expect(drift).toEqual([]);
  });
});
