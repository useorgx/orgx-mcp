import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

// Real tool-shaped payloads, independent of the gallery's demo fixtures.
const origin = 'http://widget-payload.test';
const root = resolve('public');
const output = resolve('artifacts/widget-payloads');
mkdirSync(output, { recursive: true });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch(!existsSync(chromium.executablePath()) && existsSync(chrome) ? { executablePath: chrome } : {});
let checks = 0;
try {
  for (const width of [1440, 375]) {
    for (const theme of ['dark', 'light']) {
      for (const action of ['estimate', 'guard', 'route']) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        await setup(page, { _action: action, allowed: action === 'guard' ? false : undefined, initiative_name: 'Launch', estimate: { recommended_model: 'standard', estimated_cost_usd: 0.02 } }, theme);
        await page.goto(`${origin}/widgets/task-spawned.html?resource=true&theme=${theme}`);
        await page.locator('.dispatch-spine').waitFor();
        const text = await page.locator('#content').innerText();
        assert.match(text, /No agent work was dispatched/);
        assert.doesNotMatch(text, /Queued|Routing pending|Sync time unavailable|Awaiting receipt ID|Open execution/i);
        assert.equal(await page.locator('.widget-shell-card').getAttribute('data-state'), action === 'guard' ? 'blocked' : 'preflight');
        if (action === 'guard') assert.match(text, /Dispatch blocked/i);
        await page.screenshot({ path: `${output}/${action}-${theme}-${width}.png`, fullPage: true });
        await page.close(); checks++;
      }
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await setup(page, { type: 'task', pagination: { has_more: true }, next_call: { tool: 'orgx_search', args: { type: 'task', offset: 8 } }, results: Array.from({ length: 8 }, (_, i) => ({ id: `task-${i}`, name: `Campaign ${i}`, snippet: '', description: i === 0 ? '## Your Assignment **Goal:** Produce a [campaign](https://example.com).' : undefined })) }, theme);
      await page.goto(`${origin}/widgets/search-results.html?resource=true&theme=${theme}`);
      await page.locator('.result-card').first().waitFor();
      const text = await page.locator('#content').innerText();
      assert.match(text, /Your Assignment Goal: Produce a campaign/);
      assert.doesNotMatch(text, /##|\*\*|Recently updated|Just now|No excerpt available/);
      assert.match(await page.locator('.result-card').first().getAttribute('href'), /task=task-0/);
      assert.match(text, /Campaign 0/);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      assert.doesNotMatch(await page.locator('.result-list').innerText(), /Campaign 0/);
      await page.getByRole('button', { name: 'Previous', exact: true }).click();
      assert.match(await page.locator('.result-list').innerText(), /Campaign 0/);
      await page.getByRole('button', { name: 'Load more results', exact: true }).click();
      await page.getByRole('alert').waitFor();
      assert.match(await page.locator('.result-list').innerText(), /Campaign 0/);
      await page.getByRole('button', { name: 'Load more results', exact: true }).click();
      await page.getByText('Campaign 8', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Load more results', exact: true }).count(), 0);
      await page.screenshot({ path: `${output}/search-${theme}-${width}.png`, fullPage: true });
      await page.close(); checks++;
    }
  }
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await setup(page, null, 'dark');
    await page.goto(`${origin}/widgets/scaffolded-initiative.html?demo=true&theme=dark`);
    const toggle = page.locator('[data-toggle-all]');
    await toggle.waitFor();
    assert.equal(await page.locator('.node-toggle[aria-expanded="true"]').count(), 0);
    await toggle.click();
    assert.ok(await page.locator('.node-toggle[aria-expanded="true"]').count() > 0);
    await toggle.click();
    assert.equal(await page.locator('.node-toggle[aria-expanded="true"]').count(), 0);
    await page.goto(`${origin}/widgets/agent-status.html?demo=true&theme=dark`);
    await page.locator('[data-agent-tab]').first().waitFor();
    await page.locator('[data-agent-tab]').nth(1).click();
    assert.equal(await page.locator('[data-agent-tab]').nth(1).getAttribute('aria-selected'), 'true');
    await page.locator('[data-action="toggle-details"]').click();
    assert.equal(await page.locator('[data-action="toggle-details"]').getAttribute('aria-expanded'), 'true');
    await page.goto(`${origin}/widgets/morning-brief.html?demo=true&theme=dark`);
    await page.locator('#trigger-output').click();
    assert.equal(await page.locator('#trigger-output').getAttribute('aria-expanded'), 'true');
    await page.goto(`${origin}/widgets/daily-brief.html?demo=true&theme=dark`);
    await page.locator('[data-lens="agents"]').click();
    assert.match(await page.locator('[data-lens="agents"]').getAttribute('class'), /active/);
    await page.goto(`${origin}/widgets/plan-session-live.html?demo=true&theme=dark`);
    await page.locator('[data-lens="activity"]').click();
    assert.equal(await page.locator('[data-lens="activity"]').getAttribute('aria-selected'), 'true');
    await page.locator('[data-lens="plan"]').click();
    if (width === 375) await page.locator('[data-section-select]').selectOption('1');
    else await page.locator('[data-section-index="1"]').click();
    assert.match(await page.locator('[data-section-body]').innerText(), /Answer Room/);
    await page.goto(`${origin}/widgets/initiative-pulse.html?demo=true&theme=dark`);
    await page.locator('.pulse-attention').click();
    assert.equal(await page.locator('.pulse-attention').getAttribute('aria-expanded'), 'true');
    await page.close(); checks += 6;
  }
  console.log(`${checks} payload, pagination, and disclosure cases passed`);
} finally { await browser.close(); }

async function setup(page, payload, theme) {
  await page.route(`${origin}/**`, async route => {
    const path = resolve(root, new URL(route.request().url()).pathname.slice(1));
    if (!path.startsWith(root + '/')) return route.fulfill({ status: 403 });
    if (!existsSync(path)) return route.fulfill({ status: 404 });
    await route.fulfill({ body: readFileSync(path), contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(path)] || 'application/octet-stream' });
  });
  await page.addInitScript(({ payload, theme }) => {
    if (payload === null) return;
    let calls = 0;
    window.openai = { theme, toolOutput: payload, setWidgetHeight() {}, openExternal() {}, callTool: async (name, args) => {
      if (name !== 'orgx_search' || args.offset !== 8) throw new Error('Unexpected continuation');
      if (++calls === 1) throw new Error('Temporary failure');
      return { structuredContent: { type: 'task', results: [{ id: 'task-8', name: 'Campaign 8' }], pagination: { has_more: false }, next_call: null } };
    } };
  }, { payload, theme });
}
