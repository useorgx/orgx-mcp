import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const rootDir = resolve(process.cwd());
const publicDir = join(rootDir, 'public');
const labelArg = process.argv.find((arg) => arg.startsWith('--label='));
const label = labelArg ? labelArg.slice('--label='.length) : 'current';
const outDir = join(rootDir, 'artifacts', 'widget-audit', '2026-07-17', label);
const port = 4327;

const widgets = [
  'decisions',
  'agent-status',
  'search-results',
  'scaffolded-initiative',
  'initiative-pulse',
  'task-spawned',
  'morning-brief',
  'artifact-review',
  'plan-session-live',
  'daily-brief',
  'scaffold-streaming',
];

const states = [
  { name: 'populated', query: 'demo=true&theme=dark' },
  { name: 'loading', query: 'loading=true&theme=dark' },
  { name: 'empty', query: 'theme=dark' },
];

const widgetSpecificStates = {
  'search-results': [
    { name: 'error', query: 'demo=true&state=error&theme=dark' },
  ],
  'scaffolded-initiative': [
    { name: 'long', query: 'demo=true&scenario=branchy&theme=dark' },
    { name: 'urgent', query: 'demo=true&status=blocked&theme=dark' },
    { name: 'resolved', query: 'demo=true&status=completed&theme=dark' },
  ],
  'daily-brief': [
    { name: 'agents-lens', query: 'demo=true&lens=agents&theme=dark' },
  ],
};

const viewports = [
  { name: 'desktop', width: 1440, height: 1000, reducedMotion: 'no-preference' },
  { name: 'tablet', width: 768, height: 900, reducedMotion: 'no-preference' },
  { name: 'phone', width: 375, height: 812, reducedMotion: 'no-preference' },
  { name: 'desktop-reduced', width: 1440, height: 1000, reducedMotion: 'reduce' },
];

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

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

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
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

async function inspectPage(page, widget, state, viewport) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const url = `http://127.0.0.1:${port}/widgets/${widget}.html?${state.query}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(state.name === 'loading' ? 350 : 900);

  const diagnostics = await page.evaluate(({ widgetName, stateName }) => {
    const root = document.documentElement;
    const body = document.body;
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const smallTargets = Array.from(
      document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')
    )
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute('aria-label') ||
            element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
            element.tagName,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < 44 || target.height < 44);

    const bodyText = body.innerText.replace(/\s+/g, ' ').trim();
    const suspiciousText = ['undefined', 'NaN', '[object Object]'].filter((token) =>
      bodyText.includes(token)
    );
    if (
      widgetName === 'scaffolded-initiative' &&
      stateName === 'populated' &&
      bodyText.includes('Unassigned')
    ) {
      suspiciousText.push('Unassigned');
    }

    return {
      title: document.title,
      horizontalOverflow: Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth,
      smallTargets,
      suspiciousText,
      bodyTextLength: bodyText.length,
      hasVisiblePrimaryAction: Array.from(
        document.querySelectorAll(
          '.ox-action-btn--primary, .ox-link-btn--primary, .ox-btn-primary, [data-primary-action="true"]'
        )
      ).some(visible),
    };
  }, { widgetName: widget, stateName: state.name });

  const screenshotPath = join(outDir, `${widget}-${state.name}-${viewport.name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });

  const interaction = await page.evaluate(() => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        !element.matches(':disabled, [aria-disabled="true"]')
      );
    };
    const target = Array.from(
      document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')
    ).find(visible);
    if (!target) return null;
    target.setAttribute('data-audit-interaction-target', 'true');
    const label =
      target.getAttribute('aria-label') ||
      target.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
      target.tagName;
    return { label };
  });

  const readInteractionStyle = async () =>
    page.locator('[data-audit-interaction-target="true"]').evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
        transform: style.transform,
        outline: style.outline,
        boxShadow: style.boxShadow,
        transitionDuration: style.transitionDuration,
      };
    });

  let microinteraction = null;
  let focus = null;
  if (interaction) {
    const target = page.locator('[data-audit-interaction-target="true"]');
    const resting = await readInteractionStyle();
    await target.hover();
    await page.waitForTimeout(60);
    const hovered = await readInteractionStyle();
    await target.focus();
    await page.waitForTimeout(30);
    const focused = await readInteractionStyle();
    focus = {
      label: interaction.label,
      outline: focused.outline,
      boxShadow: focused.boxShadow,
    };
    const focusFeedback =
      !/^none(?:\s|$)/.test(focused.outline) ||
      (focused.boxShadow !== 'none' && focused.boxShadow !== resting.boxShadow);
    const hoverFeedback = ['backgroundColor', 'borderColor', 'color', 'transform'].some(
      (key) => hovered[key] !== resting[key]
    );
    microinteraction = {
      label: interaction.label,
      hoverFeedback,
      focusFeedback,
      reducedMotion: viewport.reducedMotion === 'reduce',
      transitionDuration: focused.transitionDuration,
    };
    if (
      state.name === 'populated' &&
      viewport.name === 'desktop'
    ) {
      await page.screenshot({
        path: join(outDir, `${widget}-${state.name}-${viewport.name}-focus.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }

  return {
    widget,
    state: state.name,
    viewport: viewport.name,
    url,
    consoleErrors,
    pageErrors,
    ...diagnostics,
    focus,
    microinteraction,
    screenshot: screenshotPath,
  };
}

function summarize(results) {
  const failures = [];
  for (const result of results) {
    if (result.consoleErrors.length || result.pageErrors.length) {
      failures.push({
        widget: result.widget,
        state: result.state,
        viewport: result.viewport,
        issue: 'runtime-error',
        detail: [...result.consoleErrors, ...result.pageErrors],
      });
    }
    if (result.horizontalOverflow > 1) {
      failures.push({
        widget: result.widget,
        state: result.state,
        viewport: result.viewport,
        issue: 'horizontal-overflow',
        detail: `${Math.round(result.horizontalOverflow)}px`,
      });
    }
    if (result.suspiciousText.length) {
      failures.push({
        widget: result.widget,
        state: result.state,
        viewport: result.viewport,
        issue: 'suspicious-data',
        detail: result.suspiciousText,
      });
    }
    if (result.smallTargets.length) {
      failures.push({
        widget: result.widget,
        state: result.state,
        viewport: result.viewport,
        issue: 'undersized-target',
        detail: result.smallTargets,
      });
    }
    if (result.microinteraction && !result.microinteraction.focusFeedback) {
      failures.push({
        widget: result.widget,
        state: result.state,
        viewport: result.viewport,
        issue: 'missing-focus-feedback',
        detail: result.microinteraction.label,
      });
    }
  }
  return failures;
}

async function main() {
  ensureDir(outDir);
  const server = await createStaticServer();
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: 'dark',
        reducedMotion: viewport.reducedMotion,
      });
      for (const widget of widgets) {
        const widgetStates = [
          ...states.map((state) =>
            widget === 'search-results' && state.name === 'empty'
              ? {
                  name: 'empty',
                  query: 'demo=true&state=empty&theme=dark',
                }
              : state
          ),
          ...(widgetSpecificStates[widget] || []),
        ];
        for (const state of widgetStates) {
          const page = await context.newPage();
          results.push(await inspectPage(page, widget, state, viewport));
          await page.close();
        }
      }
      await context.close();
    }

    const report = {
      generatedAt: new Date().toISOString(),
      label,
      results,
      failures: summarize(results),
    };
    const reportPath = join(outDir, 'report.json');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Widget audit: ${results.length} render checks, ${report.failures.length} failures`);
    console.log(reportPath);
    for (const failure of report.failures) {
      console.log(
        `- ${failure.widget}/${failure.state}/${failure.viewport}: ${failure.issue} ${JSON.stringify(failure.detail)}`
      );
    }
    if (report.failures.length > 0) process.exitCode = 1;
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
