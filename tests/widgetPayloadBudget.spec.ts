import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  SDK_PATH,
  budgetFor,
  checkWidgetPayloadBudgets,
  manifestWidgets,
  measureWidgetPayloads,
  readBudgets,
} from '../scripts/widget-payload-sizes';

/**
 * Per-widget payload budget: the bytes of each widget's MCP Apps resource
 * after the serving pipeline inlines its shared modules (what Claude, Cursor
 * and other MCP Apps hosts receive). Budgets: scripts/widget-payload-budgets.json.
 * See `pnpm widget:payload` for the full table.
 */
const measured = measureWidgetPayloads();
const widgetsDir = resolve(__dirname, '../public/widgets');

describe('widget payload budget', () => {
  it('every widget is within its inlined-size budget', () => {
    const errors = checkWidgetPayloadBudgets(measured, readBudgets());
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('flags a widget over budget, or without one, with a clear message', () => {
    const one = { bytes: 600_000, htmlBytes: 1, kitBytes: 0, sdkBytes: 0, inlined: ['shared/kit/ox-elements.js'] };
    const [over] = checkWidgetPayloadBudgets({ w: one }, { widgets: { w: 599_000 } });
    expect(over).toMatch(/^w: inlined MCP Apps payload is 600000 B .* over its 599000 B .* budget by 1000 B/);
    expect(over).toContain('scripts/widget-payload-budgets.json');
    const [missing] = checkWidgetPayloadBudgets({ w: one }, { widgets: {} });
    expect(missing).toBe(`w: no payload budget. It inlines to 600000 B (585.9 KB); add "w": ${budgetFor(600_000)} to scripts/widget-payload-budgets.json.`);
  });

  it('measures the served document: shared modules inlined, the SDK at most once', () => {
    for (const [name, p] of Object.entries(measured)) {
      expect(p.bytes, name).toBeGreaterThan(p.htmlBytes);
      expect(p.inlined.filter((x) => x === SDK_PATH).length, name).toBeLessThanOrEqual(1);
    }
    expect(measured['orgx-panel']!.inlined).toEqual(
      expect.arrayContaining(['shared/kit/ox-elements-core.js', 'shared/kit/ox-elements-footer.js', SDK_PATH]),
    );
  });
});

describe('design-kit bundles per widget', () => {
  // Run each widget's kit <script>s in order, as the inlined resource does, and
  // check every element it renders gets defined (build-widgets.mjs checks the
  // same statically).
  const widgets = Object.entries(manifestWidgets() as Record<string, { kitElements?: string[]; kitBundles?: string[] }>).filter(
    ([, w]) => w.kitElements?.length,
  );

  it.each(widgets)('%s defines every <ox-*> element it renders', (_name, w) => {
    const win = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }).window;
    for (const path of w.kitBundles!) win.eval(readFileSync(resolve(widgetsDir, path), 'utf8'));
    for (const el of w.kitElements!) expect(win.customElements.get(el), el).toBeTypeOf('function');
    expect((win as unknown as { OrgXElements: { avatarConfig: { baseUrl: string } } }).OrgXElements.avatarConfig.baseUrl).toMatch(/^https:/);
  });
});
