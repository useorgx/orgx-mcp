/** Click rendered widget links in Chromium, including links inside shadow DOM.
 * Host adapters are simulated; no tool mutations or authenticated OrgX writes
 * run. Destinations are checked against the app-generated route fixture.
 *   CHROMIUM_PATH=/usr/bin/chromium node scripts/audit-widget-links.mjs
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('public');
const fixture = JSON.parse(readFileSync('tests/fixtures/orgx-app-routes.json', 'utf8'));
const routes = fixture.routes.map(route => ({ route, pattern: new RegExp('^' + route
  .split('/').map(part => part.startsWith('[[...') ? '(?:/.*)?' : part.startsWith('[...') ? '/.+'
    : part.startsWith('[') ? '/[^/]+' : part ? '/' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '').join('') + '$') }))
  .sort((a, b) => (a.route.match(/\[/g)?.length || 0) - (b.route.match(/\[/g)?.length || 0));
function destinationProblem(value) {
  const url = new URL(value);
  if (url.origin !== 'https://useorgx.com') return url.protocol === 'https:' ? null : 'Not HTTPS';
  const match = routes.find(item => item.pattern.test(url.pathname));
  if (!match) return 'No OrgX page';
  for (const key of url.searchParams.keys()) {
    if (!(fixture.query[match.route] || []).includes(key)) return `Unread query: ${key}`;
  }
  return null;
}
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/embed') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<iframe sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" style="width:100%;height:1600px;border:0" src="' + url.searchParams.get('src').replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"></iframe>');
    return;
  }
  const path = resolve(root, '.' + url.pathname);
  if (!path.startsWith(root + sep) || !existsSync(path)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const widgets = readdirSync(resolve(root, 'widgets')).filter(name => name.endsWith('.html') && name !== 'index.html' &&
  (!process.env.WIDGET_LINK_WIDGETS || process.env.WIDGET_LINK_WIDGETS.split(',').includes(name.replace('.html', ''))));
const modes = process.env.WIDGET_LINK_MODES?.split(',') || ['standalone', 'chatgpt', 'sdk', 'pending-sdk-chatgpt'];
const states = process.env.WIDGET_LINK_STATES?.split(',') || ['populated', 'blocked', 'long'];
const results = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const mode of modes) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1600 } });
    await context.addInitScript(({ mode }) => {
      // This matrix checks returning-user links. The panel starts a first-use
      // tour on a delayed timer; it must not cover a link after discovery.
      try { localStorage.setItem('orgx.panel.tour.v1', 'done'); } catch (_) { /* host may block storage */ }
      window.__linkAudit = [];
      window.open = url => { window.__linkAudit.push({ channel: 'browser', url }); return null; };
      const snapshot = {
        schema: 'orgx.panel.v1', generated_at: new Date().toISOString(), state: 'ok',
        workspace: { id: 'ws-1', name: 'Link audit' },
        attention: { pending: 1, oldest_at: null, blocking: false },
        queue: [{ id: 'd-1', version: 'v1', title: 'Review release', urgency: 'high', url: 'https://useorgx.com/decisions/d-1' }],
        focus: { type: 'decision', id: 'd-1', version: 'v1', question: 'Review release', urgency: 'high',
          evidence: [], evidence_total: 0, blocked: false, recommendation: { status: 'unavailable' }, url: 'https://useorgx.com/decisions/d-1' },
        selection: { requested_id: null, status: 'default' }, proof: { last_accepted: null, completed_unaccepted: 0 }, degraded: [],
      };
      const delivered = location.pathname.endsWith('/orgx-panel.html') ? snapshot :
        location.pathname.endsWith('/plan-session-live.html') ? {
          id: 'plan-1', initiative_id: 'initiative-plan', feature_name: 'Widget link audit', status: 'active',
          current_plan: '# Widget link audit\n\n## Outcome\nOpen the correct OrgX record.\n\n## Workstreams\nCheck all widget links.',
        } : null;
      window.__auditSdk = { App: class {
        async connect() {
          if (mode === 'pending-sdk-chatgpt') await new Promise(() => {});
          if (delivered) this.ontoolresult?.({ structuredContent: delivered });
        }
        getHostContext() { return {}; }
        getHostCapabilities() { return {}; }
        async callServerTool() { return { structuredContent: snapshot }; }
        async updateModelContext() { return {}; }
        async openLink({ url }) { window.__linkAudit.push({ channel: 'sdk', url }); return {}; }
        close() {}
      }, applyDocumentTheme() {}, applyHostStyleVariables() {}, applyHostFonts() {} };
      if (mode === 'chatgpt' || mode === 'pending-sdk-chatgpt') window.openai = {
        toolOutput: delivered,
        openExternal({ url }) { window.__linkAudit.push({ channel: 'chatgpt', url }); },
        setWidgetHeight() {}, async callTool() { return { structuredContent: snapshot }; },
      };
      window.addEventListener('click', event => {
        if (event.defaultPrevented) return;
        const anchor = event.composedPath().find(node => node.matches?.('a[href]'));
        if (anchor && /^https:/.test(anchor.href)) {
          window.__linkAudit.push({ channel: 'native', url: anchor.href });
          event.preventDefault(); // Record native navigation without leaving this fixture.
        }
      });
    }, { mode });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (process.env.WIDGET_LINK_ASSETS === 'inline') await context.route('**/widgets/shared/**', route => {
      const path = resolve(root, 'widgets/inline', new URL(route.request().url()).pathname.slice('/widgets/'.length));
      return existsSync(path) ? route.fulfill({ contentType: mime[extname(path)] || 'application/octet-stream', body: readFileSync(path) }) : route.fallback();
    });
    await context.route('**/mcp-apps-sdk.umd.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.McpApps = window.__auditSdk;' }));
    for (const widget of widgets) for (const state of states) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const source = `/widgets/${widget}?demo=true&state=${state}&theme=dark`;
      await page.goto(mode === 'standalone' ? origin + source : origin + '/embed?src=' + encodeURIComponent(source));
      const frame = mode === 'standalone' ? page.mainFrame() : page.frames().find(frame => frame.parentFrame());
      await frame.waitForFunction(() => !!window.OrgXWidgetRuntime);
      if (mode === 'sdk') {
        await frame.evaluate(() => window.OrgXWidgetRuntime.initWidget({ render() {} }));
        await frame.waitForFunction(() => !!window.OrgXWidgetRuntime.getApp());
      }
      await page.waitForTimeout(600);
      const skipTour = frame.locator('[data-tour="skip"]');
      if (await skipTour.isVisible()) await skipTour.click();
      const targets = await frame.evaluate(() => {
        const found = [];
        function walk(root) {
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) walk(element.shadowRoot);
            const text = element.textContent?.trim() || '';
            if ((element.matches('a[href]') && /^https:/.test(element.href)) || element.matches('button[data-url],button[data-oxhref],button[data-open-live-view]') ||
                (element.matches('button') && /^(?:Open\b|Review in OrgX|View in OrgX)/i.test(text))) {
              if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
              element.setAttribute('data-audit-link', String(found.length));
              found.push({ label: text.slice(0, 100), href: element.getAttribute('href'), index: found.length });
            }
          }
        }
        walk(document);
        return found;
      });
      const clicks = [];
      for (const target of targets) {
        await frame.evaluate(() => { window.__linkAudit = []; });
        let failure;
        try { await frame.locator(`[data-audit-link="${target.index}"]`).click({ timeout: 1500 }); }
        catch (error) { failure = error.message.split('\n')[0]; }
        await page.waitForTimeout(25);
        const opens = await frame.evaluate(() => window.__linkAudit);
        if (!failure && opens.length !== 1) failure = `Expected one open, received ${opens.length}`;
        for (const opened of opens) failure ||= destinationProblem(opened.url);
        clicks.push({ ...target, opens, failure });
      }
      // Open one agent popover at a time so it cannot cover another card's
      // trigger. Click its actual shadow-DOM anchor, then dismiss it.
      for (const card of await frame.locator('ox-agent-card').all()) {
        const trigger = card.locator('button').first();
        if (!await trigger.isVisible()) continue;
        const href = await card.getAttribute('href');
        if (!href) continue;
        await frame.evaluate(() => { window.__linkAudit = []; });
        let failure;
        try {
          await trigger.click({ timeout: 1500 });
          await card.locator('a[href]').click({ timeout: 1500 });
        } catch (error) { failure = error.message.split('\n')[0]; }
        await page.waitForTimeout(25);
        const opens = await frame.evaluate(() => window.__linkAudit);
        if (!failure && opens.length !== 1) failure = `Expected one open, received ${opens.length}`;
        for (const opened of opens) failure ||= destinationProblem(opened.url);
        clicks.push({ label: 'Agent desk', href, opens, failure });
        await page.keyboard.press('Escape');
      }
      const visibleText = await frame.locator('body').innerText();
      results.push({ widget, mode, state, clicks, errors, visibleText });
      console.log(`${mode} ${widget} ${state}: ${clicks.length} clicks, ${clicks.filter(click => click.failure).length} failures`);
      await page.close();
    }
    await context.close();
  }
} finally { await browser.close(); await new Promise(done => server.close(done)); }
const out = resolve('artifacts/qa/widget-links');
mkdirSync(out, { recursive: true });
const label = (process.env.WIDGET_LINK_AUDIT_LABEL || 'browser-audit').replace(/[^a-zA-Z0-9_-]/g, '_');
writeFileSync(resolve(out, label + '.json'), JSON.stringify(results, null, 2) + '\n');
const failures = results.flatMap(item => item.clicks.filter(click => click.failure).map(click => ({ widget: item.widget, mode: item.mode, state: item.state, ...click })));
console.log(JSON.stringify({ cases: results.length, widgets: widgets.length, clicks: results.reduce((sum, item) => sum + item.clicks.length, 0),
  failures: failures.length, examples: failures.slice(0, 20), errors: results.filter(item => item.errors.length).map(({ widget, mode, state, errors }) => ({ widget, mode, state, errors })) }, null, 2));
if (failures.length || results.some(item => item.errors.length)) process.exitCode = 1;
