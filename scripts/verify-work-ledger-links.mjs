/** Browser regression for real Work Ledger links and the two host contracts.
 * Uses local fixtures only; external requests and tool calls never reach OrgX.
 *   CHROMIUM_PATH=/usr/bin/chromium node scripts/verify-work-ledger-links.mjs
 *   WORK_LEDGER_LINK_BASELINE=1 WORK_LEDGER_LINK_BASELINE_REF=<before-fix-sha> ...
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('public');
const output = resolve('artifacts/qa/work-ledger-links');
mkdirSync(output, { recursive: true });
const workspace = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const receiptPath = '/work-ledger/receipts/trail%3Aopaque%2Fid';
const decision = 'https://useorgx.com/decisions/33333333-3333-4333-8333-333333333333';
const pr = 'https://github.com/acme/checkout/pull/413';
const run = 'https://useorgx.com/runs/44444444-4444-4444-8444-444444444444';
const receipt = 'https://useorgx.com' + receiptPath + '?center=' + workspace;
const explicitReceipt = 'https://useorgx.com/work-ledger/receipts/existing%3Aopaque?center=' + otherWorkspace;
const ledger = 'https://useorgx.com/work-ledger?center=' + workspace + '&range=7d';
const queue = 'https://useorgx.com/decisions?status=pending&center=' + workspace;
const event = (id, kind, title, url, proofState) => ({
  id, kind, title, url, proofState, sourceLabel: 'Browser fixture',
  status: 'recorded', occurredAt: '2026-11-16T09:00:00Z',
});
const payload = { chronicle: {
  workspaceId: workspace, workspaceName: 'Widget navigation fixture', period: 'week',
  generatedAt: '2026-11-16T09:00:00Z', headline: 'Recorded work with its original links.',
  attentionState: 'needs_you', metrics: { pendingDecisions: 1, receiptsProduced: 2 },
  reportingNarrative: { nextAction: 'Review the pending decision.' },
  continuity: { clients: [], events: [
    event('receipt:opaque', 'receipt', 'Opaque receipt', receiptPath, 'recorded'),
    event('decision:fixture', 'decision', 'Review the release', decision, 'needs_review'),
    event('pull_request:fixture', 'pull_request', 'Release pull request', pr, 'verified'),
    event('run:fixture', 'run', 'Release run', run, 'failed'),
    event('artifact:unsafe', 'artifact', 'Unsafe destination', 'javascript:window.__unsafeLinkExecuted=1', 'recorded'),
    event('receipt:explicit', 'receipt', 'Explicit receipt workspace', explicitReceipt, 'recorded'),
  ] },
} };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const baseline = process.env.WORK_LEDGER_LINK_BASELINE === '1';
const baselineRef = process.env.WORK_LEDGER_LINK_BASELINE_REF || 'HEAD';
const baselineHtml = baseline ? execFileSync('git', ['show', baselineRef + ':public/widgets/work-ledger.html'], { encoding: 'utf8' }) : null;
const baselineRuntime = baseline ? Object.fromEntries(['source', 'inline'].map(kind => [kind,
  execFileSync('git', ['show', baselineRef + ':public/widgets/' + (kind === 'inline' ? 'inline/' : '') + 'shared/widget-runtime.js'], { encoding: 'utf8' }),
])) : null;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/embed') {
    response.setHeader('content-type', 'text/html');
    response.end('<iframe sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" style="width:100%;height:2000px;border:0" src="/widgets/work-ledger.html"></iframe>');
    return;
  }
  const path = resolve(root, '.' + url.pathname);
  if (!path.startsWith(root + sep) || !existsSync(path)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', mime[extname(path)] || 'application/octet-stream');
  response.end(baselineHtml && url.pathname === '/widgets/work-ledger.html' ? baselineHtml : readFileSync(path));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
try {
  for (const assets of ['source', 'inline']) for (const mode of ['standalone', 'chatgpt', 'sdk', 'pending-sdk-chatgpt']) {
    const item = { assets, mode, checks: [], errors: [] };
    const context = await browser.newContext({ viewport: { width: 1000, height: 1800 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ payload, mode }) => {
      window.__ledgerAudit = [];
      window.__ledgerHostFailures = [];
      window.__ledgerToolCalls = [];
      window.__ledgerRejectLinks = false;
      window.__unsafeLinkExecuted = 0;
      window.open = url => { window.__ledgerAudit.push({ channel: 'browser', url: String(url) }); return null; };
      window.__ledgerSdk = {
        App: class {
          async connect() {
            if (mode === 'pending-sdk-chatgpt') await new Promise(() => {});
            this.ontoolresult?.({ structuredContent: payload });
          }
          getHostContext() { return {}; }
          getHostCapabilities() { return {}; }
          async openLink(args) {
            if (!args || typeof args.url !== 'string' || 'href' in args) throw new Error('MCP Apps openLink requires {url}');
            window.__ledgerAudit.push({ channel: 'sdk', url: args.url });
            return window.__ledgerRejectLinks ? { isError: true } : {};
          }
          async requestDisplayMode(args) { return args; }
          async callServerTool(args) { window.__ledgerToolCalls.push(args); throw new Error('Tool calls are disabled in this browser fixture'); }
          close() {}
        },
        applyDocumentTheme() {}, applyHostStyleVariables() {}, applyHostFonts() {},
      };
      if (mode === 'chatgpt' || mode === 'pending-sdk-chatgpt') window.openai = {
        toolOutput: payload,
        openExternal(args) {
          if (!args || typeof args.href !== 'string' || 'url' in args) {
            window.__ledgerHostFailures.push('ChatGPT openExternal requires {href}');
            throw new Error('ChatGPT openExternal requires {href}');
          }
          window.__ledgerAudit.push({ channel: 'chatgpt', url: args.href });
          if (window.__ledgerRejectLinks) return Promise.reject(new Error('Fixture host refused navigation'));
        },
        setWidgetHeight() {}, async requestDisplayMode(args) { return args; },
        async callTool(...args) { window.__ledgerToolCalls.push(args); throw new Error('Tool calls are disabled in this browser fixture'); },
      };
      window.addEventListener('click', event => {
        if (event.defaultPrevented) return;
        const anchor = event.composedPath().find(node => node.matches?.('a[href]'));
        if (anchor && /^https:/.test(anchor.href)) {
          window.__ledgerAudit.push({ channel: 'native', url: anchor.href });
          event.preventDefault();
        }
      });
    }, { payload, mode });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.route('**/widgets/shared/**', route => {
      const path = new URL(route.request().url()).pathname.slice('/widgets/'.length);
      if (baselineRuntime && path === 'shared/widget-runtime.js') {
        return route.fulfill({ contentType: 'application/javascript', body: baselineRuntime[assets] });
      }
      if (assets === 'source') return route.fallback();
      const file = resolve(root, 'widgets/inline', path);
      return existsSync(file) ? route.fulfill({ contentType: mime[extname(file)] || 'application/octet-stream', body: readFileSync(file) }) : route.fallback();
    });
    await context.route('**/mcp-apps-sdk.umd.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.McpApps = window.__ledgerSdk;' }));
    const page = await context.newPage();
    page.on('pageerror', error => item.errors.push(error.message));
    try {
      await page.goto(origin + (mode === 'standalone' ? '/widgets/work-ledger.html' : '/embed'));
      const frame = mode === 'standalone' ? page.mainFrame() : page.frames().find(frame => frame.parentFrame());
      await frame.waitForFunction(() => !!window.OrgXWidgetRuntime);
      if (mode === 'standalone') await frame.evaluate(payload => window.render(payload), payload);
      await frame.locator('.wl-attn').waitFor();
      if (mode === 'pending-sdk-chatgpt') {
        await frame.evaluate(() => window.OrgXWidgetRuntime.initWidget({ bridge: 'mcp-apps-sdk', render() {} }));
        await frame.waitForFunction(() => document.documentElement.dataset.protocol === 'mcp-apps-sdk');
      }
      const channel = mode === 'standalone' ? null : mode === 'sdk' ? 'sdk' : 'chatgpt';
      async function check(label, locator, expected, expectedChannel = channel) {
        await frame.evaluate(() => { window.__ledgerAudit = []; window.__ledgerHostFailures = []; });
        let failure;
        try {
          await locator.click({ timeout: 3000 });
          await page.waitForTimeout(30);
          const observed = await frame.evaluate(() => ({ opens: window.__ledgerAudit, invalidHostCalls: window.__ledgerHostFailures }));
          assert.equal(observed.invalidHostCalls.length, 0, observed.invalidHostCalls.join('; '));
          assert.equal(observed.opens.length, 1, 'Each click must open exactly once');
          assert.equal(observed.opens[0].url, expected, 'Destination must retain the receipt, workspace and window');
          if (expectedChannel) assert.equal(observed.opens[0].channel, expectedChannel, 'The host must receive the documented link request');
          item.checks.push({ label, expected, ...observed });
          return;
        } catch (error) { failure = error.message; }
        item.checks.push({ label, expected, failure, ...await frame.evaluate(() => ({ opens: window.__ledgerAudit, invalidHostCalls: window.__ledgerHostFailures })) });
      }
      await check('summary receipt row', frame.locator('.wl-entry[label="Opaque receipt"]').locator('a'), receipt);
      await check('summary decision row', frame.locator('.wl-entry[label="Review the release"]').locator('a'), decision);
      await check('summary pull request row', frame.locator('.wl-entry[label="Release pull request"]').locator('a'), pr);
      await check('summary decisions attention', frame.locator('.wl-attn'), queue);
      await check('summary next action', frame.locator('.wl-next button'), queue);
      await check('summary footer', frame.locator('ox-footer').locator('button[part="action"]'), ledger);
      await frame.locator('.wl-explore').click();
      await frame.locator('.kx-chip[data-filter="all"]').click();
      for (const [label, expected] of [['Opaque receipt', receipt], ['Review the release', decision], ['Release pull request', pr], ['Release run', run], ['Explicit receipt workspace', explicitReceipt]]) {
        await check('explorer ' + label, frame.locator('.kx-entry[label="' + label + '"]').locator('a'), expected);
      }
      assert.equal(await frame.locator('.kx-entry[label="Unsafe destination"]').locator('a').count(), 0, 'Unsafe payload URL must remain a plain row');
      await check('explorer footer', frame.locator('ox-footer').locator('button[part="action"]'), ledger);
      if (mode !== 'standalone' && !baseline) {
        await frame.evaluate(() => { window.__ledgerRejectLinks = true; window.__ledgerAudit = []; });
        await frame.locator('ox-footer').locator('button[part="action"]').click();
        const recovery = frame.locator('#ox-link-recovery a');
        await recovery.waitFor({ timeout: 6000 });
        assert.equal(await recovery.getAttribute('href'), ledger);
        assert.equal(await recovery.getAttribute('target'), '_blank');
        assert.equal(await recovery.getAttribute('data-ox-link'), null, 'Recovery must not repeat the failed host request');
        await check('host refusal recovery anchor', recovery, ledger, 'native');
      }
      assert.equal(await frame.evaluate(() => window.__unsafeLinkExecuted), 0);
      assert.deepEqual(await frame.evaluate(() => window.__ledgerToolCalls), []);
    } catch (error) {
      item.errors.push(error.message);
      await page.screenshot({ path: resolve(output, `${assets}-${mode}-failure.png`), fullPage: true });
    } finally {
      results.push(item);
      console.log(`${assets} ${mode}: ${item.checks.length} navigation checks, ${item.checks.filter(check => check.failure).length} failures, ${item.errors.length} errors`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
const summary = {
  baseline, baselineRef: baseline ? baselineRef : null, cases: results.length, checks: results.reduce((total, item) => total + item.checks.length, 0),
  failures: results.flatMap(item => item.checks.filter(check => check.failure).map(check => ({ assets: item.assets, mode: item.mode, ...check }))),
  errors: results.filter(item => item.errors.length).map(({ assets, mode, errors }) => ({ assets, mode, errors })),
};
const label = (process.env.WORK_LEDGER_LINK_LABEL || (baseline ? 'baseline' : 'verified')).replace(/[^a-zA-Z0-9_-]/g, '_');
writeFileSync(resolve(output, label + '.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, failures: summary.failures.length, examples: summary.failures.slice(0, 3) }, null, 2));
if (summary.failures.length || summary.errors.length) process.exitCode = 1;
