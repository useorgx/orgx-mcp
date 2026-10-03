import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
describe('search card browser flow', () => {
  it('requests backend filters, keeps prior results on failure, and retries recovery', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(5_000);
      await page.route('**/*', route => route.abort());
      await page.route('https://mcp.useorgx.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.includes('..')) return route.abort();
        try {
          const body = readFileSync('public' + pathname);
          const contentType = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
          await route.fulfill({ body, contentType });
        } catch { await route.fulfill({ status: 404, body: '' }); }
      });
      await page.route('https://unpkg.com/**', route => route.fulfill({ body: '', contentType: 'application/javascript' }));
      await page.addInitScript(() => {
        const host = window as unknown as { openai: unknown; requests: unknown[]; failSearch: boolean };
        host.requests = []; host.failSearch = false;
        host.openai = {
          toolInput: { query: 'launch', type: 'initiative', limit: 1, cursor: 'old-page' },
          toolOutput: { results: [{ id: 'old', title: 'Original result', type: 'initiative' }] },
          setWidgetHeight() {},
          async callTool(tool: string, args: Record<string, unknown>) {
            host.requests.push({ tool, args });
            if (host.failSearch) throw new Error('private transport detail');
            return { structuredContent: { results: [{ id: 'new', title: 'Filtered result', type: 'task' }], next_call: null } };
          },
        };
      });
      await page.goto('https://mcp.useorgx.test/widgets/search-results.html', { waitUntil: 'domcontentloaded' });
      await page.getByText('Original result', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Search filters' }).click();
      await page.getByLabel('Type', { exact: true }).selectOption('task');
      await page.getByRole('radio', { name: 'Custom' }).check();
      await page.getByLabel('Created from', { exact: true }).fill('2026-10-01T00:00');
      await page.getByLabel('Created to', { exact: true }).fill('2026-10-02T00:00');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await page.getByText('Filtered result', { exact: true }).waitFor();
      const requests = await page.evaluate(() => (window as unknown as { requests: Array<{ args: Record<string, unknown> }> }).requests);
      expect(requests[0].args.type).toBe('task'); expect(requests[0].args.cursor).toBeUndefined();
      expect(requests[0].args.created_from).toBe(new Date('2026-10-01T00:00').toISOString());
      expect(requests[0].args.created_to).toBe(new Date('2026-10-02T00:00').toISOString());
      // A filtered search that lands closes the panel; the active filters stay in view.
      expect(await page.locator('.sr-active').textContent()).toContain('Task');
      await page.evaluate(() => { (window as unknown as { failSearch: boolean }).failSearch = true; });
      await page.getByRole('button', { name: 'Search filters' }).click();
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').textContent()).toContain('previous results are still shown');
      expect(await page.getByRole('alert').textContent()).not.toContain('private transport detail');
      expect(await page.getByText('Filtered result', { exact: true }).count()).toBe(1);
      await page.evaluate(() => { (window as unknown as { failSearch: boolean }).failSearch = false; });
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      expect(await page.getByText('Filtered result', { exact: true }).count()).toBe(1);
      await page.getByRole('button', { name: 'How search works' }).click();
      expect(await page.getByText(/Filters start a new search/).isVisible()).toBe(true);
    } finally { await browser.close(); }
  }, 30_000);
});
