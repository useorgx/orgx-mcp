import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const rootDir = resolve(process.cwd());
const publicDir = join(rootDir, 'public');
const screenshotsDir = join(publicDir, 'screenshots');
const socialPreviewDir = join(screenshotsDir, 'social-preview');
const finalOgPath = join(screenshotsDir, 'orgx-mcp-og.png');
const port = 4323;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const widgetCaptures = [
  {
    name: 'search-card',
    path: join(socialPreviewDir, 'search-card.png'),
    route: '/widgets/search-results.html?demo=true&theme=dark&embed=og-wide-search',
    selector: '.widget-shell-card .ox-card',
    viewport: { width: 920, height: 760 },
    margin: { top: 16, right: 16, bottom: 16, left: 16 },
    maxHeight: 418,
  },
  {
    name: 'scaffold-card',
    path: join(socialPreviewDir, 'scaffold-card.png'),
    route: '/widgets/scaffolded-initiative.html?demo=true&theme=dark&embed=og-wide-scaffold',
    selector: '.ox-card',
    viewport: { width: 920, height: 900 },
    margin: { top: 16, right: 16, bottom: 18, left: 16 },
  },
  {
    name: 'decision-card',
    path: join(socialPreviewDir, 'decision-card.png'),
    route: '/widgets/decisions.html?demo=true&theme=dark&embed=og-decision',
    selector: '.decision-card .ox-card',
    viewport: { width: 920, height: 720 },
    margin: { top: 14, right: 14, bottom: 14, left: 14 },
  },
];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function getMimeType(filePath) {
  return mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createStaticServer(baseDir, listenPort) {
  const server = createServer((req, res) => {
    const requestPath = req.url ? req.url.split('?')[0] : '/';
    const relativePath = requestPath === '/' ? '/index.html' : requestPath;
    const safePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(baseDir, safePath);

    if (!filePath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(listenPort, '127.0.0.1', () => resolveServer(server));
  });
}

function expandClip(box, viewport, margin) {
  const x = Math.max(0, Math.floor(box.x - margin.left));
  const y = Math.max(0, Math.floor(box.y - margin.top));
  const width = Math.min(
    viewport.width - x,
    Math.ceil(box.width + margin.left + margin.right)
  );
  const height = Math.min(
    viewport.height - y,
    Math.ceil(box.height + margin.top + margin.bottom)
  );
  return { x, y, width, height };
}

function constrainClipHeight(clip, viewport, maxHeight) {
  if (!maxHeight || clip.height <= maxHeight) return clip;
  return {
    ...clip,
    height: Math.min(maxHeight, viewport.height - clip.y),
  };
}

async function captureWidget(page, baseUrl, config) {
  await page.setViewportSize(config.viewport);
  await page.goto(`${baseUrl}${config.route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const locator = page.locator(config.selector);
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Could not resolve capture region for ${config.name} using ${config.selector}`);
  }

  const clip = constrainClipHeight(
    expandClip(box, config.viewport, config.margin),
    config.viewport,
    config.maxHeight
  );
  await page.screenshot({
    path: config.path,
    clip,
  });
}

async function captureOg(page, baseUrl) {
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.goto(`${baseUrl}/og-preview.html?v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: finalOgPath });
}

async function main() {
  ensureDir(socialPreviewDir);

  const server = await createStaticServer(publicDir, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });

  try {
    for (const capture of widgetCaptures) {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      await captureWidget(page, baseUrl, capture);
      await page.close();
    }

    const ogPage = await browser.newPage({ deviceScaleFactor: 1 });
    await captureOg(ogPage, baseUrl);
    await ogPage.close();

    console.log('Rendered social preview assets:');
    widgetCaptures.forEach((capture) => console.log(`- ${capture.path}`));
    console.log(`- ${finalOgPath}`);
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
