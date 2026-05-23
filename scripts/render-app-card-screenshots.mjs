import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const rootDir = resolve(process.cwd());
const publicDir = join(rootDir, 'public');
const outDir = join(publicDir, 'screenshots', 'app-card');
const port = 4324;

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

const shots = [
  {
    name: '01-scaffolded-initiative',
    widget: 'scaffolded-initiative',
    prompt: 'Scaffold an initiative for the Q3 auth refactor — owner-light, 6 weeks.',
    tool: 'orgx.scaffold_initiative',
    widgetHeight: 820,
  },
  {
    name: '02-initiative-pulse',
    widget: 'initiative-pulse',
    prompt: "How is the auth refactor initiative tracking this week?",
    tool: 'orgx.initiative_pulse',
    widgetHeight: 820,
  },
  {
    name: '03-decisions',
    widget: 'decisions',
    prompt: 'What decisions are waiting on me right now?',
    tool: 'orgx.list_decisions',
    widgetHeight: 820,
  },
  {
    name: '04-morning-brief',
    widget: 'morning-brief',
    prompt: "What's my OrgX morning brief?",
    tool: 'orgx.morning_brief',
    widgetHeight: 820,
  },
];

const viewport = { width: 1600, height: 1000 };

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
    if (!filePath.startsWith(baseDir)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': getMime(filePath) });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(listenPort, '127.0.0.1', () => resolveServer(server));
  });
}

async function captureShot(browser, baseUrl, shot) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  const qs = new URLSearchParams({
    widget: shot.widget,
    prompt: shot.prompt,
    tool: shot.tool,
    h: String(shot.widgetHeight),
  }).toString();
  const url = `${baseUrl}/screenshots/chat-frame.html?${qs}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Wait for iframe document + extra time for widget demo data to settle.
  await page.waitForTimeout(3500);
  const out = join(outDir, `${shot.name}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await ctx.close();
  return out;
}

async function main() {
  ensureDir(outDir);
  const server = await createStaticServer(publicDir, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const shot of shots) {
      const out = await captureShot(browser, baseUrl, shot);
      results.push(out);
      console.log(`✓ ${shot.name} → ${out}`);
    }
    console.log('\nRendered ChatGPT app-card screenshots:');
    results.forEach((p) => console.log(`  ${p}`));
  } finally {
    await browser.close();
    await new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
