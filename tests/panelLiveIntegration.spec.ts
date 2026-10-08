// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountPanel, snapshot, D1, D2 } from './fixtures/panel';

/**
 * The real panel page with a fake EventSource: the feed says what changed and
 * the panel shows it — without a loading state, and without repainting over a
 * reply the person is typing.
 */

interface FakeSource {
  url: string;
  closed: boolean;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  open(): void;
  send(frame: unknown): void;
}

type Mounted = Awaited<ReturnType<typeof mountPanel>> & { sources: FakeSource[] };
const mounted: Mounted[] = [];
afterEach(() => mounted.splice(0).forEach(({ dom }) => dom.window.close()));

const doc = (m: Mounted) => m.dom.window.document;
const wait = (m: Mounted, ms: number) => new Promise((r) => m.dom.window.setTimeout(r, ms));

function grant(feedId: string) {
  return {
    feedType: 'panel',
    feedId,
    streamUrl: `https://mcp.useorgx.test/live-feed/panel/${feedId}/stream?t=tok`,
    expiresAt: Date.now() + 10 * 60 * 1000,
    refreshTool: 'orgx_panel_snapshot',
    refreshArgs: {},
    label: 'OrgX panel',
  };
}

function graph(decisions: Record<string, string>, work: Record<string, string> = {}) {
  return {
    type: 'snapshot',
    ts: Date.now(),
    data: {
      feedType: 'panel',
      feedId: 'ws',
      nodes: [
        ...Object.entries(decisions).map(([id, v]) => ({ id: `decision:${id}`, title: 'd', phase: 'blocked', updatedAt: v })),
        ...Object.entries(work).map(([id, s]) => ({ id: `work:${id}`, title: 'w', phase: s === 'blocked' ? 'blocked' : 'executing', status: s })),
      ],
      summary: { running: 0, queued: 0, blocked: 0, done: 0, total: 0, progress: 0 },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function open(): Promise<Mounted> {
  const sources: FakeSource[] = [];
  const base = await mountPanel({}, {}, (win) => {
    (win as unknown as Record<string, unknown>).EventSource = class {
      url: string;
      closed = false;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        this.url = url;
        sources.push(this as unknown as FakeSource);
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
      open() {
        this.onopen?.();
      }
      send(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    };
  });
  const m = Object.assign(base, { sources });
  mounted.push(m);
  const data = snapshot();
  m.app().ontoolresult({
    structuredContent: { ...data, live: grant((data.workspace as { id: string }).id) },
    _meta: { 'orgx/widgetApproval': { approval_tokens: { [D1]: 't1', [D2]: 't2' } } },
  });
  await m.flush();
  return m;
}

const rowTitles = (m: Mounted) =>
  Array.from(doc(m).querySelectorAll('[data-action="choose"]')).map((n) => n.getAttribute('data-id'));

describe('panel live updates', () => {
  it('connects to the granted feed and says it is live', async () => {
    const m = await open();
    expect(m.sources).toHaveLength(1);
    expect(m.sources[0]!.url).toContain('/live-feed/panel/');
    m.sources[0]!.open();
    await m.flush();
    const sync = doc(m).querySelector('.sync');
    expect(sync?.getAttribute('data-live')).toBe('live');
    expect(sync?.textContent).toBe('Live');
  });

  it('does not re-read when the feed matches what is shown', async () => {
    const m = await open();
    m.sources[0]!.open();
    m.sources[0]!.send(graph({ [D1]: 'v1', [D2]: 'v1' }));
    await wait(m, 400);
    expect(m.calls.callServerTool).not.toHaveBeenCalled();
  });

  it('removes a decision settled elsewhere at once, then re-reads quietly', async () => {
    const m = await open();
    m.sources[0]!.open();
    m.calls.callServerTool.mockResolvedValue({
      structuredContent: snapshot({
        generated_at: '2026-10-02T12:05:00.000Z',
        attention: { pending: 1, oldest_at: '2026-09-30T10:00:00.000Z', blocking: false },
        queue: [snapshot().queue[0]],
      }),
    });
    m.sources[0]!.send(graph({ [D1]: 'v1' }));
    // Long enough for the kit's delayed announcement (it writes after 20ms so
    // screen readers notice the change), well short of the 300ms re-read.
    await wait(m, 60);
    // Gone before any read completes, and no loading state for it.
    expect(doc(m).querySelector('.pn-tab-n')!.textContent).toBe('1');
    expect(doc(m).getElementById('panel')!.getAttribute('aria-busy')).toBe('false');
    // Announced through whichever live region the page uses.
    const spoken = Array.from(doc(m).querySelectorAll('[aria-live], [role="status"]')).map((n) => n.textContent).join(' ');
    expect(spoken).toContain('settled elsewhere');

    await wait(m, 400);
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(1);
    expect(m.calls.callServerTool.mock.calls[0]![0]).toMatchObject({ name: 'orgx_panel_snapshot', arguments: {} });

    // The same feed state again does not read again.
    m.sources[0]!.send(graph({ [D1]: 'v1' }));
    await wait(m, 2000);
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(1);
  });

  it('re-reads once when a new decision arrives', async () => {
    const m = await open();
    m.sources[0]!.open();
    const D3 = '44444444-4444-4444-8444-444444444444';
    m.sources[0]!.send(graph({ [D1]: 'v1', [D2]: 'v1', [D3]: 'v1' }));
    await wait(m, 400);
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(1);
  });

  it('counts In progress from the feed before it is opened', async () => {
    const m = await open();
    m.sources[0]!.open();
    m.sources[0]!.send(graph({ [D1]: 'v1', [D2]: 'v1' }, { t1: 'running', t2: 'blocked' }));
    await m.flush();
    const count = doc(m).querySelector('#pn-tab-work .pn-tab-n');
    expect(count?.textContent).toBe('2');
    expect(count?.getAttribute('data-tone')).toBe('red');
    expect(m.calls.callServerTool).not.toHaveBeenCalled();
  });

  it('holds a repaint while the person is typing, and applies it when they leave the field', async () => {
    const m = await open();
    m.sources[0]!.open();
    const area = doc(m).createElement('textarea');
    doc(m).getElementById('panel')!.appendChild(area);
    area.focus();
    area.value = 'half a sentence';
    m.sources[0]!.send(graph({ [D1]: 'v1' }));
    await m.flush();
    // Still in the document with its text: nothing rebuilt the panel.
    expect(area.isConnected).toBe(true);
    expect(doc(m).activeElement).toBe(area);
    area.blur();
    await wait(m, 20);
    expect(area.isConnected).toBe(false);
    expect(doc(m).querySelector('.pn-tab-n')!.textContent).toBe('1');
  });

  it('replays a feed change that arrived during a manual refresh', async () => {
    const m = await open();
    m.sources[0]!.open();
    let finish: (value: unknown) => void = () => {};
    m.calls.callServerTool.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    (doc(m).querySelector('[data-action="refresh"]') as HTMLElement).click();
    await m.flush();
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(1);

    // A new decision arrives while that read is still out.
    const D3 = '44444444-4444-4444-8444-444444444444';
    m.sources[0]!.send(graph({ [D1]: 'v1', [D2]: 'v1', [D3]: 'v1' }));
    await wait(m, 400);
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(1);

    finish({ structuredContent: snapshot({ generated_at: '2026-10-02T12:05:00.000Z' }) });
    await wait(m, 1800);
    // The change was not dropped: one quiet re-read followed.
    expect(m.calls.callServerTool).toHaveBeenCalledTimes(2);
  });

  it('stops the stream when the server halts the feed', async () => {
    const m = await open();
    m.sources[0]!.open();
    m.sources[0]!.send({ type: 'error', message: 'live_refresh_metered: get_pending_decisions was billed', retryable: false, ts: Date.now() });
    await m.flush();
    expect(m.sources[0]!.closed).toBe(true);
    expect(doc(m).querySelector('.sync')?.getAttribute('data-live')).toBe('off');
  });
});

describe('workspace switcher', () => {
  const OTHER = '55555555-5555-4555-8555-555555555555';

  it('lists workspaces when opened, switches through orgx_bootstrap, and follows the new feed', async () => {
    const m = await open();
    const sws = snapshot().workspace as { id: string };
    m.calls.callServerTool.mockImplementation(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'orgx_bootstrap') return { structuredContent: { ok: true } };
      if (args.view === 'workspaces') {
        return { structuredContent: snapshot({
          generated_at: '2026-10-02T12:01:00.000Z',
          workspaces: { status: 'ok', items: [
            { id: sws.id, name: 'Acme', current: true },
            { id: OTHER, name: 'Labs', current: false },
          ] },
        }) };
      }
      return { structuredContent: { ...snapshot({ generated_at: '2026-10-02T12:02:00.000Z', workspace: { id: OTHER, name: 'Labs' } }), live: grant(OTHER) } };
    });

    // No workspace read until the switcher opens.
    expect(m.calls.callServerTool).not.toHaveBeenCalled();
    (doc(m).querySelector('[data-action="workspaces"]') as HTMLElement).click();
    await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls[0]![0]).toMatchObject({ name: 'orgx_panel_snapshot', arguments: { view: 'workspaces' } });
    const items = Array.from(doc(m).querySelectorAll('.ws-item')).map((b) => b.textContent);
    expect(items).toEqual(['AcmeCurrent', 'Labs']);

    (doc(m).querySelector(`[data-action="switch-workspace"][data-id="${OTHER}"]`) as HTMLElement).click();
    await m.flush(); await m.flush(); await m.flush();
    expect(m.calls.callServerTool.mock.calls[1]![0]).toEqual({ name: 'orgx_bootstrap', arguments: { workspace_id: OTHER } });
    expect(m.calls.callServerTool.mock.calls[2]![0]).toMatchObject({ name: 'orgx_panel_snapshot', arguments: {} });
    expect(doc(m).querySelector('.ws-btn')!.textContent).toContain('Labs');
    expect(doc(m).querySelector('#pn-ws-menu')).toBeNull();
    // The old workspace's stream closed; the new one opened.
    expect(m.sources[0]!.closed).toBe(true);
    expect(m.sources.at(-1)!.url).toContain(`/live-feed/panel/${OTHER}/`);
  });

  it('keeps the list open with a way forward when the switch fails', async () => {
    const m = await open();
    m.calls.callServerTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'orgx_bootstrap') throw new Error('nope');
      return { structuredContent: snapshot({
        generated_at: '2026-10-02T12:01:00.000Z',
        workspaces: { status: 'ok', items: [
          { id: (snapshot().workspace as { id: string }).id, name: 'Acme', current: true },
          { id: OTHER, name: 'Labs', current: false },
        ] },
      }) };
    });
    (doc(m).querySelector('[data-action="workspaces"]') as HTMLElement).click();
    await m.flush(); await m.flush();
    (doc(m).querySelector(`[data-action="switch-workspace"][data-id="${OTHER}"]`) as HTMLElement).click();
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('#pn-ws-menu')).not.toBeNull();
    expect(doc(m).querySelector('#pn-ws-menu [role="alert"]')).not.toBeNull();
    expect(doc(m).querySelector('.ws-btn')!.textContent).toContain('Acme');
  });

  it('says the list could not be read instead of showing it empty', async () => {
    const m = await open();
    m.calls.callServerTool.mockResolvedValue({ structuredContent: snapshot({
      generated_at: '2026-10-02T12:01:00.000Z',
      workspaces: { status: 'unavailable', items: [] },
    }) });
    (doc(m).querySelector('[data-action="workspaces"]') as HTMLElement).click();
    await m.flush(); await m.flush();
    expect(doc(m).querySelector('#pn-ws-menu')!.textContent).toContain('could not be loaded');
    expect(doc(m).querySelector('[data-action="workspaces-retry"]')).not.toBeNull();
  });
});
