import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// An offline synthetic host. Displayed actions are never dispatched.
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/panel-visual.json'), 'utf8'));
const out = resolve(process.env.ORGX_PANEL_AUDIT_DIR || 'artifacts/qa/panel-visual-layout');
const source = resolve(process.env.ORGX_PANEL_AUDIT_HTML || 'public/widgets/orgx-panel.html');
const label = process.env.ORGX_PANEL_AUDIT_LABEL || 'after';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const cases = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 768, 375]) {
    const page = await browser.newPage({ viewport: { width, height: width === 375 ? 812 : 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(({ snapshot, theme }) => {
      window.__calls = [];
      window.openai = {
        theme, toolOutput: snapshot, setWidgetHeight() {},
        toolResponseMetadata: { 'orgx/widgetApproval': { approval_tokens: Object.fromEntries(snapshot.queue.map(item => [item.id, 'synthetic-token'])) } },
        async callTool(name) { window.__calls.push(name); throw new Error('Visual audit cannot dispatch actions'); },
      };
    }, { snapshot: fixture.snapshot, theme });
    await page.goto(pathToFileURL(source).href);
    await page.locator('#pk-q').waitFor();
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      panelWidth: document.querySelector('.panel').getBoundingClientRect().width,
      animationCount: document.getAnimations().filter(animation => animation.playState === 'running').length,
      calls: window.__calls,
    }));
    assert.equal(metrics.overflow, false);
    assert.equal(metrics.animationCount, 0);
    assert.deepEqual(metrics.calls, []);
    assert.deepEqual(errors, []);
    if (label === 'after') {
      assert.ok(metrics.panelWidth <= 760);
      assert.equal(await page.locator('.client-origin').innerText(), 'Claude Code');
      assert.equal(await page.locator('.client-origin svg').count(), 1);
      assert.equal(await page.locator('.row-meta svg').count(), 2);
      assert.equal(await page.locator('.client-origin svg:not([aria-hidden="true"]), .row-meta svg:not([aria-hidden="true"])').count(), 0);
      const header = page.locator('.top');
      const refresh = header.getByRole('button', { name: 'Refresh', exact: true });
      await page.keyboard.press('Tab');
      assert.equal(await refresh.evaluate(el => el === document.activeElement), true);
      assert.ok((await refresh.boundingBox()).height >= 44);
      if (width === 375) {
        const refreshBox = await refresh.boundingBox();
        const identityBox = await header.locator('.top-id').boundingBox();
        assert.ok(refreshBox.y < identityBox.y + identityBox.height, 'Refresh shares the workspace row');
      }
      await refresh.evaluate(el => el.blur());
    }
    await page.screenshot({ path: join(out, `${label}-${theme}-${width}.png`), fullPage: true });
    cases.push({ theme, width, ...metrics, errors });
    if (label === 'after' && width === 375) {
      // Old records and unknown client identifiers keep an honest text fallback.
      for (const [client, expected] of [[null, 'Client not reported'], ['<img onerror=alert(1)>', 'Other client']]) {
        await page.evaluate(client => {
          const snapshot = structuredClone(window.openai.toolOutput);
          snapshot.focus.source_client = client;
          snapshot.updated_at = new Date(Date.now() + 10000).toISOString();
          window.openai.toolOutput = snapshot;
          window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: snapshot } } }));
        }, client);
        await page.locator('.client-origin').filter({ hasText: expected }).waitFor();
        assert.equal(await page.locator('.client-origin svg').count(), 0);
        assert.equal(await page.locator('.client-origin img').count(), 0);
      }
    }
    await page.close();
  }
  writeFileSync(join(out, `${label}-diagnostics.json`), JSON.stringify(cases, null, 2));
  console.log(JSON.stringify({ label, cases: cases.length, diagnostics: cases }, null, 2));
} finally { await browser.close(); }
