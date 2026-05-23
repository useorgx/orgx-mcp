/**
 * Render OrgX MCP widgets at their NATURAL DESKTOP layout, then downscale
 * (preserving aspect ratio) to OpenAI ChatGPT App directory upload spec:
 *
 *   - Output: 706 wide × 400-860 tall (2× retina-quality)
 *   - PNG, dark theme, mobile column orientation
 *
 * We render at 600 logical px wide (the widget's natural desktop column where
 * its real layout — avatars on the right, side-by-side stats, etc. — kicks in)
 * at 2× DPR, then use macOS `sips` to scale the captured PNG to fit 706 wide.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const rootDir = resolve(process.cwd());
const publicDir = join(rootDir, 'public');
const outDir = join(publicDir, 'screenshots', 'app-mobile');
const port = 4325;

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

// OpenAI spec (the file we upload)
const OUT_W = 706;
const OUT_H_MIN = 400;
const OUT_H_MAX = 860;

// Source render — widget at natural desktop column width
const SRC_W = 600;              // logical px (widget's .container is max-width: 540)
const SRC_DPR = 2;              // 2× retina source
// Max source-height (logical) that still fits OUT_H_MAX after aspect-preserving downscale.
// scaleFactor = OUT_W / SRC_W → out_h = src_h * scaleFactor
// So MAX_SRC_H = OUT_H_MAX / scaleFactor = OUT_H_MAX * SRC_W / OUT_W
const MAX_SRC_H = Math.floor((OUT_H_MAX * SRC_W) / OUT_W); // 731

// scrollY = logical px to skip past the hero band so widget BODY anchors the shot.
// afterLoad = optional hook to interact with the widget before capture.
const shots = [
  {
    name: 'scaffolded-initiative',
    widget: 'scaffolded-initiative',
    theme: 'dark',
    scrollY: 0,
    afterLoad: async (page) => {
      // Expand first workstream to show the task tree.
      const handle = await page.$('button.node-toggle[aria-expanded="false"]');
      if (handle) {
        await handle.click();
        await page.waitForTimeout(900);
      }
    },
  },
  { name: 'initiative-pulse', widget: 'initiative-pulse', theme: 'dark', scrollY: 0 },
  { name: 'decisions',        widget: 'decisions',        theme: 'dark', scrollY: 0 },
  { name: 'morning-brief',    widget: 'morning-brief',    theme: 'dark', scrollY: 0 },
];

function ensureDir(path) { mkdirSync(path, { recursive: true }); }

function getMime(filePath) {
  return mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createStaticServer(baseDir, listenPort) {
  const server = createServer((req, res) => {
    const requestPath = req.url ? req.url.split('?')[0] : '/';
    const relative = requestPath === '/' ? '/index.html' : requestPath;
    const safe = normalize(relative).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(baseDir, safe);
    if (!filePath.startsWith(baseDir)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': getMime(filePath) });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolveSrv, rejectSrv) => {
    server.once('error', rejectSrv);
    server.listen(listenPort, '127.0.0.1', () => resolveSrv(server));
  });
}

function sipsResizeWidth(path, width) {
  const r = spawnSync('sips', ['--resampleWidth', String(width), path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sips resize failed: ${r.stderr || r.stdout}`);
}

function sipsCropHeight(path, width, height) {
  const r = spawnSync('sips', ['--cropToHeightWidth', String(height), String(width), path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sips crop failed: ${r.stderr || r.stdout}`);
}

async function captureShot(browser, baseUrl, shot) {
  const ctx = await browser.newContext({
    viewport: { width: SRC_W, height: MAX_SRC_H },
    deviceScaleFactor: SRC_DPR,
    colorScheme: shot.theme === 'dark' ? 'dark' : 'light',
  });
  const page = await ctx.newPage();
  const url = `${baseUrl}/widgets/${shot.widget}.html?demo=true&theme=${shot.theme}&embed=app-card-desktop`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Strip the widget's outer body padding/grid backdrop so the widget card uses
  // the full source width and sits on a clean dark canvas.
  await page.addStyleTag({ content: `
    html, body { margin: 0 !important; }
    body { padding: 16px 12px !important; background: #0b1020 !important; }
    body::before { display: none !important; }
    .container { max-width: 100% !important; }
  `});

  // Settle demo data/animations.
  await page.waitForTimeout(4000);

  if (typeof shot.afterLoad === 'function') {
    await shot.afterLoad(page);
  }

  // Determine clip height: cap at MAX_SRC_H so post-resize fits OUT_H_MAX.
  const scrollY = shot.scrollY || 0;
  const fullHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight));
  const remaining = fullHeight - scrollY;
  const clipHeight = Math.max(Math.floor((OUT_H_MIN * SRC_W) / OUT_W), Math.min(MAX_SRC_H, remaining));

  // Ensure DOM is tall enough for the requested clip.
  if (fullHeight < scrollY + clipHeight) {
    await page.addStyleTag({ content: `html, body { min-height: ${scrollY + clipHeight}px !important; }` });
  }

  const out = join(outDir, `${shot.name}.png`);
  await page.screenshot({
    path: out,
    clip: { x: 0, y: scrollY, width: SRC_W, height: clipHeight },
    omitBackground: false,
    fullPage: true,
  });
  await ctx.close();

  // Downscale captured PNG (currently SRC_W*SRC_DPR wide) to OUT_W wide.
  // sips preserves aspect ratio when --resampleWidth is used alone.
  sipsResizeWidth(out, OUT_W);

  return { out, srcLogicalHeight: clipHeight };
}

async function main() {
  ensureDir(outDir);
  const server = await createStaticServer(publicDir, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const shot of shots) {
      const { out, srcLogicalHeight } = await captureShot(browser, baseUrl, shot);
      const finalH = Math.round((srcLogicalHeight * OUT_W) / SRC_W);
      console.log(`✓ ${shot.name} (${OUT_W}x${finalH}) ← src ${SRC_W}x${srcLogicalHeight}@${SRC_DPR}x → ${out}`);
    }
  } finally {
    await browser.close();
    await new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
