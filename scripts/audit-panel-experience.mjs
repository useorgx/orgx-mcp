import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Offline synthetic host only. It never connects to OrgX or executes the displayed command.
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/panel-experience.json'), 'utf8'));
const out = resolve(process.env.ORGX_PANEL_AUDIT_DIR || 'artifacts/qa/panel-experience');
mkdirSync(out, { recursive: true });
const source = resolve(process.env.ORGX_PANEL_AUDIT_HTML || 'public/widgets/orgx-panel.html');
const label = process.env.ORGX_PANEL_AUDIT_LABEL || 'after';
const browser = await chromium.launch({ headless: true });
const diagnostics = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [800, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(/^https?:/, (route) => route.abort());
    await page.addInitScript(({ fixture, theme }) => {
      window.__calls = [];
      window.openai = {
        theme, toolOutput: fixture.snapshot,
        toolResponseMetadata: { 'orgx/widgetApproval': { approval_tokens: Object.fromEntries(fixture.snapshot.queue.map((item) => [item.id, 'synthetic-token'])) } },
        setWidgetHeight() {},
        async callTool(name, args) {
          window.__calls.push({ name, args });
          if (name === 'orgx_widget_decide') return { structuredContent: { action: 'approved' } };
          if (name === 'orgx_command_status') return { structuredContent: { kind: 'decision', id: args.id, state: 'succeeded', next_poll_after_ms: null } };
          return { structuredContent: fixture.after, _meta: { 'orgx/widgetApproval': { approval_tokens: Object.fromEntries(fixture.after.queue.map((item) => [item.id, 'synthetic-next-token'])) } } };
        },
      };
    }, { fixture, theme });
    await page.goto(pathToFileURL(source).href);
    await page.locator('#pk-q').waitFor();
    await page.screenshot({ path: join(out, `${label}-pending-${theme}-${width}.png`), fullPage: true });
    const primary = page.locator('ox-footer[data-id]');
    assert.equal(await primary.count(), 1);
    await primary.getByRole('button', { name: 'Allow once', exact: true }).click();
    await page.locator('.notice').filter({ hasText: 'Allowed once by you' }).waitFor();
    await page.screenshot({ path: join(out, `${label}-receipt-${theme}-${width}.png`), fullPage: true });
    const metrics = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('*')].flatMap((el) => el.shadowRoot ? [...el.shadowRoot.querySelectorAll('*')] : [el]);
      const targets = nodes.filter((el) => el.matches('button, summary, a[href]') && el.getBoundingClientRect().width && getComputedStyle(el).visibility !== 'hidden');
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        smallTargets: targets.filter((el) => { const r = el.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map((el) => ({ text: el.textContent.trim(), height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width })),
        animationCount: document.getAnimations().filter((animation) => animation.playState === 'running').length,
        duplicateMutations: window.__calls.filter(({ name }) => name === 'orgx_widget_decide').length,
      };
    });
    diagnostics.push({ theme, width, ...metrics, errors });
    assert.equal(metrics.overflow, false);
    assert.equal(metrics.duplicateMutations, 1);
    assert.equal(errors.length, 0);
    assert.equal(metrics.animationCount, 0);
    if (label === 'after') {
      assert.equal(metrics.smallTargets.length, 0);
      const summary = page.locator('.receipt-details summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.receipt-details').getAttribute('open'), '');
      await page.screenshot({ path: join(out, `${label}-details-${theme}-${width}.png`), fullPage: true });
    }
    await page.close();
  }
  // Deterministic fixture coverage for the other panel states, without a host mutation.
  if (label === 'after') {
    for (const state of ['loading', 'signed-out', 'first-use', 'calm', 'degraded', 'stale', 'permission-limited', 'options', 'long', 'decide-in-orgx']) {
      const page = await browser.newPage({ viewport: { width: 375, height: 1000 }, reducedMotion: 'reduce' });
      await page.route(/^https?:/, (route) => route.abort());
      await page.goto(`${pathToFileURL(source).href}?gallery=true&state=${state}`);
      await page.screenshot({ path: join(out, `state-${state}-375.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.close();
    }
  }
  writeFileSync(join(out, `${label}-diagnostics.json`), JSON.stringify(diagnostics, null, 2));
  console.log(JSON.stringify({ label, cases: diagnostics.length, diagnostics }, null, 2));
} finally { await browser.close(); }
