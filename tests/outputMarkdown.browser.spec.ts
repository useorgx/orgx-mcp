import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHostedWidgetFixtures, WIDGET_FIXTURE_ORIGIN } from './hostedWidgetFixtures';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => { await browser?.close(); });

describe.each(['light', 'dark'] as const)('output Markdown on a 390px %s phone', (theme) => {
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
            content: '# Answer\n\n**Review the deck.**\n\n| Work | Owner | Due | State | Next |\n| --- | --- | --- | --- | --- |\n| Deck | Hope | Friday | Ready | Review |\n\n## <img src=x onerror="window.compromised=true">\n\n[Unsafe](javascript:alert(1))' },
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
