import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Delayed, offline synthetic reads. No real tool calls, mutations or model inference.
const fixture = JSON.parse(readFileSync('tests/fixtures/panel-experience.json', 'utf8'));
const source = resolve(process.env.ORGX_READ_AUDIT_HTML || 'public/widgets/orgx-panel.html');
const label = process.env.ORGX_READ_AUDIT_LABEL || 'after';
const out = resolve('artifacts/qa/panel-read');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const metrics = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [800, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(/^https?:/, (route) => route.abort());
    await page.addInitScript(({ fixture, theme }) => {
      window.__reads = []; window.__calls = []; window.__feedbackMs = null; window.__started = null;
      window.openai = {
        theme, toolOutput: fixture.snapshot,
        toolResponseMetadata: { 'orgx/widgetApproval': { approval_tokens: Object.fromEntries(fixture.snapshot.queue.map((item) => [item.id, 'synthetic-token'])) } },
        setWidgetHeight() {},
        callTool(name, args) {
          window.__calls.push({ name, args });
          return new Promise((resolve, reject) => window.__reads.push({ resolve, reject, args }));
        },
      };
      addEventListener('click', (event) => {
        if (event.target.closest?.('.row-main') && window.__started === null) window.__started = performance.now();
      }, true);
      new MutationObserver(() => {
        if (window.__feedbackMs === null && window.__started !== null && document.querySelector('[data-read="loading"]')) {
          window.__feedbackMs = performance.now() - window.__started;
        }
      }).observe(document, { subtree: true, childList: true });
      window.__finish = (index) => {
        const read = window.__reads[index];
        const id = read.args.focus.id;
        const item = fixture.snapshot.queue.find((item) => item.id === id);
        const snapshot = { ...fixture.snapshot, generated_at: new Date(Date.parse(fixture.snapshot.generated_at) + (index + 1) * 1000).toISOString(),
          focus: { ...fixture.snapshot.focus, id, question: item.title }, selection: { status: 'selected', requested_id: id } };
        read.resolve({ structuredContent: snapshot, _meta: { 'orgx/widgetApproval': { approval_tokens: Object.fromEntries(snapshot.queue.map((item) => [item.id, 'synthetic-token'])) } } });
      };
    }, { fixture, theme });
    await page.goto(pathToFileURL(source).href);
    const d2 = fixture.snapshot.queue[1].id;
    const d3 = fixture.snapshot.queue[2].id;
    await page.locator(`[data-row="${d2}"] .row-main`).click();
    await page.screenshot({ path: join(out, `${label}-opening-${theme}-${width}.png`), fullPage: true });
    if (label === 'after') {
      assert.equal(await page.locator('[data-read="loading"]').getAttribute('heading'), 'Opening decision');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), d2);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.__reads.length), 1);
      await page.locator(`[data-row="${d3}"] .row-main`).click();
      await page.evaluate(() => window.__finish(0));
      await page.waitForFunction(() => window.__reads.length === 2);
      assert.ok((await page.locator('.q-cmd').textContent()).includes('merge 17'));
      await page.evaluate(() => window.__finish(1));
      await page.waitForFunction(() => !document.querySelector('[data-read="loading"]'));
      assert.ok((await page.locator('.q-cmd').textContent()).includes('merge 19'));
      await page.locator(`[data-row="${d2}"] .row-main`).click();
      await page.evaluate(() => window.__reads[2].reject(Object.assign(new Error('Failed to fetch'), { code: 'network' })));
      await page.locator('[data-read="failed"]').waitFor();
      const retry = page.locator('[data-read="failed"]').getByRole('button', { name: 'Retry', exact: true });
      assert.ok((await retry.boundingBox()).height >= 44);
      await page.screenshot({ path: join(out, `after-selection-error-${theme}-${width}.png`), fullPage: true });
      await retry.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__reads.length === 4);
      assert.equal(await page.evaluate(() => window.__reads[3].args.focus.id), d2);
      await page.evaluate(() => window.__finish(3));
      await page.waitForFunction(() => !document.querySelector('[data-read]'));
      assert.ok((await page.locator('.q-cmd').textContent()).includes('merge 18'));
      assert.ok(await page.evaluate(() => window.__feedbackMs < 400));
      assert.equal(await page.evaluate(() => window.__calls.filter(({ name }) => name !== 'orgx_panel_snapshot').length), 0);
    }
    const metric = await page.evaluate(() => ({ feedbackMs: window.__feedbackMs,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      animations: document.getAnimations().filter((a) => a.playState === 'running').length }));
    assert.equal(metric.overflow, false); assert.equal(metric.animations, 0); assert.equal(errors.length, 0);
    metrics.push({ theme, width, ...metric, errors });
    await page.close();
  }
  writeFileSync(join(out, `${label}-metrics.json`), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ label, metrics }, null, 2));
} finally { await browser.close(); }
