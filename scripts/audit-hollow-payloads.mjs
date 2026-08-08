/**
 * Hollow-payload sweep.
 *
 * The screenshot audit (scripts/audit-widgets.mjs) cannot catch a widget that
 * renders plausible-but-invented values: there is no console error, no overflow,
 * no "undefined" in the DOM — just a confident card built entirely from
 * defaults. That is how initiative-pulse shipped "100 HEALTH / ACTIVE" for a
 * payload that carried nothing (#308).
 *
 * This drives every widget through the real host render path with payloads that
 * contain no usable data, and reports what each one puts on screen. A widget
 * passes if it admits it has nothing; it fails if it invents content.
 *
 * Usage: node scripts/audit-hollow-payloads.mjs [--json]
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const rootDir = resolve(process.cwd());
const publicDir = join(rootDir, 'public');
const outDir = join(rootDir, 'artifacts', 'widget-audit', 'hollow-payloads');
const port = 4451;
const asJson = process.argv.includes('--json');

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

// None of these carry usable data. Every one is non-null, so none of them can be
// caught by a bare `if (!payload)` guard — which is precisely the bug class.
const payloads = {
  empty_object: {},
  id_envelope: { ok: true, initiative_id: 'INI-402' },
  tool_envelope: { ok: true, _v2_tool: 'probe', _action: 'read' },
  empty_collections: {
    items: [], results: [], agents: [], decisions: [], tasks: [],
    workstreams: [], milestones: [], blockers: [], artifacts: [],
  },
};

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
    if (!filePath.startsWith(publicDir)) { response.writeHead(403); response.end(); return; }
    if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
    if (!existsSync(filePath)) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res(server));
  });
}

// Language a widget uses when it is being honest about having no data.
const HONEST_MARKERS = [
  'awaiting', 'no recent', 'nothing', 'no data', 'no results', 'no matches',
  'not found', 'unavailable', 'empty', 'no active', 'no pending', 'no decisions',
  'no agents', 'no tasks', 'connect', 'get started', 'browse', 'open orgx',
  'no artifacts', 'no items', 'none', 'waiting', 'no session', 'no plan',
  'no matching', 'no agent', 'standing by', 'listening', 'yet', 'first',
  'signals captured', 'not dispatched', 'was dispatched', 'preflight',
];

async function probe(page, widget, payloadName, payload) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // window.openai => the 'chatgpt' protocol, whose init path is
  // getData(openai.toolOutput) -> render(data). Same render chain the MCP
  // bridge drives, just synchronously observable.
  await page.addInitScript((data) => {
    window.openai = { toolOutput: data, theme: 'dark' };
  }, payload);
  await page.goto(`http://127.0.0.1:${port}/widgets/${widget}.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(1100);

  const seen = await page.evaluate(() => {
    // Only text the user can actually see. innerText alone picks up off-screen
    // carousel/marquee copy, which reads as fabricated state when it is really
    // decorative — scaffolded-initiative's launchpad strip is the example.
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const isShown = (el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (Number(style.opacity || 1) < 0.05) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return r.bottom > 0 && r.top < viewportH && r.right > 0 && r.left < viewportW;
    };
    const parts = [];
    const walk = (el) => {
      if (!isShown(el)) return;
      let ownText = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) ownText += ' ' + node.textContent;
      }
      if (ownText.trim()) parts.push(ownText.trim());
      for (const child of el.children) walk(child);
    };
    walk(document.body);
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    // Numbers a widget shows when it thinks it has metrics. Ignore bare 0,
    // which is a legitimate "none" reading rather than an invented value.
    const metrics = Array.from(text.matchAll(/\b(\d+)\s*(%|health|active|blocked|pending|items?|tasks?|agents?|decisions?)\b/gi))
      .map((m) => m[0])
      .filter((m) => !/^0\s/.test(m));
    const statusBadges = Array.from(
      new Set(
        Array.from(text.matchAll(/\b(ACTIVE|BLOCKED|COMPLETED|APPROVED|READY|IN REVIEW|HEALTHY)\b/g)).map((m) => m[1])
      )
    );
    return { text, metrics, statusBadges, length: text.length };
  });

  const lower = seen.text.toLowerCase();
  const admitsNothing = HONEST_MARKERS.some((marker) => lower.includes(marker));
  // Fabrication = presenting metrics or status while holding no data.
  const fabricates = (seen.metrics.length > 0 || seen.statusBadges.length > 0) && !admitsNothing;

  return {
    widget,
    payload: payloadName,
    verdict: fabricates ? 'FABRICATES' : admitsNothing ? 'honest' : 'inert',
    metrics: seen.metrics.slice(0, 6),
    statusBadges: seen.statusBadges,
    consoleErrors,
    pageErrors,
    excerpt: seen.text.slice(0, 200),
  };
}

const server = await createStaticServer();
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const results = [];

for (const widget of widgets) {
  for (const [payloadName, payload] of Object.entries(payloads)) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      const result = await probe(page, widget, payloadName, payload);
      results.push(result);
      if (result.verdict === 'FABRICATES') {
        await page.screenshot({
          path: join(outDir, `${widget}-${payloadName}.png`),
          fullPage: false,
        });
      }
    } catch (error) {
      results.push({
        widget, payload: payloadName, verdict: 'ERROR',
        excerpt: error instanceof Error ? error.message : String(error),
        metrics: [], statusBadges: [], consoleErrors: [], pageErrors: [],
      });
    }
    await page.close();
  }
}

await browser.close();
server.close();

writeFileSync(join(outDir, 'report.json'), JSON.stringify(results, null, 2));

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const bad = results.filter((r) => r.verdict === 'FABRICATES' || r.verdict === 'ERROR');
  const runtime = results.filter((r) => r.consoleErrors.length || r.pageErrors.length);
  for (const r of results) {
    const mark = r.verdict === 'FABRICATES' ? '  FABRICATES' : r.verdict === 'ERROR' ? '  ERROR     ' : r.verdict === 'inert' ? '  inert     ' : '  honest    ';
    console.log(`${mark} ${r.widget.padEnd(24)} ${r.payload.padEnd(18)} ${[...r.statusBadges, ...r.metrics].join(' ') || ''}`);
  }
  console.log(`\n${results.length} probes — ${bad.length} fabricating/errored, ${runtime.length} with runtime errors`);
  console.log(join(outDir, 'report.json'));
}

process.exitCode = results.some((r) => r.verdict === 'FABRICATES' || r.verdict === 'ERROR') ? 1 : 0;
