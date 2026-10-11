import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Page } from 'playwright';

export const WIDGET_FIXTURE_ORIGIN = 'https://mcp.useorgx.test';

/** Exercise hosted widgets offline, with assets restricted to the public tree. */
export async function installHostedWidgetFixtures(page: Page): Promise<void> {
  const root = resolve('public');
  await page.route('**/*', (route) => route.abort());
  await page.route(`${WIDGET_FIXTURE_ORIGIN}/**`, async (route) => {
    try {
      const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
      const file = resolve(root, `.${pathname}`);
      if (!file.startsWith(`${root}${sep}`)) return route.abort();
      const body = await readFile(file);
      const contentType = pathname.endsWith('.js') ? 'application/javascript'
        : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.json') ? 'application/json' : 'text/html';
      await route.fulfill({ body, contentType });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
}
