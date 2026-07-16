import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { chromium, type ConsoleMessage, type Page } from 'playwright';

import { WIDGET_RESOURCES } from '../src/toolDefinitions';
import {
  MCP_APPS_SHARED_COMPONENT_PATHS,
  parseWidgetResourceUri,
  rewriteWidgetHtmlAssetUrls,
  sanitizeMcpAppsHtml,
} from '../src/widgetConfig';

const publicDir = resolve(process.cwd(), 'public');
const widgetDir = resolve(publicDir, 'widgets');
const testOrigin = 'http://orgx-widget.test';

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const sharedComponents = Object.fromEntries(
  MCP_APPS_SHARED_COMPONENT_PATHS.map((path) => [
    path,
    readFileSync(resolve(widgetDir, path), 'utf8'),
  ])
);
const interactionKitCss = readFileSync(
  resolve(widgetDir, 'shared/interaction-kit.css'),
  'utf8'
);
const interactionKitJs = readFileSync(
  resolve(widgetDir, 'shared/interaction-kit.js'),
  'utf8'
);

type RuntimeVariant = 'standalone-demo' | 'mcp-resource' | 'chatgpt';

interface CheckResult {
  widget: string;
  variant: RuntimeVariant;
  width: number;
  visibleCharacters: number;
  errors: string[];
}

function mimeType(path: string) {
  return mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream';
}

function resourceHtml(widgetFile: string) {
  const source = readFileSync(resolve(widgetDir, widgetFile), 'utf8');
  const rewritten = rewriteWidgetHtmlAssetUrls(
    source,
    `${testOrigin}/widgets/`
  );
  return sanitizeMcpAppsHtml(rewritten, {
    interactionKitCss,
    interactionKitJs,
    sharedComponents,
  });
}

async function installAssetRouter(page: Page, resourceBodies: Map<string, string>) {
  await page.route(`${testOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resourceBody = resourceBodies.get(relativePath);
    if (url.searchParams.get('resource') === 'true' && resourceBody) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: resourceBody,
      });
      return;
    }

    const filePath = resolve(publicDir, relativePath);
    if (!filePath.startsWith(`${publicDir}/`)) {
      await route.fulfill({ status: 403, body: 'Forbidden' });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: mimeType(filePath),
        body: readFileSync(filePath),
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Not found' });
    }
  });
}

async function checkWidget(
  page: Page,
  widget: string,
  widgetFile: string,
  variant: RuntimeVariant,
  width: number,
  resourceBodies: Map<string, string>
): Promise<CheckResult> {
  const errors: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  };
  const onPageError = (error: Error) => errors.push(`page: ${error.message}`);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  await page.setViewportSize({ width, height: 900 });
  if (variant === 'chatgpt') {
    await page.addInitScript({
      content: `window.openai = {
        toolOutput: null,
        setWidgetHeight() {},
        callTool: async () => ({ structuredContent: null }),
        openExternal() {},
        sendFollowUpMessage() {},
        requestDisplayMode: async () => ({ mode: 'inline' }),
      };`,
    });
  }

  const params = new URLSearchParams();
  if (variant === 'standalone-demo') params.set('demo', 'true');
  if (variant !== 'standalone-demo') params.set('resource', 'true');
  params.set('theme', 'dark');
  const response = await page.goto(
    `${testOrigin}/widgets/${widgetFile}?${params.toString()}`,
    { waitUntil: 'domcontentloaded' }
  );
  if (!response || response.status() !== 200) {
    errors.push(`http: ${response?.status() ?? 'no response'}`);
  }
  await page.waitForTimeout(750);

  const diagnostics = await page.evaluate(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    const visible: string[] = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent?.closest('script, style')) continue;
      visible.push(walker.currentNode.textContent || '');
    }
    const visibleText = visible.join(' ').replace(/\s+/g, ' ').trim();
    return {
      visibleText,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      protocol: document.documentElement.getAttribute('data-protocol'),
    };
  });

  if (!diagnostics.visibleText) errors.push('render: no visible text');
  if (
    diagnostics.visibleText.includes(
      'Cannot specify both `message` and `error` params'
    )
  ) {
    errors.push('render: MCP SDK source leaked into visible content');
  }
  if (diagnostics.overflow > 1) {
    errors.push(`layout: ${diagnostics.overflow}px horizontal overflow`);
  }
  if (variant === 'chatgpt' && diagnostics.protocol !== 'chatgpt') {
    errors.push(`runtime: expected chatgpt, received ${diagnostics.protocol}`);
  }

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  return {
    widget,
    variant,
    width,
    visibleCharacters: diagnostics.visibleText.length,
    errors,
  };
}

async function main() {
  const resourceBodies = new Map<string, string>();
  const resources = WIDGET_RESOURCES.map((resource) => {
    const { widgetFile } = parseWidgetResourceUri(resource.uri);
    resourceBodies.set(`widgets/${widgetFile}`, resourceHtml(widgetFile));
    return { widget: resource.name, widgetFile };
  });

  const browser = await chromium.launch({ headless: true });
  const results: CheckResult[] = [];
  try {
    for (const width of [1280, 375]) {
      for (const variant of [
        'standalone-demo',
        'mcp-resource',
        'chatgpt',
      ] as const) {
        for (const resource of resources) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: 'dark',
          });
          const page = await context.newPage();
          await installAssetRouter(page, resourceBodies);
          results.push(
            await checkWidget(
              page,
              resource.widget,
              resource.widgetFile,
              variant,
              width,
              resourceBodies
            )
          );
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => result.errors.length > 0);
  for (const result of results) {
    const status = result.errors.length ? '✗' : '✓';
    console.log(
      `${status} ${result.widget} ${result.variant} ${result.width}px (${result.visibleCharacters} visible chars)${
        result.errors.length ? ` — ${result.errors.join('; ')}` : ''
      }`
    );
  }
  console.log(
    `\n${results.length - failures.length}/${results.length} widget render checks passed.`
  );
  if (failures.length) process.exitCode = 1;
}

void main();
