import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('public/widgets/search-results.html', 'utf8');
const runtime = readFileSync('public/widgets/shared/widget-runtime.js', 'utf8');
const payload = { query: 'launch', results: [{ id: 'i-1', title: 'Launch plan', type: 'initiative' }] };
let dom: JSDOM;
function boot(toolOutput: unknown, metadata?: unknown, callTool = vi.fn()) {
  dom = new JSDOM(html, { url: 'https://mcp.useorgx.com/widgets/search-results.html', runScripts: 'outside-only' });
  Object.assign(dom.window, { openai: { toolOutput, toolResponseMetadata: metadata, callTool, setWidgetHeight: vi.fn() }, fetch: vi.fn().mockResolvedValue({ ok: true }) });
  dom.window.eval(runtime);
  for (const script of dom.window.document.querySelectorAll('script:not([src])')) dom.window.eval(script.textContent!);
  return dom.window as unknown as Window & { loadMoreResults(): Promise<void> };
}
function update(toolOutput: unknown) {
  (dom.window as any).openai.toolOutput = toolOutput;
  dom.window.dispatchEvent(new dom.window.CustomEvent('openai:set_globals', { detail: { globals: { toolOutput } } }));
}
const text = () => dom.window.document.getElementById('content')!.textContent!;
describe('search delivery through the real ChatGPT widget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { dom?.window.close(); vi.useRealTimers(); });
  it.each([
    payload,
    { structuredContent: payload },
    { ok: true, summary: 'One match', data: payload },
    { structuredContent: { ok: true, data: payload } },
    { result: { structuredContent: payload } },
    { output: { ok: true, data: payload } },
    { content: [{ type: 'text', text: 'One match' }, { type: 'text', text: JSON.stringify(payload) }] },
    JSON.stringify(payload),
    { query: 'launch', results_by_type: { initiatives: payload.results } },
  ])('renders a completed response without the screenshot failure: %j', async (output) => {
    boot(output);
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch plan');
    expect(text()).not.toContain('Search unavailable');
  });
  it('does not settle on partial globals and recovers when results arrive', async () => {
    boot({ query: 'launch' });
    await vi.advanceTimersByTimeAsync(250);
    expect(dom.window.document.querySelector('.search-skeleton')).not.toBeNull();
    update({ ok: true, data: payload });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch plan');
    update({ query: 'launch' });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch plan');
  });
  it.each(['A summary without rows', undefined])('recovers from widget-only metadata when output is %j', async (output) => {
    boot(output, { 'orgx/searchPayload': payload });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch plan');
  });
  it('uses metadata when it arrives after partial host globals', async () => {
    boot({ query: 'launch' });
    (dom.window as any).openai.toolResponseMetadata = { 'orgx/searchPayload': payload };
    dom.window.dispatchEvent(new dom.window.CustomEvent('openai:set_globals', { detail: { globals: { toolResponseMetadata: (dom.window as any).openai.toolResponseMetadata } } }));
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch plan');
  });
  it('keeps the globals path working while the SDK handshake never completes', async () => {
    dom = new JSDOM(html, { url: 'https://mcp.useorgx.com/widgets/search-results.html', runScripts: 'outside-only' });
    Object.defineProperty(dom.window, 'parent', { value: {} });
    Object.assign(dom.window, {
      openai: { toolOutput: payload, setWidgetHeight: vi.fn() },
      McpApps: { App: class { connect() { return new Promise(() => {}); } } },
    });
    dom.window.eval(runtime);
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) dom.window.eval(script.textContent!);
    await vi.advanceTimersByTimeAsync(12_100);
    expect(text()).toContain('Launch plan');
    expect(text()).not.toContain('Search unavailable');
  });
  it('renders a result delivered only by the MCP Apps SDK while globals are incomplete', async () => {
    dom = new JSDOM(html, { url: 'https://mcp.useorgx.com/widgets/search-results.html', runScripts: 'outside-only' });
    let app: any;
    Object.defineProperty(dom.window, 'parent', { value: {} });
    Object.assign(dom.window, {
      openai: { toolOutput: { query: 'launch' }, setWidgetHeight: vi.fn() },
      McpApps: { App: class {
        constructor() { app = this; }
        connect() { return Promise.resolve(); }
        getHostContext() { return {}; }
      } },
    });
    dom.window.eval(runtime);
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) dom.window.eval(script.textContent!);
    app.ontoolresult({ structuredContent: { ok: true, data: payload } });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch plan');
  });
  it('can retry through ChatGPT while the SDK handshake is stalled', async () => {
    dom = new JSDOM(html, { url: 'https://mcp.useorgx.com/widgets/search-results.html', runScripts: 'outside-only' });
    const callTool = vi.fn().mockResolvedValue({ structuredContent: payload });
    Object.defineProperty(dom.window, 'parent', { value: {} });
    Object.assign(dom.window, {
      openai: { toolOutput: { query: 'launch' }, toolInput: { type: 'initiative', limit: 1 }, callTool, setWidgetHeight: vi.fn() },
      McpApps: { App: class { connect() { return new Promise(() => {}); } } },
    });
    dom.window.eval(runtime);
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) dom.window.eval(script.textContent!);
    await vi.advanceTimersByTimeAsync(12_100);
    await (dom.window as any).retrySearch();
    expect(callTool).toHaveBeenCalledWith('orgx_search', { type: 'initiative', limit: 1 });
    expect(text()).toContain('Launch plan');
  });
  it('removes markdown and UUID noise from display while keeping the original destination', async () => {
    const id = 'ff966794-695b-42eb-a5b7-111111111111';
    boot({ results: [{ id, title: '## **Execute task ' + id + '**', type: 'task' }] });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Execute linked task');
    expect(text()).not.toContain(id);
    expect(text()).not.toContain('**');
    expect(dom.window.document.querySelector('.result-card')?.getAttribute('href')).toContain(id);
    expect(dom.window.document.querySelector('.sr-hd ox-glyph[kind="question"]')).toBeNull();
    expect(text()).toContain('How search works');
  });
  it('starts a new filtered search with inclusive ISO bounds and resets pagination', async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { results: [{ title: 'Filtered task', type: 'task' }] } });
    boot({ results: [{ title: 'Old task', type: 'task' }] }, undefined, callTool);
    (dom.window as any).openai.toolInput = { query: 'launch', type: 'initiative', cursor: 'old-page', offset: 2, limit: 1 };
    await vi.advanceTimersByTimeAsync(250);
    const form = dom.window.document.querySelector('form')!;
    (form.elements.namedItem('type') as HTMLSelectElement).value = 'task';
    (form.elements.namedItem('from') as HTMLInputElement).value = '2026-10-02T09:00';
    (form.elements.namedItem('to') as HTMLInputElement).value = '2026-10-02T09:00';
    await (dom.window as any).applySearchFilters({ preventDefault() {}, currentTarget: form });
    expect(callTool).toHaveBeenCalledWith('orgx_search', { query: 'launch', type: 'task', limit: 1,
      created_from: new Date('2026-10-02T09:00').toISOString(), created_to: new Date('2026-10-02T09:00').toISOString() });
    expect(text()).toContain('Filtered task'); expect(text()).not.toContain('Old task');
  });
  it('clears dates while preserving the type required for browsing', async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: payload });
    boot(payload, undefined, callTool);
    (dom.window as any).openai.toolInput = { type: 'initiative', limit: 1, created_from: '2026-10-01T00:00Z' };
    await vi.advanceTimersByTimeAsync(250);
    (dom.window as any).clearSearchFilters();
    await vi.advanceTimersByTimeAsync(250);
    expect(callTool).toHaveBeenCalledWith('orgx_search', { type: 'initiative', limit: 1 });
  });
  it('preserves loaded results when the filtered request fails', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('transport unavailable'));
    boot(payload, undefined, callTool); (dom.window as any).openai.toolInput = { query: 'launch' };
    await vi.advanceTimersByTimeAsync(250);
    const form = dom.window.document.querySelector('form')!;
    await (dom.window as any).applySearchFilters({ preventDefault() {}, currentTarget: form });
    expect(text()).toContain('Launch plan'); expect(text()).toContain('previous results are still shown');
  });
  it('retries the original request after a delivery timeout and renders the recovered result', async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: payload });
    boot({ query: 'launch' }, undefined, callTool);
    (dom.window as any).openai.toolInput = { type: 'initiative', limit: 1 };
    await vi.advanceTimersByTimeAsync(12_100);
    expect(text()).toContain('Retry search');
    expect(text()).not.toContain('Couldn’t reach OrgX');
    await (dom.window as any).retrySearch();
    expect(callTool).toHaveBeenCalledWith('orgx_search', { type: 'initiative', limit: 1 });
    expect(text()).toContain('Launch plan');
  });
  it('reports a genuinely incomplete response once, then recovers', async () => {
    boot({ query: 'launch' }, { 'orgx/widgetDiagnostics': { endpoint: 'https://mcp.useorgx.com/telemetry/search-widget', grant: 'scoped-grant' } });
    await vi.advanceTimersByTimeAsync(12_100);
    expect(text()).toContain('Search unavailable');
    expect(text()).not.toContain('No results found');
    const fetchMock = (dom.window as any).fetch;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ grant: 'scoped-grant', code: 'incomplete_response', protocol: 'chatgpt' });
    expect(fetchMock.mock.calls[0][1].body).not.toContain('launch');
    update(payload);
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch plan');
  });
  it('shows a real failure rather than stale metadata or an empty success', async () => {
    boot({ structuredContent: { ok: false, error: { message: 'Search backend timed out' } } }, { 'orgx/searchPayload': payload });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Search backend timed out');
    expect(text()).not.toContain('Launch plan');
  });
  it('accepts empty search results and recommendation/history responses containing query', async () => {
    boot({ query: 'launch', results: [] });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('No results found');
    update({ query: 'launch', recommendations: [{ label: 'Approve launch', entityType: 'decision' }] });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Approve launch');
    update({ query: 'launch', decisions: [{ title: 'Launch approved' }] });
    await vi.advanceTimersByTimeAsync(250);
    expect(text()).toContain('Launch approved');
  });
  it('unwraps paginated responses and preserves rows on failure', async () => {
    const callTool = vi.fn().mockResolvedValueOnce({ ok: true, data: { results: [{ title: 'Second page', type: 'task' }] } }).mockRejectedValueOnce(new Error('offline'));
    const win = boot({ ...payload, pagination: { has_more: true }, next_call: { tool: 'orgx_search', args: { type: 'initiative', offset: 1 } } }, undefined, callTool);
    await vi.advanceTimersByTimeAsync(250);
    await win.loadMoreResults();
    expect(text()).toContain('Second page');
    await win.loadMoreResults();
    expect(text()).toContain('Second page');
    expect(text()).toContain('current results are preserved');
  });
});
