import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the "button clicks silently do nothing" class of bug.
 *
 * In PR #132 the scaffolded-initiative widget wired click handlers that
 * called `openWidgetLink(url, event)` guarded by `typeof openWidgetLink ===
 * 'function'`. The function itself was never defined in the widget's inline
 * script, so the guard always fell through to `window.open()` — which the
 * Claude.ai iframe sandbox blocks. Every click produced no visible effect.
 *
 * To prevent this recurring: every widget that CALLS `openWidgetLink` must
 * load the shared OrgX host runtime, define the helper, or import it.
 * This test walks every widget and enforces the invariant.
 */

const WIDGETS_DIR = join(__dirname, '..', 'public', 'widgets');

function listWidgetHtmlFiles(): string[] {
  return readdirSync(WIDGETS_DIR)
    .filter((name) => name.endsWith('.html'))
    .map((name) => join(WIDGETS_DIR, name));
}

function widgetProvidesOpenLinkHelper(html: string): boolean {
  if (/shared\/widget-runtime\.js/.test(html)) return true;
  // Inline definition — either `function openWidgetLink(...)` or `var/let/const openWidgetLink = function`
  if (/function\s+openWidgetLink\s*\(/.test(html)) return true;
  if (/(?:var|let|const)\s+openWidgetLink\s*=\s*function/.test(html)) return true;
  // Imported from the shared utility module
  if (/import[^;]*\bopenWidgetLink\b[^;]*from\s+['"][^'"]*shared\/utils(?:\.js)?['"]/.test(html))
    return true;
  // Legacy helper name used by scaffold-streaming.html (posts ui/open-link
  // directly via a delegated click listener)
  if (/function\s+openExtLink\s*\(/.test(html)) return true;
  return false;
}

describe('widget openWidgetLink invariant', () => {
  it('every widget that calls openWidgetLink also defines or imports it', () => {
    const offenders: string[] = [];

    for (const filePath of listWidgetHtmlFiles()) {
      const html = readFileSync(filePath, 'utf8');
      const callsIt = /\bopenWidgetLink\s*\(/.test(html);
      if (!callsIt) continue;
      if (!widgetProvidesOpenLinkHelper(html)) {
        offenders.push(filePath.replace(WIDGETS_DIR + '/', ''));
      }
    }

    expect(
      offenders,
      `Widgets call openWidgetLink but do not define or import it. ` +
        `Fix: load shared/widget-runtime.js, define a helper, ` +
        `or import it from shared/utils.js. Offenders:\n` +
        offenders.map((name) => `  - ${name}`).join('\n')
    ).toEqual([]);
  });
});
