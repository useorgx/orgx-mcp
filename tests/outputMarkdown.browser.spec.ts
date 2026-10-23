import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHostedWidgetFixtures, WIDGET_FIXTURE_ORIGIN } from './hostedWidgetFixtures';
import { outputFrontDoor, FRONT_DOOR_ARTIFACT_ID } from './fixtures/outputFrontDoor';
import { snapshot } from './fixtures/panel';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => { await browser?.close(); });

describe.each(['light', 'dark'] as const)('output Markdown on a 390px %s phone', (theme) => {
  it('hydrates the actual panel summary and renders the same safe Markdown', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await installHostedWidgetFixtures(page);
    const markdown = '# Client answer\n\n| Work | Owner | Due | State | Next |\n| --- | --- | --- | --- | --- |\n| Deck | Hope | Friday | Ready | Review |\n\n## <img src=x onerror="window.compromised=true">\n\n```mermaid\nflowchart LR\n A-->B\n```';
    const data = snapshot({ outputs: { status: 'ok', total: 1, items: [{ id: FRONT_DOOR_ARTIFACT_ID, title: 'Client deck', type: 'document', family: 'writing', status: 'in_review', has_preview: true, external_url: null, initiative_id: null, task_id: null, made_at: new Date().toISOString(), made_by: 'OrgX', accepted: { state: 'waiting', at: null, by: null }, landed: null, moved: null, checks: [], checks_source: null, eval_score: null, decision_id: null, url: `https://useorgx.com/artifacts/${FRONT_DOOR_ARTIFACT_ID}` }] } });
    await page.addInitScript(({ theme, data, door, markdown, id }) => {
      (window as unknown as Record<string, unknown>).openai = { theme, toolOutput: data, setWidgetHeight() {}, async callTool(name: string, args: Record<string, unknown>) {
        if (name === 'orgx_panel_snapshot' && args.view === 'outputs') return { structuredContent: data, _meta: { 'orgx/panelPreviews': { [id]: { summary: null, preview: markdown, ...(args.query === id ? { frontDoor: door } : {}) } } } };
        return new Promise(() => undefined);
      } };
    }, { theme, data, door: outputFrontDoor(), markdown, id: FRONT_DOOR_ARTIFACT_ID });
    try {
      await page.goto(`${WIDGET_FIXTURE_ORIGIN}/widgets/orgx-panel.html`);
      await page.locator('[data-tab="outputs"]').click();
      await page.locator(`[data-action="out-select"][data-id="${FRONT_DOOR_ARTIFACT_ID}"]`).click();
      const summary = page.locator('.pn-md-detail [data-front-door]');
      await summary.waitFor();
      expect(await summary.locator('.ox-fd-answer').innerText()).toContain('Review the client deck');
      expect(await page.locator('.pn-md-detail .ox-markdown h1').innerText()).toBe('Client answer');
      expect(await page.locator('.pn-md-detail .ox-markdown img').count()).toBe(0);
      expect(await page.locator('.pn-md-detail .ox-markdown').innerText()).toContain('Diagram preview unavailable; a rendered file is needed.');
      expect(await page.locator('.pn-md-detail .ox-markdown').innerText()).not.toContain('flowchart');
      expect(await page.locator('.pn-md-detail table[data-stack]').count()).toBe(1);
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).compromised)).toBeUndefined();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    } finally { await context.close(); }
  }, 30000);
  it('shows the canonical answer, context, file and run receipt without overflow', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installHostedWidgetFixtures(page);
    await page.addInitScript(({ theme, frontDoor, id }) => {
      (window as unknown as Record<string, unknown>).openai = { theme, setWidgetHeight() {}, toolOutput: {
        artifact: { id, name: 'Client deck', artifact_type: 'document', status: 'in_review', version: 2, content: '# Review copy\n\nReady for review.' },
        reviewContract: { schemaVersion: 'artifact_review_contract.v1', quality: { state: 'unscored', score: null }, workflow: { headline: 'Review the output' }, frontDoor }, reviewContractSource: 'canonical',
      } };
    }, { theme, frontDoor: outputFrontDoor(), id: FRONT_DOOR_ARTIFACT_ID });
    try {
      await page.goto(`${WIDGET_FIXTURE_ORIGIN}/widgets/artifact-review.html`);
      const summary = page.locator('[data-front-door]');
      await summary.waitFor();
      expect(await summary.locator('.ox-fd-answer').innerText()).toContain('Review the client deck');
      expect(await summary.locator('.ox-fd-context').innerText()).toContain('Budget was not recorded.');
      expect(await summary.locator('[aria-current="page"]').innerText()).toContain('Client deck.md');
      expect(await summary.locator('.ox-fd-receipt').innerText()).toContain('$0.00');
      expect(await summary.locator('.ox-fd-receipt dt').allTextContents()).toContain('Expert minutes');
      expect(await summary.locator('.ox-fd-receipt').innerText()).not.toContain('minutes left');
      expect(await summary.locator('.ox-fd-receipt dd').first().evaluate((node) => getComputedStyle(node).fontFamily)).toContain('monospace');
      expect(await summary.locator('.ox-fd-context').evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      expect(await summary.locator('button').count()).toBe(0);
      await summary.locator('.ox-fd-checks summary').click();
      expect(await summary.locator('.ox-fd-checks').innerText()).toContain('Reported by the producer.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 30000);
  it('renders the actual widget table without overflow or active source HTML', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installHostedWidgetFixtures(page);
    await page.addInitScript(({ theme }) => {
      (window as unknown as Record<string, unknown>).openai = {
        theme, setWidgetHeight() {},
        toolOutput: {
          artifact: { id: 'markdown-output', name: 'Client report', artifact_type: 'product.report', status: 'in_review',
            content: '# Answer\n\n**Review the deck.**\n\n| Work | Owner | Due | State | Next |\n| --- | --- | --- | --- | --- |\n| Deck | Hope | Friday | Ready | Review |\n\n## <img src=x onerror="window.compromised=true">\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n[Unsafe](javascript:alert(1))' },
          reviewContract: { schemaVersion: 'artifact_review_contract.v1', quality: { state: 'unscored', score: null }, workflow: { headline: 'Review the output' } },
          reviewContractSource: 'canonical',
        },
      };
    }, { theme });
    try {
      await page.goto(`${WIDGET_FIXTURE_ORIGIN}/widgets/artifact-review.html`);
      const preview = page.locator('.artifact-preview__markdown');
      await preview.waitFor();
      expect(await preview.locator('h1').innerText()).toBe('Answer');
      expect(await preview.innerText()).toContain('Diagram preview unavailable; a rendered file is needed.');
      expect(await preview.innerText()).not.toContain('flowchart');
      expect(await preview.locator('table[data-stack] th').count()).toBe(5);
      expect(await preview.locator('img,script,iframe').count()).toBe(0);
      expect(await preview.locator('a').count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).compromised)).toBeUndefined();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(await preview.locator('table[data-stack] tbody tr').evaluate((row) => getComputedStyle(row).display)).toBe('block');
      expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 30000);
});
