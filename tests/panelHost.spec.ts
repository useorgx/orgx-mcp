// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountPanel, snapshot, D1 } from './fixtures/panel';

/**
 * The panel is one document for every MCP Apps host. These tests lock what
 * changes with the host and the device: who the copy names, what the DOM
 * carries for CSS, the phone-only full-screen toggle, swipe between tabs,
 * the signed-out onboarding, the cold start that drags, and going offline.
 */
type Mounted = Awaited<ReturnType<typeof mountPanel>>;
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

const doc = (m: Mounted) => m.dom.window.document;
const html = (m: Mounted) => doc(m).documentElement;
/** What a person can read: the panel and the tour overlay, never the inlined scripts. */
const text = (m: Mounted) => (doc(m).getElementById('panel')!.textContent || '') + (doc(m).querySelector('.pn-tour')?.textContent || '');
const click = (m: Mounted, selector: string) => (doc(m).querySelector(selector) as HTMLElement).click();
const wait = (m: Mounted, ms: number) => new Promise((r) => m.dom.window.setTimeout(r, ms));

async function open(hostContext: Record<string, unknown> = {}, data = snapshot(), setup?: (win: Window) => void) {
  const m = await mountPanel(hostContext, {}, setup);
  mounted.push(m);
  m.app().ontoolresult({ structuredContent: data, _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 'synthetic-token' } } } });
  await m.flush();
  return m;
}

/** A touch pointer event jsdom can dispatch (it has no PointerEvent constructor). */
function touch(m: Mounted, type: string, target: Element, x: number, y: number) {
  const event = new m.dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { pointerType: { value: 'touch' }, clientX: { value: x }, clientY: { value: y } });
  target.dispatchEvent(event);
}

describe('who the panel is inside', () => {
  it('names Claude from the host context user agent, in the asks and the tour', async () => {
    const m = await open({ userAgent: 'Claude/2.1 (iOS)' });
    expect(html(m).getAttribute('data-host')).toBe('claude');
    expect(doc(m).querySelector('.pn-asks-h')!.textContent).toBe('Ask Claude');
    click(m, '[data-action="tour"]');
    await wait(m, 60);
    expect(doc(m).querySelector('.pn-coach-t')!.textContent).toBe('Decide agent work without leaving Claude');
    expect(text(m)).not.toContain('ChatGPT');
  });

  it('names ChatGPT from the ui/initialize hostInfo and re-renders when it arrives', async () => {
    const m = await open({});
    expect(doc(m).querySelector('.pn-asks-h')!.textContent).toBe('Ask in chat');
    // The parent's initialize response, as the SDK would receive it.
    const win = m.dom.window as unknown as Window & { OrgXPanelHost: { _setHostInfo(info: { name: string }): void } };
    win.OrgXPanelHost._setHostInfo({ name: 'ChatGPT' });
    await m.flush();
    expect(html(m).getAttribute('data-host')).toBe('chatgpt');
    expect(doc(m).querySelector('.pn-asks-h')!.textContent).toBe('Ask ChatGPT');
  });

  it('never names a host it cannot identify', async () => {
    const m = await open({ userAgent: 'SomeOtherHost/1.0' });
    expect(html(m).getAttribute('data-host')).toBe('unknown');
    expect(text(m)).not.toContain('ChatGPT');
    expect(text(m)).not.toContain('Claude');
    expect(doc(m).querySelector('.pn-asks-h')!.textContent).toBe('Ask in chat');
  });
});

describe('what the device gets', () => {
  it('carries the platform, touch and safe areas from the host context into the DOM', async () => {
    const m = await open({ platform: 'mobile', deviceCapabilities: { touch: true, hover: false }, safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 } });
    expect(html(m).getAttribute('data-platform')).toBe('mobile');
    expect(html(m).getAttribute('data-touch')).toBe('true');
    expect(html(m).style.getPropertyValue('--pn-safe-bottom')).toBe('34px');
    expect(html(m).style.getPropertyValue('--pn-safe-top')).toBe('47px');
  });

  it('defaults to web with no safe areas when the host says nothing', async () => {
    const m = await open({});
    expect(html(m).getAttribute('data-platform')).toBe('web');
    expect(html(m).style.getPropertyValue('--pn-safe-bottom')).toBe('0px');
    expect(doc(m).querySelector('.pn-display')).toBeNull();
  });

  it('offers full screen on a phone only when the host has that mode, and asks the host for it', async () => {
    const m = await open({ platform: 'mobile', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
    const win = m.dom.window as unknown as Window & { __FakeMcpApps: { App: { prototype: Record<string, unknown> } } };
    const requests: unknown[] = [];
    (m.app() as Record<string, unknown>).requestDisplayMode = async (params: { mode: string }) => { requests.push(params); return { mode: params.mode }; };
    void win;
    const button = doc(m).querySelector('.pn-display') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('data-mode')).toBe('fullscreen');
    button.click();
    await m.flush(); await m.flush();
    expect(requests).toEqual([{ mode: 'fullscreen' }]);
    expect(html(m).getAttribute('data-display-mode')).toBe('fullscreen');
    expect(doc(m).querySelector('.pn-display')!.getAttribute('data-mode')).toBe('inline');
  });

  it('shows no full-screen toggle in a sidebar or on the desktop', async () => {
    const m = await open({ platform: 'desktop', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
    expect(doc(m).querySelector('.pn-display')).toBeNull();
  });

  it('moves one tab per horizontal swipe on a touch screen, and ignores vertical scrolling', async () => {
    const m = await open({ platform: 'mobile', deviceCapabilities: { touch: true, hover: false } });
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({ work: { status: 'ok', total: 0, items: [] } }) });
    const view = doc(m).querySelector('.pn-split')!;
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('needs');
    touch(m, 'pointerdown', view, 300, 400); touch(m, 'pointerup', view, 120, 410);
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('work');
    const work = doc(m).querySelector('.pn-work')!;
    touch(m, 'pointerdown', work, 200, 100); touch(m, 'pointerup', work, 190, 400);
    await m.flush();
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('work');
    touch(m, 'pointerdown', work, 100, 300); touch(m, 'pointerup', work, 260, 300);
    await m.flush();
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('needs');
  });

  it('does not swipe with a mouse', async () => {
    const m = await open({});
    const view = doc(m).querySelector('.pn-split')!;
    const down = new m.dom.window.Event('pointerdown', { bubbles: true });
    Object.defineProperties(down, { pointerType: { value: 'mouse' }, clientX: { value: 300 }, clientY: { value: 400 } });
    view.dispatchEvent(down);
    const up = new m.dom.window.Event('pointerup', { bubbles: true });
    Object.defineProperties(up, { pointerType: { value: 'mouse' }, clientX: { value: 100 }, clientY: { value: 400 } });
    view.dispatchEvent(up);
    await m.flush();
    expect(doc(m).querySelector('.pn-tab[aria-selected="true"]')!.getAttribute('data-tab')).toBe('needs');
  });
});

describe('not connected yet', () => {
  it('shows the connect steps for the host, and a button that reads again', async () => {
    const m = await mountPanel({ userAgent: 'Claude/2.1' }, {});
    mounted.push(m);
    m.app().ontoolresult({ isError: true, structuredContent: { error: { code: 'authentication_required', message: 'Sign in' } } });
    await m.flush();
    expect(doc(m).querySelector('.so-h')!.textContent).toBe('Connect OrgX to Claude.');
    const steps = Array.from(doc(m).querySelectorAll('.so-step b')).map((b) => b.textContent);
    expect(steps).toEqual(['Add OrgX in Claude settings', 'Sign in and choose Read or Operate', 'Check again below']);
    expect(text(m)).not.toContain('ChatGPT');
    m.calls.callServerTool.mockResolvedValueOnce({ structuredContent: snapshot() });
    click(m, '.so-acts [data-action="refresh"]');
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'orgx_panel_snapshot' }));
    expect(doc(m).querySelector('.pn-so')).toBeNull();
    expect(doc(m).querySelector('#pk-q')!.textContent).toBe('Ship release 4.2?');
  });

  it('stays signed out, with the steps, when the read is still refused', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.app().ontoolresult({ isError: true, structuredContent: { error: { code: 'authentication_required', message: 'Sign in' } } });
    await m.flush();
    m.calls.callServerTool.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { result: { error: { code: 'authentication_required' } } }));
    click(m, '.so-acts [data-action="refresh"]');
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-so')).not.toBeNull();
  });

  it('asks for the Read scope when the connection is there but too narrow', async () => {
    const m = await mountPanel({ userAgent: 'ChatGPT' }, {});
    mounted.push(m);
    m.app().ontoolresult({ isError: true, structuredContent: { error: { code: 'insufficient_scope', message: 'Narrow' } } });
    await m.flush();
    expect(doc(m).querySelector('.so-h')!.textContent).toBe('OrgX needs permission to read your workspace.');
    expect(doc(m).querySelector('.so-step span span')!.textContent).toBe('In ChatGPT settings, open OrgX and allow it to read your initiatives.');
  });
});

describe('a cold start that drags', () => {
  it('says so after six seconds and offers a way out after fifteen', async () => {
    const m = await mountPanel({}, {}, (win) => {
      // Compress the wait so the test stays fast: the thresholds are the panel's, the clock is ours.
      const realSetTimeout = win.setTimeout.bind(win);
      (win as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
        realSetTimeout(fn, ms && ms >= 6000 ? ms / 100 : ms, ...rest)) as typeof setTimeout;
    });
    mounted.push(m);
    expect(doc(m).querySelector('.sk-cap')!.textContent).toBe('Reading your workspace');
    await wait(m, 75);
    expect(doc(m).querySelector('.sk-cap')!.textContent).toBe('Still reading. OrgX is taking longer than usual.');
    expect(doc(m).querySelector('.sk-stall')).toBeNull();
    await wait(m, 100);
    expect(doc(m).querySelector('.sk-stall')).not.toBeNull();
    expect(doc(m).querySelector('.sk-stall [data-action="refresh"]')!.textContent).toBe('Try again');
    expect(doc(m).getElementById('panel')!.getAttribute('aria-busy')).toBe('true');
    m.calls.callServerTool.mockResolvedValueOnce({ structuredContent: snapshot() });
    click(m, '.sk-stall [data-action="refresh"]');
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('.pn-skel')).toBeNull();
    expect(doc(m).querySelector('#pk-q')!.textContent).toBe('Ship release 4.2?');
  });

  it('does not escalate once the snapshot has arrived', async () => {
    const m = await mountPanel({}, {}, (win) => {
      const realSetTimeout = win.setTimeout.bind(win);
      (win as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
        realSetTimeout(fn, ms && ms >= 6000 ? ms / 100 : ms, ...rest)) as typeof setTimeout;
    });
    mounted.push(m);
    m.app().ontoolresult({ structuredContent: snapshot() });
    await wait(m, 200);
    expect(doc(m).querySelector('.sk-stall')).toBeNull();
    expect(doc(m).querySelector('#pk-q')).not.toBeNull();
  });
});

describe('offline', () => {
  it('says it is offline over the last snapshot, then reads again when the network returns', async () => {
    const m = await open({});
    expect(doc(m).querySelector('.notice.is-offline')).toBeNull();
    m.dom.window.dispatchEvent(new m.dom.window.Event('offline'));
    await m.flush();
    expect(doc(m).querySelector('.notice.is-offline')!.textContent).toContain('You’re offline.');
    expect(doc(m).querySelector('#pk-q')!.textContent).toBe('Ship release 4.2?');
    const before = m.calls.callServerTool.mock.calls.length;
    m.calls.callServerTool.mockResolvedValueOnce({ structuredContent: snapshot({ generated_at: '2026-10-02T12:09:00.000Z' }) });
    m.dom.window.dispatchEvent(new m.dom.window.Event('online'));
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls.length).toBe(before + 1);
    expect(doc(m).querySelector('.notice.is-offline')).toBeNull();
  });

  it('tells a cold start it is offline instead of shimmering', async () => {
    const m = await mountPanel({}, {});
    mounted.push(m);
    m.dom.window.dispatchEvent(new m.dom.window.Event('offline'));
    await m.flush();
    expect(doc(m).querySelector('.sk-cap')!.textContent).toBe('You’re offline. The panel loads when you’re back.');
  });
});
