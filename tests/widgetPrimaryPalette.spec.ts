import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Widget primary-color parity test.
 *
 * Every widget declares its own `--ox-primary-rgb` in a `:root { ... }` block
 * inside `<style>`. This file asserts that each widget's declaration matches
 * the canonical per-widget primary defined by the OrgX design system.
 *
 * When a new widget is added, add its expected primary to CANONICAL_PRIMARIES.
 * If a widget intentionally inherits the default (teal), set the value to
 * 'canonical-teal'.
 *
 * Design-system source:
 *   skills/orgx-design references the per-widget primary map in the main
 *   skill file (Per-Widget Primary Color table).
 */

const WIDGETS_DIR = join(__dirname, '..', 'public', 'widgets');

// RGB triplet form — whitespace-insensitive comparison.
const CANONICAL_PRIMARIES: Record<string, string> = {
  // Command mode — execution palette.
  'agent-status': '191,255,0',
  'agent-status-stream': '191,255,0',

  // State mode — health palette (canonical teal).
  'initiative-pulse': '0,201,167',
  'initiative-pulse-stream': '0,201,167',

  // Creation mode — iris.
  'scaffolded-initiative': '99,102,241',
  'scaffold-streaming': '99,102,241',
  'task-spawned': '99,102,241',

  // Escalation / attention mode — amber.
  decisions: '251,191,36',

  // Readout mode — canonical teal.
  'morning-brief': '0,201,167',
  'search-results': '0,201,167',

  // Gallery — neutral slate.
  index: '17,24,39',
};

function normalizeRgb(raw: string): string {
  return raw.replace(/\s+/g, '');
}

function extractPrimaryRgb(html: string): string | null {
  // Match the FIRST `--ox-primary-rgb: <r>, <g>, <b>;` declaration inside
  // <style>. The first declaration is the canonical base palette; any
  // later ones are media-query / data-theme overrides and are allowed to
  // differ (e.g. light-theme slate vs dark-theme slate on the gallery).
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  if (styleBlocks.length === 0) return null;

  const combined = styleBlocks.join('\n');
  const match = combined.match(/--ox-primary-rgb\s*:\s*([0-9,\s]+)\s*;/);
  return match ? normalizeRgb(match[1]) : null;
}

describe('widget primary palette parity', () => {
  const widgetFiles = readdirSync(WIDGETS_DIR).filter((f) => f.endsWith('.html'));

  it('covers every shipped widget HTML in the canonical map', () => {
    const covered = new Set(Object.keys(CANONICAL_PRIMARIES));
    const missing = widgetFiles
      .map((f) => f.replace(/\.html$/, ''))
      .filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });

  for (const file of widgetFiles) {
    const widgetName = file.replace(/\.html$/, '');
    const expected = CANONICAL_PRIMARIES[widgetName];
    if (expected === undefined) continue;

    it(`${widgetName} declares --ox-primary-rgb: ${expected}`, () => {
      const html = readFileSync(join(WIDGETS_DIR, file), 'utf8');
      const actual = extractPrimaryRgb(html);
      expect(actual, `${file} must declare --ox-primary-rgb in a :root block`).not.toBeNull();
      expect(actual).toBe(expected);
    });
  }
});
