import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const rootDir = resolve(process.cwd());
const publicDir = join(rootDir, 'public');
const outDir = join(rootDir, 'artifacts', 'widget-gallery', '2026-07-17', 'final');
const port = 4329;

const cases = [
  {
    name: 'desktop-dark',
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    query: 'widget=scaffolded-initiative&state=urgent&viewport=wide&theme=dark',
  },
  {
    name: 'tablet-light',
    viewport: { width: 768, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    query: 'widget=artifact-review&state=populated&viewport=tablet&theme=light',
  },
  {
    name: 'phone-dark',
    viewport: { width: 375, height: 812 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    query: 'widget=daily-brief&state=agents&viewport=phone&theme=dark',
  },
  {
    name: 'desktop-reduced',
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    query: 'widget=decisions&state=loading&viewport=wide&theme=dark',
  },
];

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function createStaticServer() {
  const server = createServer((request, response) => {
    const requestPath = request.url ? request.url.split('?')[0] : '/';
    const relativePath = requestPath === '/' ? '/index.html' : requestPath;
    const safePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(publicDir, safePath);
    if (!filePath.startsWith(publicDir)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    if (!existsSync(filePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(port, '127.0.0.1', () => resolveServer(server));
  });
}

function resolveLaunchOptions() {
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return {};
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(macChrome) ? { executablePath: macChrome } : {};
}

async function inspectCase(browser, config) {
  const context = await browser.newContext({
    viewport: config.viewport,
    colorScheme: config.colorScheme,
    reducedMotion: config.reducedMotion,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const url = `http://127.0.0.1:${port}/widgets/index.html?${config.query}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);

  const diagnostics = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const smallTargets = Array.from(document.querySelectorAll('button, a[href], input'))
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute('aria-label') || element.textContent.trim(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < 44 || target.height < 44);
    const activeRow = document.querySelector('.registry-row.is-active');
    const registry = document.getElementById('registry-list');
    const activeRect = activeRow?.getBoundingClientRect();
    const registryRect = registry?.getBoundingClientRect();
    const activeVisibleInRegistry =
      !activeRect ||
      !registryRect ||
      (activeRect.top >= registryRect.top - 1 && activeRect.bottom <= registryRect.bottom + 1);
    return {
      title: document.title,
      horizontalOverflow:
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        document.documentElement.clientWidth,
      registryCount: document.querySelectorAll('.registry-row').length,
      coverage: document.getElementById('coverage-copy')?.textContent || '',
      selected: activeRow?.dataset.widgetId || '',
      selectedState:
        document.querySelector('#state-options .is-active')?.textContent?.trim() || '',
      iframeUrl: document.getElementById('preview-frame')?.src || '',
      manifestWarning: document.getElementById('manifest-warning')?.classList.contains('is-visible'),
      smallTargets,
      activeVisibleInRegistry,
    };
  });

  await page.locator('#widget-filter').fill('artifact');
  const filteredRows = await page.locator('.registry-row').count();
  await page.locator('#widget-filter').fill('');
  const firstRow = page.locator('.registry-row').first();
  await firstRow.focus();
  await page.keyboard.press('ArrowDown');
  const keyboardMoved = await page.evaluate(
    () => document.activeElement?.classList.contains('registry-row') && document.activeElement !== document.querySelector('.registry-row')
  );

  const screenshot = join(outDir, `${config.name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
  await context.close();
  return {
    case: config.name,
    url,
    consoleErrors,
    pageErrors,
    filteredRows,
    keyboardMoved,
    ...diagnostics,
    screenshot,
  };
}

function collectFailures(results) {
  const failures = [];
  for (const result of results) {
    const add = (issue, detail) => failures.push({ case: result.case, issue, detail });
    if (result.consoleErrors.length || result.pageErrors.length) {
      add('runtime-error', [...result.consoleErrors, ...result.pageErrors]);
    }
    if (result.horizontalOverflow > 1) add('horizontal-overflow', result.horizontalOverflow);
    if (result.registryCount !== 11) add('registry-coverage', result.registryCount);
    if (!result.coverage.includes('11/11')) add('manifest-coverage', result.coverage);
    if (result.manifestWarning) add('manifest-warning', true);
    if (result.smallTargets.length) add('undersized-target', result.smallTargets);
    if (!result.activeVisibleInRegistry) add('selected-row-not-visible', result.selected);
    if (result.filteredRows !== 1) add('filter-contract', result.filteredRows);
    if (!result.keyboardMoved) add('keyboard-navigation', false);
  }
  return failures;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const server = await createStaticServer();
  const browser = await chromium.launch({ headless: true, ...resolveLaunchOptions() });
  const results = [];
  try {
    for (const config of cases) results.push(await inspectCase(browser, config));
    const report = {
      generatedAt: new Date().toISOString(),
      results,
      failures: collectFailures(results),
    };
    const reportPath = join(outDir, 'report.json');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Widget gallery audit: ${results.length} viewport cases, ${report.failures.length} failures`);
    console.log(reportPath);
    report.failures.forEach((failure) => console.log(`- ${failure.case}: ${failure.issue} ${JSON.stringify(failure.detail)}`));
    if (report.failures.length) process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
