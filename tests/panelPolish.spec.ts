// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountPanel, snapshot } from './fixtures/panel';

/**
 * The cold-start stage, the real OrgX mark on every avatar that stands for
 * OrgX itself, and the rail of ways in on the calm state.
 */
type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));
const doc = (m: Mounted) => m.dom.window.document;
const click = (m: Mounted, selector: string) => (doc(m).querySelector(selector) as HTMLElement).click();

function calm() {
  return snapshot({
    attention: { pending: 0, oldest_at: null, blocking: false }, queue: [], focus: null,
    proof: { last_accepted: { title: 'Release checklist v3', accepted_at: '2026-10-01T12:00:00.000Z', url: 'https://useorgx.com/a' }, completed_unaccepted: 0 },
  });
}

describe('cold start', () => {
  it('shows the mark in orbit with the caption, then the content takes its place', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    const stage = doc(m).querySelector('.pn-skel .pn-boot')!;
    expect(stage).not.toBeNull();
    expect(stage.querySelectorAll('.pn-boot-sat').length).toBe(4);
    expect((stage.querySelector('.pn-boot-mark img') as HTMLImageElement).getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
    expect(stage.querySelector('.sk-cap')!.textContent).toBe('Reading your workspace');
    expect(doc(m).getElementById('panel')!.getAttribute('aria-busy')).toBe('true');
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    expect(doc(m).querySelector('.pn-boot')).toBeNull();
    expect(doc(m).querySelector('#pk-q')!.textContent).toBe('Ship release 4.2?');
  });
});

describe('the OrgX mark', () => {
  it('is the real mark, not a drawing, wherever an avatar stands for OrgX itself', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    const avatars = Array.from(doc(m).querySelectorAll('ox-avatar')) as (HTMLElement & { shadowRoot: ShadowRoot })[];
    const marks = avatars.filter((a) => a.shadowRoot?.querySelector('.a')?.getAttribute('data-kind') === 'mark');
    expect(marks.length).toBeGreaterThan(0);
    for (const a of marks) {
      const img = a.shadowRoot.querySelector('.f img.ox-mark') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
      // The kit's stylesheet hides a mark avatar's <img>; the real mark must still show.
      expect(img.style.display).toBe('block');
      expect(a.shadowRoot.querySelector('.f svg')).toBeNull();
    }
  });
});

describe('ways in when nothing needs you', () => {
  it('offers a rail of jobs, and a tap opens Start with the words in the box', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: calm() });
    await m.flush();
    const chips = Array.from(doc(m).querySelectorAll('.pn-calm .cm-rail .st-idea'));
    expect(chips.length).toBe(4);
    expect(chips[0]!.textContent).toBe('Draft the launch post for the new pricing');
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('needs');
    click(m, '.pn-calm .cm-rail .st-idea');
    await m.flush();
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('start');
    expect((doc(m).querySelector('#st-text') as HTMLTextAreaElement).value).toBe('Draft the launch post for the new pricing');
    expect(doc(m).querySelector('.st-preview')!.textContent).toContain('In OrgX, hand this to Mark (Marketing) and start it now: Draft the launch post for the new pricing.');
  });
});

describe('feel', () => {
  it('remembers where each tab was scrolled to and returns there', async () => {
    const m = await mountPanel({}, {}, (win) => {
      let y = 0;
      Object.defineProperty(win, 'scrollY', { configurable: true, get: () => y });
      (win as unknown as { scrollTo: (o: unknown, b?: number) => void }).scrollTo = (o: unknown, b?: number) => { y = typeof o === 'number' ? (b as number) : (o as { top: number }).top; };
    });
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ work: { status: 'ok', total: 0, items: [] } }) });
    const win = m.dom.window as unknown as Window & { scrollTo: (o: { top: number }) => void };
    win.scrollTo({ top: 480 });
    click(m, '[data-tab="work"]');
    await m.flush(); await m.flush();
    expect(win.scrollY).toBe(0);
    click(m, '[data-tab="needs"]');
    await m.flush();
    expect(win.scrollY).toBe(480);
  });

  it('shows Refresh as an icon that is busy while a read is in flight', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    const before = doc(m).querySelector('.pn-refresh')!;
    expect(before.getAttribute('aria-label')).toBe('Refresh');
    expect(before.querySelector('svg')).not.toBeNull();
    expect(before.hasAttribute('aria-busy')).toBe(false);
    m.calls.callServerTool.mockImplementation(() => new Promise(() => {}));
    click(m, '.pn-refresh');
    await m.flush();
    expect(doc(m).querySelector('.pn-refresh')!.getAttribute('aria-busy')).toBe('true');
  });
});

describe('on a phone', () => {
  const phone = { platform: 'mobile', deviceCapabilities: { touch: true, hover: false }, safeAreaInsets: { top: 0, right: 0, bottom: 92, left: 0 } };

  it('opens who-takes-it as a sheet above the host composer, and a pick closes it and sticks', async () => {
    const m = await mountPanel(phone, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    click(m, '[data-tab="start"]');
    await m.flush();
    click(m, '[data-action="start-who"]');
    await m.flush();
    const sheet = doc(m).getElementById('pn-sheet')!;
    expect(sheet).not.toBeNull();
    expect(sheet.parentElement).toBe(doc(m).body);
    expect(sheet.querySelector('.st-menu')).not.toBeNull();
    expect(doc(m).querySelector('#panel .st-menu')).toBeNull();
    expect(sheet.style.getPropertyValue('--pn-float-bottom')).toBe('92px');
    (sheet.querySelector('.st-opt[data-id="mark"]') as HTMLElement).click();
    await m.flush();
    expect(doc(m).getElementById('pn-sheet')).toBeNull();
    expect(doc(m).querySelector('.st-who-n')!.textContent).toBe('Mark');
    expect(JSON.parse(m.dom.window.localStorage.getItem('orgx.panel.start.v1')!)).toEqual({ agent: 'mark', verb: 'delegate' });
  });

  it('the scrim closes the sheet without choosing', async () => {
    const m = await mountPanel(phone, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    click(m, '[data-tab="start"]');
    await m.flush();
    click(m, '[data-action="start-who"]');
    await m.flush();
    (doc(m).querySelector('#pn-sheet .pn-sheet-scrim') as HTMLElement).click();
    await m.flush();
    expect(doc(m).getElementById('pn-sheet')).toBeNull();
    expect(doc(m).querySelector('.st-who-n')!.textContent).toBe('OrgX picks');
  });

  it('keeps who and how when the host re-creates the widget', async () => {
    const m = await mountPanel(phone, {}, (win) => { win.localStorage.setItem('orgx.panel.start.v1', JSON.stringify({ agent: 'dana', verb: 'delegate' })); });
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    click(m, '[data-tab="start"]');
    await m.flush();
    expect(doc(m).querySelector('.st-who-n')!.textContent).toBe('Dana');
    expect(doc(m).querySelector('.st-verb[aria-checked="true"]')!.textContent).toBe('Hand to Dana');
  });
});

describe('Done when a read fails', () => {
  it('offers the work ledger in OrgX beside Try again', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    m.calls.callServerTool.mockRejectedValue(new Error('upstream 502'));
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    const notice = doc(m).querySelector('.pn-done .notice')!;
    expect(notice).not.toBeNull();
    const acts = Array.from(notice.querySelectorAll('.text-btn')).map((b) => [b.textContent, b.getAttribute('data-action')]);
    expect(acts[0]).toEqual(['Try again', 'done-range']);
    expect(acts[1]![0]).toBe('Open the work ledger ↗');
    expect(acts[1]![1]).toBe('open');
    expect((notice.querySelector('[data-action="open"]') as HTMLElement).getAttribute('data-url')).toContain('useorgx.com');
  });
});

describe('fast by default', () => {
  it('names the workspace on every ledger read, since the ledger refuses without one', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    m.calls.callServerTool.mockResolvedValue({ structuredContent: { ok: true, data: { receipts: [] } } });
    click(m, '[data-tab="done"]');
    await m.flush(); await m.flush();
    const read = m.calls.callServerTool.mock.calls.map((c) => c[0]).find((c) => c.name === 'orgx_list_work_receipts');
    expect(read).toBeDefined();
    expect(read!.arguments).toMatchObject({ workspace_id: snapshot().workspace.id, limit: 50 });
    expect(read!.arguments.query).toMatch(/^since:\d{4}-\d{2}-\d{2}$/);
  });

  it('warms In progress and Done › Work in the background once the first snapshot is on screen', async () => {
    const m = await mountPanel({}, {}, (win) => {
      (win as unknown as { requestIdleCallback: (fn: () => void) => number }).requestIdleCallback = (fn) => { fn(); return 1; };
    });
    mounted.push(m);
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ work: { status: 'ok', total: 0, items: [] } }) });
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush(); await m.flush();
    const names = m.calls.callServerTool.mock.calls.map((c) => c[0]);
    expect(names.some((c) => c.name === 'orgx_panel_snapshot' && c.arguments.view === 'work')).toBe(true);
    expect(names.some((c) => c.name === 'orgx_list_work_receipts')).toBe(true);
    // The tab was still Needs you throughout; the warm-up never moved it.
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('needs');
    // A second snapshot does not warm again.
    const before = m.calls.callServerTool.mock.calls.length;
    m.app().ontoolresult({ structuredContent: snapshot({ generated_at: '2026-10-02T12:10:00.000Z' }) });
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(before);
  });

  it('keeps the decide-here tokens when a background read carries no approval metadata', async () => {
    const m = await mountPanel({}, {}, (win) => {
      (win as unknown as { requestIdleCallback: (fn: () => void) => number }).requestIdleCallback = (fn) => { fn(); return 1; };
    });
    mounted.push(m);
    // The warm-up's answers echo a snapshot but carry no _meta, as a lesser read might.
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ generated_at: '2026-10-02T12:09:00.000Z', work: { status: 'ok', total: 0, items: [] } }) });
    m.app().ontoolresult({ structuredContent: snapshot(), _meta: { 'orgx/widgetApproval': { approval_tokens: { [snapshot().focus.id]: 'tok-1' } } } });
    await m.flush(); await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-detail ox-footer[variant="confirms-in-orgx"]')).not.toBeNull();
  });

  it('reads a receipts range once even when a tap lands while the warm-up is in flight', async () => {
    const m = await mountPanel({}, {}, (win) => {
      (win as unknown as { requestIdleCallback: (fn: () => void) => number }).requestIdleCallback = (fn) => { fn(); return 1; };
    });
    mounted.push(m);
    m.calls.callServerTool.mockImplementation(() => new Promise(() => {}));
    m.app().ontoolresult({ structuredContent: snapshot() });
    await m.flush();
    click(m, '[data-tab="done"]');
    await m.flush();
    const reads = m.calls.callServerTool.mock.calls.map((c) => c[0]).filter((c) => c.name === 'orgx_list_work_receipts');
    expect(reads.length).toBe(1);
  });
});
