import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('public');
const origin = process.env.ORGX_WIDGET_ORIGIN || 'http://widget-errors.test';
const baseline = process.argv.includes('--baseline');
const degraded = process.argv.includes('--degraded');
const output = resolve('artifacts/qa/widget-errors', degraded ? baseline ? 'degraded-before' : 'degraded' : baseline ? 'before' : 'after');
mkdirSync(output, { recursive: true });
const widgets = ['decisions', 'agent-status', 'search-results', 'scaffolded-initiative',
  'initiative-pulse', 'task-spawned', 'morning-brief', 'artifact-review',
  'plan-session-live', 'entity-card', 'work-ledger'];
const message = 'The upstream service is temporarily unavailable. Retry this request. ' + 'Long reference '.repeat(25);
const failures = degraded ? [
  { degraded: ['brief_route_timeout'], session_summary: null, intelligence: {}, message: 'Brief summary is refreshing' },
  { structuredContent: { data: { degraded: true, results: [], message: 'Partial results' } } },
] : [
  { ok: false, error: { code: 'upstream_unavailable', message } },
  { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { message } }) }] },
];
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch(!existsSync(chromium.executablePath()) && existsSync(chrome) ? { executablePath: chrome } : {});
let checks = 0;
try {
  for (const width of [1440, 768, 375]) for (const theme of ['dark', 'light']) for (const widget of widgets) {
    for (const [variant, failure] of failures.entries()) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      if (!process.env.ORGX_WIDGET_ORIGIN) await page.route(`${origin}/**`, async route => {
        const path = resolve(root, new URL(route.request().url()).pathname.slice(1));
        if (!path.startsWith(root + '/') || !existsSync(path)) return route.fulfill({ status: 404 });
        let body = readFileSync(path);
        if (baseline && path.endsWith('/shared/widget-runtime.js')) body = execFileSync('git', ['show', 'HEAD:public/widgets/shared/widget-runtime.js']);
        await route.fulfill({ body, contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream' });
      });
      await page.addInitScript(({ failure, theme }) => {
        window.openai = { theme, toolOutput: failure, setWidgetHeight() {}, openExternal() {} };
      }, { failure, theme });
      await page.goto(`${origin}/widgets/${widget}.html?resource=true&theme=${theme}`);
      await page.waitForFunction(() => window.OrgXWidgetRuntime);
      if (degraded && widget === 'morning-brief') await page.locator('.skeleton-shell').waitFor({ state: 'hidden' });
      if ((widget === 'entity-card' || (degraded && widget === 'morning-brief')) && variant === 0) await page.screenshot({ path: `${output}/${widget}-${theme}-${width}.png`, fullPage: true });
      if (!baseline) {
        const alert = degraded ? page.locator('#orgx-data-availability') : page.getByRole('alert');
        await alert.waitFor();
        assert.match(await alert.innerText(), degraded ? /Data may be incomplete/ : /Request failed/);
        if (degraded) {
          assert.equal(await page.locator('[data-orgx-error-hidden]').count(), 0);
          if (widget === 'morning-brief' && variant === 0) {
            const text = await page.locator('body').innerText();
            assert.match(text, /Source data is refreshing/);
            assert.doesNotMatch(text, /economic proof ready|outputs? delivered|decisions? made/);
            assert.equal(await page.locator('#hero-value').innerText(), '—');
          }
          await page.evaluate(() => window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: null } } })));
          assert.equal(await page.locator('#orgx-data-availability').count(), 1);
        } else assert.match(await alert.innerText(), /upstream service is temporarily unavailable/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${widget} overflows at ${width}`);
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: { message: 'Recovered result' } } } })));
        assert.equal(await page.locator('#orgx-tool-error').count(), 0, `${widget} does not recover`);
        assert.equal(await page.locator('#orgx-data-availability').count(), 0, `${widget} retains a stale partial-data notice`);
        assert.equal(await page.locator('[data-orgx-error-hidden]').count(), 0);
      }
      await page.close(); checks++;
    }
  }
  console.log(`${checks} ${baseline ? 'baseline captures' : degraded ? 'partial-data, overflow, and recovery cases passed' : 'error, overflow, and recovery cases passed'}`);
} finally { await browser.close(); }
