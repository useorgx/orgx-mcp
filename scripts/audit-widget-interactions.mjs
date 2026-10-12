/** Explore widget controls and links through ChatGPT and a real MCP Apps SDK
 * handshake. All server calls are fixture-backed; no production mutations run.
 * Coverage and unresolved controls are written to artifacts/qa/widget-interactions.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(process.env.WIDGET_INTERACTION_ROOT || 'public');
const out = resolve('artifacts/qa/widget-interactions', process.env.WIDGET_INTERACTION_LABEL || 'current');
mkdirSync(out, { recursive: true });
const fixtures = JSON.parse(readFileSync('tests/fixtures/orgx-app-routes.json', 'utf8'));
const routes = fixtures.routes.map(route => ({ route, pattern: new RegExp('^' + route.split('/').map(p => p.startsWith('[[...') ? '(?:/.*)?' : p.startsWith('[...') ? '/.+' : p.startsWith('[') ? '/[^/]+' : p ? '/' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '').join('') + '$') }));
function checkLink(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return 'Non-HTTPS destination';
    if (u.origin !== 'https://useorgx.com') return null;
    const match = routes.find(x => x.pattern.test(u.pathname));
    if (!match) return 'No matching OrgX page';
    const bad = [...u.searchParams.keys()].filter(k => !(fixtures.query[match.route] || []).includes(k));
    return bad.length ? 'Unread query: ' + bad.join(', ') : null;
  } catch { return 'Invalid destination URL'; }
}
const surface = { contract_version: 'orgx-mcp-operations/1', profile: 'chatgpt', tools: ['orgx_panel_snapshot', 'orgx_widget_select_workspace', 'orgx_list_work_receipts', 'orgx_get_work_receipt', 'orgx_get_operation_status', 'orgx_widget_decide', 'orgx_widget_approve_artifact', 'orgx_widget_request_artifact_changes', 'orgx_widget_receipt_call', 'resume_agent_run', 'orgx_search', 'orgx_get_workspace_context', 'orgx_get_operator_brief', 'orgx_inspect', 'orgx_launch_initiative'], widget_tools: { panel_snapshot: 'orgx_panel_snapshot', workspace_select: 'orgx_widget_select_workspace', receipt_list: 'orgx_list_work_receipts', receipt_detail: 'orgx_get_work_receipt', operation_status: 'orgx_get_operation_status', decision_judgment: 'orgx_widget_decide', artifact_approve: 'orgx_widget_approve_artifact', artifact_request_changes: 'orgx_widget_request_artifact_changes', receipt_judgment: 'orgx_widget_receipt_call', resume_run: 'resume_agent_run' } };
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/host') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body style="margin:0"><iframe sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="MCP widget" src="' + u.searchParams.get('src').replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '" style="border:0;width:100%;height:1600px"></iframe></body></html>');
    return;
  }
  const p = resolve(root, '.' + u.pathname);
  if (!p.startsWith(root + '/') || !existsSync(p)) return res.writeHead(404).end();
  res.setHeader('Content-Type', mime[extname(p)] || 'application/octet-stream'); res.end(readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const manifest = JSON.parse(readFileSync('public/widgets/_manifest.json', 'utf8'));
const scenarios = Object.keys(manifest.widgets).filter(w => w !== 'index').map(widget => ({ widget, state: 'populated' })).concat([
  { widget: 'agent-status', state: 'stalled' }, { widget: 'agent-status', state: 'blocked' },
  { widget: 'artifact-review', state: 'ready' }, { widget: 'decisions', state: 'options' },
  { widget: 'scaffolded-initiative', state: 'agree' },
  ...['options', 'multiselect', 'agree', 'work', 'done', 'signed-out'].map(state => ({ widget: 'orgx-panel', state })),
]);
const selected = process.env.WIDGET_INTERACTION_WIDGETS?.split(',');
const selectedStates = process.env.WIDGET_INTERACTION_STATES?.split(',');
const cases = scenarios.filter(s => (!selected || selected.includes(s.widget)) && (!selectedStates || selectedStates.includes(s.state)));
const modes = process.env.WIDGET_INTERACTION_MODES?.split(',') || ['chatgpt', 'mcp'];
const widths = (process.env.WIDGET_INTERACTION_WIDTHS || '1100,375').split(',').map(Number);
const results = [];
const browser = await chromium.launch();
function initHost({ mode, theme, surface, panelFixture }) {
  window.__qa = { links: [], calls: [], messages: [], protocol: [] };
  // Normal sweeps model a returning user. The help control still exercises
  // the tour explicitly; an automatic first-use tour must not cover clicks.
  try { localStorage.setItem('orgx.panel.tour.v1', 'done'); } catch (_) { /* host may block storage */ }
  const qa = window.__qa;
  const reply = (name, args = {}) => {
    qa.calls.push({ name, args });
    if (panelFixture && name === 'orgx_panel_snapshot') {
      if (args.view === 'workspaces') return { structuredContent: { workspaces: panelFixture.workspaces } };
      if (args.view === 'in_progress') return { structuredContent: { work: panelFixture.work } };
      const snapshot = structuredClone(panelFixture.snapshot);
      if (args.focus?.id) {
        const item = snapshot.queue.find(x => x.id === args.focus.id);
        if (item) { snapshot.focus = { ...snapshot.focus, ...item, type: 'decision', question: item.title }; snapshot.selection = { status: 'selected', requested_id: item.id }; }
      }
      return { structuredContent: snapshot, _meta: panelFixture.meta };
    }
    if (panelFixture && name === 'orgx_list_work_receipts') return { structuredContent: panelFixture.receipts };
    if (name === 'orgx_get_operation_status') return { structuredContent: { kind: args.kind || 'decision', id: args.id, state: 'succeeded', outcome: 'Fixture completed', next_poll_after_ms: null } };
    if (name === 'orgx_widget_decide') return { structuredContent: { decision_id: args.decision_id, kind: args.kind || 'decision', action: args.action === 'approve' ? 'approved' : 'rejected', status: args.action === 'approve' ? 'approved' : 'rejected' } };
    if (name === 'orgx_widget_approve_artifact' || name === 'orgx_widget_request_artifact_changes') return { structuredContent: { ok: true, artifact: { id: args.artifact_id, status: name.includes('approve') ? 'approved' : 'changes_requested' } } };
    if (name === 'orgx_widget_receipt_call') return { structuredContent: { recorded: true, receipt_id: args.receipt_id, status: args.status } };
    if (name === 'orgx_search') return { structuredContent: { results: [{ id: 'task-audit', type: 'task', name: 'Audit continuation result', status: 'active' }], pagination: { has_more: false } } };
    return { isError: true, structuredContent: { ok: false, error: { code: 'qa_fixture_unavailable', message: 'This action needs a dedicated tool fixture.' } } };
  };
  window.open = url => { qa.links.push({ channel: 'browser', url }); return null; };
  if (mode === 'chatgpt') window.openai = { theme, toolOutput: panelFixture?.snapshot || null, toolResponseMetadata: { 'orgx/toolSurface': surface, ...panelFixture?.meta }, setWidgetHeight() {}, openExternal({ url }) { qa.links.push({ channel: 'chatgpt', url }); }, callTool: async (name, args) => reply(name, args), sendFollowUpMessage: async args => { qa.messages.push(args); }, requestDisplayMode: async args => { qa.messages.push(args); return args; }, updateModelContext: async args => { qa.messages.push(args); return { updateId: 'qa-context' }; } };
  window.addEventListener('message', event => {
    if (window !== window.top || !event.data || event.data.jsonrpc !== '2.0') return;
    const m = event.data;
    qa.protocol.push(m.method || 'response');
    let result = {};
    if (m.method === 'ui/initialize') result = { protocolVersion: '2026-01-26', hostInfo: { name: 'MCP Apps browser audit', version: '1' }, hostCapabilities: { openLinks: {}, serverTools: {}, message: {}, updateModelContext: {} }, hostContext: { theme, platform: 'desktop', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], containerDimensions: { width: innerWidth, maxHeight: 1600 } } };
    else if (m.method === 'ui/open-link') qa.links.push({ channel: 'mcp', url: m.params?.url });
    else if (m.method === 'tools/call') result = reply(m.params?.name, m.params?.arguments);
    else if (m.method === 'ui/message' || m.method === 'ui/update-model-context' || m.method === 'ui/request-display-mode') { qa.messages.push({ method: m.method, params: m.params }); if (m.method === 'ui/request-display-mode') result = { mode: m.params?.mode }; }
    if (m.id !== undefined) event.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
    if (m.method === 'ui/notifications/initialized' && panelFixture) event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: panelFixture.snapshot, _meta: { 'orgx/toolSurface': surface, ...panelFixture.meta }, content: [] } }, '*');
    if (m.method === 'ui/notifications/initialized') event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } }, '*');
  });
  document.addEventListener('click', event => {
    if (event.defaultPrevented) return;
    const a = event.composedPath().find(el => el.matches?.('a[href]'));
    if (a && /^https:/.test(a.href)) { qa.links.push({ channel: 'native', url: a.href }); event.preventDefault(); }
  });
}
try {
  // Use the panel's maintained fixtures as host results, rather than setting
  // gallery=true: that flag intentionally disables the host bridge and links.
  const fixturePage = await browser.newPage();
  await fixturePage.goto(origin + '/widgets/orgx-panel.html?gallery=true&state=needs-you');
  await fixturePage.waitForFunction(() => !!window.OrgXPanelGallery);
  const panelFixtures = {};
  for (const state of ['populated', 'options', 'multiselect', 'agree', 'work', 'done', 'signed-out']) {
    panelFixtures[state] = await fixturePage.evaluate(state => {
      const ui = { caps: {}, rulings: {}, receiptRows: {}, selections: {} }; let snapshot;
      const gallery = window.OrgXPanelGallery.boot({ ui, params: new URLSearchParams({ state: state === 'populated' ? 'needs-you' : state }), render() {}, accept(value) { snapshot = value; }, clock: value => value.toISOString() });
      gallery.run();
      return { snapshot: snapshot || { error: { code: 'authentication_required', message: 'Sign in to OrgX' } }, meta: { 'orgx/widgetApproval': { approval_tokens: ui.tokens || {} } }, work: gallery.work(), receipts: gallery.receipts('30d'), workspaces: gallery.workspaces() };
    }, state);
  }
  await fixturePage.close();
  for (const mode of modes) for (const width of widths) for (const { widget, state } of cases) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(initHost, { mode, theme: 'dark', surface, panelFixture: widget === 'orgx-panel' ? panelFixtures[state] : null });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(2000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const source = `/widgets/${widget}.html?demo=true&state=${state}&theme=dark`;
    const checks = []; const seen = new Set();
    let failure;
    try {
      await page.goto(mode === 'mcp' ? origin + '/host?src=' + encodeURIComponent(source) : origin + source);
      const frame = mode === 'mcp' ? page.frames().find(f => f.parentFrame()) : page.mainFrame();
      await frame.waitForFunction(() => !!window.OrgXWidgetRuntime);
      const protocol = await frame.evaluate(() => window.OrgXWidgetRuntime.detectProtocol());
      if (protocol !== (mode === 'mcp' ? 'mcp-apps-sdk' : 'chatgpt')) throw new Error('Unexpected host protocol: ' + protocol);
      if (mode === 'mcp') {
        if (widget !== 'orgx-panel') await frame.evaluate(() => window.OrgXWidgetRuntime.initWidget({ bridge: 'mcp-apps-sdk', render() {} }));
        await frame.waitForFunction(() => !!window.OrgXWidgetRuntime.getApp(), undefined, { timeout: 5000 });
      }
      await page.waitForTimeout(300);
      await frame.waitForFunction(() => document.body.innerText.trim().length > 20, undefined, { timeout: 5000 });
      const skip = frame.locator('[data-tour="skip"]'); if (await skip.isVisible()) await skip.click();
      for (let n = 0; n < 90; n++) {
        const controls = await frame.evaluate(() => {
          const found = [];
          const walk = root => {
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
              if (!el.matches('button,a[href],select,input:not([type=hidden]),textarea,summary')) continue;
              if (el.matches(':disabled,[aria-disabled=true]') || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none') continue;
              if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true') continue;
              const data = [...el.attributes].filter(a => a.name.startsWith('data-') && !a.name.startsWith('data-qa-')).map(a => [a.name, a.value]);
              const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 120);
              const key = JSON.stringify([el.tagName, el.id, label, el.getAttribute('href'), data]);
              el.setAttribute('data-qa-key', key);
              const link = el.matches('a[href^="https:"]') || el.hasAttribute('data-url') || el.hasAttribute('data-oxhref');
              const mutation = /approve|reject|submit|resume|launch|sendback|receipt-call/.test(el.getAttribute('data-action') || '') || /^(approve|launch|resume|send back|request changes)/i.test(label);
              const priority = link ? 70 : mutation ? 90 : el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? 10 : el.hasAttribute('aria-expanded') || el.tagName === 'SUMMARY' ? 20 : 40;
              const agent = el.getRootNode().host?.tagName === 'OX-AGENT-CARD';
              const guide = el.getAttribute('data-action') === 'tour' || el.hasAttribute('data-tour');
              const menu = el.closest('[role="menu"],#st-menu,#pn-ws-menu,[role="dialog"]');
              found.push({ key, label, id: el.id, placeholder: el.getAttribute('placeholder'), tag: el.tagName, href: el.getAttribute('href'), url: el.getAttribute('data-url') || el.getAttribute('data-oxhref'), link, mutation, priority: guide ? 200 : menu ? 5 : priority, agent });
            }
          }; walk(document); return found.sort((a,b) => a.priority - b.priority);
        });
        const target = controls.find(c => !seen.has(c.key));
        if (!target) break;
        seen.add(target.key);
        const role = { BUTTON: 'button', A: 'link', SELECT: 'combobox' }[target.tag];
        const name = new RegExp('^' + target.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const node = (target.id ? frame.locator('[id=' + JSON.stringify(target.id) + ']')
          : target.placeholder ? frame.getByPlaceholder(target.placeholder, { exact: true })
          : role ? frame.getByRole(role, { name })
          : frame.locator('[data-qa-key=' + JSON.stringify(target.key) + ']')).first();
        if (!await node.count()) continue;
        const before = await frame.evaluate(() => ({ text: document.body.innerText, flags: [...document.querySelectorAll('[aria-expanded],[aria-selected],[aria-pressed]')].map(el => [el.id, el.getAttribute('aria-expanded'), el.getAttribute('aria-selected'), el.getAttribute('aria-pressed')]), qa: { links: window.__qa.links.length, calls: window.__qa.calls.length, messages: window.__qa.messages.length } }));
        const parentBefore = await page.evaluate(() => ({ links: window.__qa.links.length, calls: window.__qa.calls.length, messages: window.__qa.messages.length }));
        let issue;
        let issueDetails;
        try {
          if (target.tag === 'INPUT' || target.tag === 'TEXTAREA') {
            const type = await node.getAttribute('type');
            if (type === 'checkbox' || type === 'radio') await node.check();
            else await node.fill('Widget click verification');
          } else if (target.tag === 'SELECT') {
            const value = await node.locator('option').evaluateAll(opts => opts.find(o => !o.disabled && !o.selected)?.value);
            if (value !== undefined) await node.selectOption(value);
          } else {
            try { await node.click({ timeout: 2000 }); }
            catch (e) {
              if (!e.message.includes('intercepts pointer events')) throw e;
              // Close the currently open menu before following a control
              // underneath it, as a person would. Never force a covered click.
              await page.keyboard.press('Escape');
              await node.click();
            }
          }
        } catch (e) { issue = e.message.split('\n')[0]; issueDetails = e.message; }
        await page.waitForTimeout(80);
        const after = await frame.evaluate(() => ({ text: document.body.innerText, flags: [...document.querySelectorAll('[aria-expanded],[aria-selected],[aria-pressed]')].map(el => [el.id, el.getAttribute('aria-expanded'), el.getAttribute('aria-selected'), el.getAttribute('aria-pressed')]), qa: window.__qa }));
        const parentAfter = await page.evaluate(() => window.__qa);
        const opens = after.qa.links.slice(before.qa.links).concat(mode === 'mcp' ? parentAfter.links.slice(parentBefore.links) : []);
        const calls = after.qa.calls.slice(before.qa.calls).concat(mode === 'mcp' ? parentAfter.calls.slice(parentBefore.calls) : []);
        const messages = after.qa.messages.slice(before.qa.messages).concat(mode === 'mcp' ? parentAfter.messages.slice(parentBefore.messages) : []);
        for (const opened of opens) issue ||= checkLink(opened.url);
        if (target.link && (target.href || target.url)) issue ||= checkLink(target.href || target.url);
        if (opens.length > 1) issue ||= 'Duplicate navigation: ' + opens.length;
        if (target.link && !issue && opens.length !== 1) issue = 'Link click did not open a destination';
        const changed = before.text !== after.text || JSON.stringify(before.flags) !== JSON.stringify(after.flags) || opens.length || calls.length || messages.length || target.tag === 'INPUT' || target.tag === 'TEXTAREA';
        checks.push({ label: target.label, tag: target.tag, href: target.href || target.url, opens, calls: calls.map(c => ({ name: c.name })), messages: messages.length, changed: !!changed, issue, issueDetails, fixtureRefusal: calls.some(c => !['orgx_panel_snapshot','orgx_list_work_receipts','orgx_get_operation_status','orgx_widget_decide','orgx_widget_approve_artifact','orgx_widget_request_artifact_changes','orgx_widget_receipt_call','orgx_search'].includes(c.name)) });
        // Dismiss an agent popover before the next card; other disclosures stay
        // open so their newly revealed controls enter the next frontier.
        if (target.agent) await page.keyboard.press('Escape');
      }
      await page.screenshot({ path: resolve(out, `${widget}-${state}-${mode}-${width}.png`), fullPage: true });
    } catch(e) { failure = e.message.split('\n')[0]; }
    results.push({ widget, state, mode, width, checks, errors, failure });
    writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`${widget}/${state} ${mode} ${width}: ${checks.length} controls, ${checks.filter(c => c.issue).length} click failures${failure ? ', ' + failure : ''}`);
    await context.close();
  }
} finally { await browser.close(); await new Promise(r => server.close(r)); }
const failures = results.flatMap(r => r.checks.filter(c => c.issue).map(c => ({ widget: r.widget, state: r.state, mode: r.mode, width: r.width, ...c })));
const unresolved = results.flatMap(r => r.checks.filter(c => !c.changed || c.fixtureRefusal).map(c => ({ widget: r.widget, state: r.state, mode: r.mode, width: r.width, ...c })));
const summary = { cases: results.length, widgets: new Set(results.map(r => r.widget)).size, controls: results.reduce((n,r) => n + r.checks.length, 0), links: results.reduce((n,r) => n + r.checks.reduce((sum,c) => sum + c.opens.length,0),0), failures, unresolved, pageErrors: results.filter(r => r.failure || r.errors.length).map(({ widget,state,mode,width,failure,errors }) => ({ widget,state,mode,width,failure,errors })) };
writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ cases: summary.cases, widgets: summary.widgets, controls: summary.controls, links: summary.links, failures: failures.length, unresolved: unresolved.length, pageErrors: summary.pageErrors.length }));
if (failures.length || summary.pageErrors.length) process.exitCode = 1;
