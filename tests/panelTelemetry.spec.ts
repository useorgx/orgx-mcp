// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountPanel, snapshot } from './fixtures/panel';

/**
 * The panel's UX telemetry: named events with labels and numbers, batched
 * to the worker with the grant the tool result carried, and never a word of
 * what the decisions say.
 */
type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));
const doc = (m: Mounted) => m.dom.window.document;
const click = (m: Mounted, selector: string) => (doc(m).querySelector(selector) as HTMLElement).click();

const TELEMETRY = { endpoint: 'https://mcp.useorgx.com/telemetry/widget', grant: 'signed.grant' };
const meta = (extra: Record<string, unknown> = {}) => ({ 'orgx/widgetTelemetry': TELEMETRY, 'orgx/widgetApproval': { approval_tokens: { [snapshot().focus.id]: 'tok-1' } }, ...extra });

type Posted = { url: string; init: RequestInit & { keepalive?: boolean }; body: { grant: string; protocol: string; events: { name: string; props: Record<string, unknown> }[] } };
async function open(hostContext: Record<string, unknown> = {}, resultMeta: Record<string, unknown> | null = meta()) {
  const posted: Posted[] = [];
  const m = await mountPanel(hostContext, {}, (win) => {
    (win as unknown as { requestIdleCallback: (fn: () => void) => number }).requestIdleCallback = (fn) => { fn(); return 1; };
    (win as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string, init: RequestInit) => {
      posted.push({ url, init: init as Posted['init'], body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    });
  });
  mounted.push(m);
  m.app().ontoolresult({ structuredContent: snapshot(), ...(resultMeta ? { _meta: resultMeta } : {}) });
  await m.flush(); await m.flush();
  return { m, posted, flush: () => (m.dom.window as unknown as { OrgXWidgetRuntime: { flushWidgetEvents: (closing?: boolean) => void } }).OrgXWidgetRuntime.flushWidgetEvents() };
}
const events = (posted: Posted[]) => posted.flatMap((p) => p.body.events);

describe('panel UX telemetry', () => {
  it('reports the open, the warm-up reads and a tab switch, with the grant and no decision text', async () => {
    const { m, posted, flush } = await open({ platform: 'mobile', displayMode: 'fullscreen' });
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ work: { status: 'ok', total: 0, items: [] } }) });
    click(m, '[data-tab="work"]');
    await m.flush(); await m.flush();
    await new Promise((r) => m.dom.window.requestAnimationFrame(() => r(null)));
    flush();
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]!.url).toBe(TELEMETRY.endpoint);
    expect(posted[0]!.body.grant).toBe(TELEMETRY.grant);
    const all = events(posted);
    const opened = all.find((e) => e.name === 'panel_opened')!;
    expect(opened.props).toMatchObject({ platform: 'mobile', display_mode: 'fullscreen', cold: false });
    expect(typeof opened.props.ttfc_ms).toBe('number');
    const reads = all.filter((e) => e.name === 'panel_read');
    expect(reads.map((r) => [r.props.panel_read_kind, r.props.panel_trigger, r.props.ok])).toEqual(expect.arrayContaining([['work', 'warm', true], ['receipts', 'warm', true]]));
    const sw = all.find((e) => e.name === 'panel_tab_switched')!;
    expect(sw.props).toMatchObject({ panel_from_tab: 'needs', panel_tab: 'work' });
    expect(typeof sw.props.latency_ms).toBe('number');
    const wire = JSON.stringify(posted.map((p) => p.body));
    expect(wire).not.toContain('Ship release');
    expect(wire).not.toContain('Rotate keys');
  });

  it('reports a decision from the press to the settled ruling', async () => {
    const { m, posted, flush } = await open();
    m.calls.callServerTool.mockImplementation(async (call: { name: string }) => {
      if (call.name === 'orgx_widget_decide') return { structuredContent: { ok: true, status: 'approved' } };
      return { structuredContent: snapshot() };
    });
    click(m, 'ox-footer[variant="confirms-in-orgx"]') ;
    (doc(m).querySelector('ox-footer[variant="confirms-in-orgx"]') as HTMLElement).dispatchEvent(new m.dom.window.CustomEvent('ox-primary', { bubbles: true, composed: true }));
    for (let i = 0; i < 6; i += 1) await m.flush();
    flush();
    const decision = events(posted).find((e) => e.name === 'panel_decision');
    expect(decision).toBeDefined();
    expect(decision!.props).toMatchObject({ panel_decision_action: 'approve', ok: true });
    expect(typeof decision!.props.latency_ms).toBe('number');
  });

  it('reports a failed read with its code only, and sends nothing without a grant', async () => {
    const { m, posted, flush } = await open({}, { 'orgx/widgetApproval': { approval_tokens: {} } });
    m.calls.callServerTool.mockRejectedValue(Object.assign(new Error('Upstream exploded with secrets inside'), { code: 'upstream_error' }));
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    flush();
    expect(posted).toHaveLength(0);
    const runtime = (m.dom.window as unknown as { OrgXWidgetRuntime: { _widgetEventsSent: () => number } }).OrgXWidgetRuntime;
    expect(runtime._widgetEventsSent()).toBe(0);
  });

  it('flushes with keepalive when the page hides', async () => {
    const { m, posted } = await open();
    m.dom.window.dispatchEvent(new m.dom.window.Event('pagehide'));
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]!.init.keepalive).toBe(true);
  });
});
