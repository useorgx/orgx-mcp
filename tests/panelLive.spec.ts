import { beforeEach, describe, expect, it, vi } from 'vitest';

import { diffGraphs } from '../src/live/delta';
import {
  cadenceFor,
  FEEDS,
  FEED_ROUTE_PATTERN,
  FEED_VIEWER_HEADER,
  FEED_VIEWER_ORGX_HEADER,
} from '../src/live/feedRegistry';
import {
  assertExempt,
  buildPanelLiveGraph,
  LiveRefreshMeteredError,
  loadPanelFeed,
  type FeedLoadContext,
} from '../src/live/panelFeed';
import { LiveFeedDO } from '../src/liveFeedDO';
import { readSharedScript } from './fixtures/live';

const WS = '11111111-1111-4111-8111-111111111111';
const D1 = '22222222-2222-4222-8222-222222222222';
const D2 = '33333333-3333-4333-8333-333333333333';

function decision(id: string, updatedAt: string, title = 'Ship release 4.2?') {
  return { id, summary: title, created_at: '2026-10-07T10:00:00Z', updated_at: updatedAt, urgency: 'high' };
}

function agentsPayload(status: 'running' | 'blocked') {
  return {
    agents: [
      { agent_id: 'eli', agent_name: 'Eli', status, current_tasks: [{ id: 't1', title: 'Reconcile telemetry', status }] },
    ],
  };
}

/** `usage: 'omit'` is an app that predates the exemption and sends no usage field. */
function toolResponse(data: unknown, usage: unknown = { metered: false, reason: 'live_refresh' }) {
  return new Response(JSON.stringify({ ok: true, data, ...(usage === 'omit' ? {} : { usage }) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A loader context whose two tool reads return what the test says. */
function context(reads: Record<string, () => Response>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const ctx: FeedLoadContext = {
    feedId: WS,
    viewerId: 'viewer-1',
    request: async (path, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      const respond = reads[body.tool_id as string];
      if (!respond) throw new Error(`unexpected tool ${body.tool_id}`);
      return respond();
    },
  };
  return { ctx, calls };
}

describe('panel feed loader', () => {
  it('makes both panel reads as exempt live refreshes for the viewer and workspace', async () => {
    const { ctx, calls } = context({
      get_pending_decisions: () => toolResponse({ decisions: [decision(D1, 'v1')] }),
      get_agent_status: () => toolResponse(agentsPayload('running')),
    });
    const raw = await loadPanelFeed(ctx);
    expect(calls.map((c) => c.path)).toEqual(['/api/tools/execute', '/api/tools/execute']);
    expect(calls.map((c) => c.body)).toEqual([
      expect.objectContaining({
        tool_id: 'get_pending_decisions',
        args: { workspace_id: WS, limit: 25 },
        user_id: 'viewer-1',
        usage_class: 'live_refresh',
      }),
      expect.objectContaining({
        tool_id: 'get_agent_status',
        args: { workspace_id: WS },
        user_id: 'viewer-1',
        usage_class: 'live_refresh',
      }),
    ]);
    // No approval channel: tokens never ride the stream.
    expect(calls[0]!.body.args).not.toHaveProperty('_widget_meta_channel');
    expect(raw.decisions).toHaveLength(1);
    expect(raw.agents).not.toBeNull();
  });

  it('halts instead of polling when the app bills the read', async () => {
    // An app without the exemption sends no usage field: that call was billed.
    const { ctx } = context({
      get_pending_decisions: () => toolResponse({ decisions: [] }, 'omit'),
      get_agent_status: () => toolResponse(agentsPayload('running')),
    });
    const failure = await loadPanelFeed(ctx).catch((error) => error);
    expect(failure).toBeInstanceOf(LiveRefreshMeteredError);
    expect(failure).toMatchObject({ retryable: false, halt: true });
  });

  it('backs off instead of halting when the person is over the per-minute cap', async () => {
    const { ctx } = context({
      get_pending_decisions: () => toolResponse({ decisions: [] }, { metered: true, billed: true, reason: 'over_live_cap' }),
      get_agent_status: () => toolResponse(agentsPayload('running')),
    });
    const failure = await loadPanelFeed(ctx).catch((error) => error);
    expect(failure).not.toBeInstanceOf(LiveRefreshMeteredError);
    expect(failure).toMatchObject({ retryable: true });
    expect(failure.halt).toBeUndefined();
  });

  it('keeps going when nothing was billed, even if the policy said metered', () => {
    // No resolvable user: metered by policy, but no allowance was spent.
    expect(() => assertExempt('get_pending_decisions', { metered: true, billed: false, reason: 'no_user' })).not.toThrow();
    expect(() => assertExempt('get_pending_decisions', { metered: true, billed: true, reason: 'tool_not_exempt' })).toThrow(LiveRefreshMeteredError);
    expect(() => assertExempt('get_pending_decisions', null)).toThrow(LiveRefreshMeteredError);
  });

  it('halts when only the agent read is billed', async () => {
    const { ctx } = context({
      get_pending_decisions: () => toolResponse({ decisions: [] }),
      get_agent_status: () => toolResponse(agentsPayload('running'), { metered: true, billed: true, reason: 'not_requested' }),
    });
    await expect(loadPanelFeed(ctx)).rejects.toBeInstanceOf(LiveRefreshMeteredError);
  });

  it('keeps the decision feed when the agent read fails', async () => {
    const { ctx } = context({
      get_pending_decisions: () => toolResponse({ decisions: [decision(D1, 'v1')] }),
      get_agent_status: () => new Response('nope', { status: 503 }),
    });
    const raw = await loadPanelFeed(ctx);
    expect(raw.agents).toBeNull();
    expect(raw.decisions).toHaveLength(1);
  });

  it('reports a failed decision read as retryable', async () => {
    const { ctx } = context({
      get_pending_decisions: () =>
        new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 200 }),
      get_agent_status: () => toolResponse(agentsPayload('running')),
    });
    await expect(loadPanelFeed(ctx)).rejects.toMatchObject({ retryable: true });
  });

  it('names the viewer by canonical OrgX id when the token carried one, as the panel does', async () => {
    const { ctx, calls } = context({
      get_pending_decisions: () => toolResponse({ decisions: [] }),
      get_agent_status: () => toolResponse(agentsPayload('running')),
    });
    await loadPanelFeed({ ...ctx, viewerOrgxId: D2 });
    expect(calls.every((c) => c.body.user_id === D2)).toBe(true);
  });

  it('refuses to run without a viewer', async () => {
    const { ctx } = context({});
    await expect(loadPanelFeed({ ...ctx, viewerId: null })).rejects.toMatchObject({ retryable: false });
  });
});

describe('panel feed graph', () => {
  it('names each decision by id and version, and each piece of work by state', () => {
    const graph = buildPanelLiveGraph(
      { decisions: [decision(D1, 'v1'), { id: 'not-a-uuid', summary: 'skip' }], agents: agentsPayload('running') },
      WS
    );
    expect(graph.feedType).toBe('panel');
    expect(graph.nodes.map((n) => [n.id, n.updatedAt ?? n.status, n.phase])).toEqual([
      [`decision:${D1}`, 'v1', 'pending'],
      ['work:t1', 'running', 'executing'],
    ]);
  });

  it('reports a new version, an arrival, a departure and a work change as deltas, and silence as nothing', () => {
    const before = buildPanelLiveGraph({ decisions: [decision(D1, 'v1')], agents: agentsPayload('running') }, WS);
    const same = buildPanelLiveGraph({ decisions: [decision(D1, 'v1')], agents: agentsPayload('running') }, WS);
    expect(diffGraphs(before, same)).toBeNull();

    const edited = buildPanelLiveGraph({ decisions: [decision(D1, 'v2')], agents: agentsPayload('running') }, WS);
    expect(diffGraphs(before, edited)!.changed.map((n) => n.id)).toEqual([`decision:${D1}`]);

    const arrived = buildPanelLiveGraph({ decisions: [decision(D1, 'v1'), decision(D2, 'v1')], agents: agentsPayload('running') }, WS);
    expect(diffGraphs(before, arrived)!.changed.map((n) => n.id)).toEqual([`decision:${D2}`]);

    const settled = buildPanelLiveGraph({ decisions: [], agents: agentsPayload('running') }, WS);
    expect(diffGraphs(before, settled)!.removed).toEqual([`decision:${D1}`]);

    const blocked = buildPanelLiveGraph({ decisions: [decision(D1, 'v1')], agents: agentsPayload('blocked') }, WS);
    expect(diffGraphs(before, blocked)!.changed.map((n) => n.id)).toEqual(['work:t1']);
  });

  it('marks a failed agent read as unavailable instead of empty', () => {
    const graph = buildPanelLiveGraph({ decisions: [decision(D1, 'v1')], agents: null }, WS);
    expect(graph.nodes.map((n) => n.id)).toEqual([`decision:${D1}`, 'meta:work-unavailable']);
  });

  it('rests while only decisions are pending, and polls fast while agents work', () => {
    const pendingOnly = buildPanelLiveGraph({ decisions: [decision(D1, 'v1')], agents: { agents: [] } }, WS);
    const working = buildPanelLiveGraph({ decisions: [decision(D1, 'v1')], agents: agentsPayload('running') }, WS);
    const feed = FEEDS.panel!;
    expect(cadenceFor(feed, pendingOnly)).toBe(feed.cadence.idleMs);
    expect(cadenceFor(feed, working)).toBe(feed.cadence.activeMs);
  });

  it('is routable and per viewer', () => {
    expect(`/live-feed/panel/${WS}/stream`).toMatch(FEED_ROUTE_PATTERN);
    expect(FEEDS.panel).toMatchObject({ scope: 'user', cadence: { activeMs: 3000, idleMs: 6000 } });
  });
});

// ── The Durable Object, driven with the real panel feed ────────────────────

function createCtx(store: Map<string, unknown> = new Map()) {
  let alarm: number | null = null;
  const waits: Promise<unknown>[] = [];
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    },
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p.catch(() => {}));
    },
    settle: () => Promise.all(waits),
    get alarmAt() {
      return alarm;
    },
  } as never as DurableObjectState & { settle(): Promise<unknown>; alarmAt: number | null };
}

async function firstFrame(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const line = buffer.split('\n').find((l) => l.startsWith('data: '));
    if (line) {
      reader.cancel().catch(() => {});
      return JSON.parse(line.slice(6));
    }
  }
  reader.cancel().catch(() => {});
  throw new Error('no frame');
}

function panelRequest(): Request {
  return new Request(`https://do/live-feed/panel/${WS}/stream`, {
    headers: { accept: 'text/event-stream', [FEED_VIEWER_HEADER]: 'viewer-1' },
  });
}

const ENV = {
  ORGX_API_URL: 'https://api.test',
  ORGX_SERVICE_KEY: 'oxk-test',
  ORGX_INTERNAL_SECRET: 'secret',
} as never;

describe('panel feed in the Durable Object', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('streams a snapshot built from the two exempt reads', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.tool_id === 'get_pending_decisions'
        ? toolResponse({ decisions: [decision(D1, 'v1')] })
        : toolResponse(agentsPayload('running'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);
    const response = await feed.fetch(panelRequest());
    const frame = await firstFrame(response.body!);
    expect(frame.type).toBe('snapshot');
    expect((frame.data as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id)).toEqual([
      `decision:${D1}`,
      'work:t1',
    ]);
    const methods = fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method);
    expect(methods).toEqual(['POST', 'POST']);
    await ctx.settle();
    expect(ctx.alarmAt).not.toBeNull();
  });

  it('reads as the viewer, with the canonical id in the actor token and the body', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.tool_id === 'get_pending_decisions'
        ? toolResponse({ decisions: [] })
        : toolResponse(agentsPayload('running'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const feed = new LiveFeedDO(createCtx(), ENV);
    const request = new Request(`https://do/live-feed/panel/${WS}/stream`, {
      headers: {
        accept: 'text/event-stream',
        [FEED_VIEWER_HEADER]: 'viewer-1',
        [FEED_VIEWER_ORGX_HEADER]: D2,
      },
    });
    await firstFrame((await feed.fetch(request)).body!);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(new Headers(init.headers).get('X-Orgx-Orgx-User-Id')).toBe(D2);
      expect(JSON.parse(String(init.body)).user_id).toBe(D2);
    }
  });

  it('stops polling and tells every later client when a read was billed', async () => {
    const fetchMock = vi.fn(async () => toolResponse({ decisions: [] }, 'omit'));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);

    const first = await firstFrame((await feed.fetch(panelRequest())).body!);
    expect(first).toMatchObject({ type: 'error', retryable: false });
    expect(String(first.message)).toContain('live_refresh_metered');
    await ctx.settle();
    // No alarm: nothing polls in the background.
    expect(ctx.alarmAt).toBeNull();
    const pollsSoFar = fetchMock.mock.calls.length;

    // A reconnecting panel gets the same answer without another billed read.
    const again = await firstFrame((await feed.fetch(panelRequest())).body!);
    expect(again).toMatchObject({ type: 'error', retryable: false });
    expect(fetchMock.mock.calls.length).toBe(pollsSoFar);
  });

  it('keeps the halt across an evicted and re-created instance', async () => {
    const fetchMock = vi.fn(async () => toolResponse({ decisions: [] }, 'omit'));
    vi.stubGlobal('fetch', fetchMock);
    const store = new Map<string, unknown>();
    const first = createCtx(store);
    await firstFrame((await new LiveFeedDO(first, ENV).fetch(panelRequest())).body!);
    await first.settle();
    const pollsSoFar = fetchMock.mock.calls.length;

    const reborn = new LiveFeedDO(createCtx(store), ENV);
    const frame = await firstFrame((await reborn.fetch(panelRequest())).body!);
    expect(frame).toMatchObject({ type: 'error', retryable: false });
    expect(fetchMock.mock.calls.length).toBe(pollsSoFar);
  });

  it('re-polls an aged graph before giving it to a new client', async () => {
    let decisions = [decision(D1, 'v1')];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.tool_id === 'get_pending_decisions'
        ? toolResponse({ decisions })
        : toolResponse(agentsPayload('running'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const now = vi.spyOn(Date, 'now');
    const start = Date.parse('2026-10-07T12:00:00Z');
    now.mockReturnValue(start);
    const ctx = createCtx();
    const feed = new LiveFeedDO(ctx, ENV);
    await firstFrame((await feed.fetch(panelRequest())).body!);
    await ctx.settle();

    // Everyone left; upstream moved on; a new panel attaches 30s later.
    decisions = [decision(D1, 'v1'), decision(D2, 'v1')];
    now.mockReturnValue(start + 30_000);
    const frame = await firstFrame((await feed.fetch(panelRequest())).body!);
    const ids = (frame.data as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id);
    expect(ids).toContain(`decision:${D2}`);
  });
});

// ── The panel's client module ──────────────────────────────────────────────

interface FakeStore {
  emit(state: Record<string, unknown>): void;
  started: number;
  stopped: number;
  options: Record<string, unknown>;
}

function loadPanelLive(withEventSource = true) {
  const stores: FakeStore[] = [];
  const scope: Record<string, any> = {
    ...(withEventSource ? { EventSource: function EventSource() {} } : {}),
    OrgXLiveStore: {
      createLiveStore(options: Record<string, unknown>) {
        let listener: ((state: Record<string, unknown>) => void) | null = null;
        const store: FakeStore = {
          options,
          started: 0,
          stopped: 0,
          emit: (state) => listener && listener(state),
        };
        stores.push(store);
        return {
          subscribe(fn: (state: Record<string, unknown>) => void) {
            listener = fn;
            return () => {
              listener = null;
            };
          },
          start() {
            store.started += 1;
          },
          stop() {
            store.stopped += 1;
          },
          reconnect() {},
        };
      },
    },
  };
  new Function('globalThis', 'window', readSharedScript('panel/panel-live.js')).call(scope, scope, scope);
  return { Live: scope.OrgXPanelLive, stores };
}

function grant(feedId = WS) {
  return {
    feedType: 'panel',
    feedId,
    streamUrl: `https://mcp.test/live-feed/panel/${feedId}/stream?t=x`,
    expiresAt: Date.now() + 60_000,
    refreshTool: 'orgx_panel_snapshot',
    refreshArgs: {},
    label: 'OrgX panel',
  };
}

function graphState(decisions: Record<string, string>, work: Record<string, string> = {}) {
  return {
    connection: 'live',
    live: true,
    error: null,
    data: {
      nodes: [
        ...Object.entries(decisions).map(([id, v]) => ({ id: `decision:${id}`, updatedAt: v, phase: 'blocked' })),
        ...Object.entries(work).map(([id, s]) => ({ id: `work:${id}`, status: s, phase: s === 'blocked' ? 'blocked' : 'executing' })),
      ],
    },
  };
}

describe('panel live client', () => {
  it('drops settled decisions and asks for one re-read per distinct queue', () => {
    const { Live, stores } = loadPanelLive();
    let shown: Record<string, string> = { [D1]: 'v1', [D2]: 'v1' };
    const removed: string[][] = [];
    const stale = vi.fn();
    const live = Live.create({ runtime: {}, shownQueue: () => shown, onRemoved: (ids: string[]) => removed.push(ids), onStale: stale });
    live.update(grant());
    const store = stores[0]!;
    expect(store.started).toBe(1);

    store.emit(graphState({ [D1]: 'v1', [D2]: 'v1' }));
    expect(stale).not.toHaveBeenCalled();

    // D2 settled elsewhere.
    store.emit(graphState({ [D1]: 'v1' }));
    expect(removed).toEqual([[D2]]);
    expect(stale).toHaveBeenCalledTimes(1);

    // The same feed state again (a reconnect replay): no second re-read, even
    // though the panel has not caught up yet.
    store.emit(graphState({ [D1]: 'v1' }));
    expect(stale).toHaveBeenCalledTimes(1);

    // A new version of D1.
    shown = { [D1]: 'v1' };
    store.emit(graphState({ [D1]: 'v2' }));
    expect(stale).toHaveBeenCalledTimes(2);
  });

  it('reports In progress moving without re-reading decisions', () => {
    const { Live, stores } = loadPanelLive();
    const work = vi.fn();
    const stale = vi.fn();
    const live = Live.create({ runtime: {}, shownQueue: () => ({}), onStale: stale, onWork: work });
    live.update(grant());
    stores[0]!.emit(graphState({}, { t1: 'running' }));
    stores[0]!.emit(graphState({}, { t1: 'blocked' }));
    expect(work.mock.calls.map((c) => [{ total: c[0].total, blocked: c[0].blocked }, c[1]])).toEqual([
      [{ total: 1, blocked: 0 }, false],
      [{ total: 1, blocked: 1 }, true],
    ]);
    // The rows themselves come along, so In progress can render from the feed.
    expect(work.mock.calls[1]![0].items).toEqual([{ id: 't1', agent: 'Agent', title: 'Task', state: 'blocked' }]);
    expect(stale).not.toHaveBeenCalled();
  });

  it('keeps one stream per feed and replaces it when the workspace changes', () => {
    const { Live, stores } = loadPanelLive();
    const live = Live.create({ runtime: {}, shownQueue: () => ({}) });
    live.update(grant());
    live.update(grant());
    expect(stores).toHaveLength(1);
    live.update(grant('44444444-4444-4444-8444-444444444444'));
    expect(stores).toHaveLength(2);
    expect(stores[0]!.stopped).toBe(1);
  });

  it('stops for good when the server halts the feed, until the halt can have lapsed', () => {
    const { Live, stores } = loadPanelLive();
    let now = 1_000;
    const statuses: string[] = [];
    const live = Live.create({ runtime: {}, shownQueue: () => ({}), onStatus: (s: string) => statuses.push(s), now: () => now });
    live.update(grant());
    stores[0]!.emit({ connection: 'live', error: null, data: null });
    stores[0]!.emit({ connection: 'live', error: 'live_refresh_metered: get_pending_decisions was billed', data: null });
    expect(stores[0]!.stopped).toBe(1);
    expect(live.status()).toBe('off');
    expect(statuses).toEqual(['live', 'off']);

    live.update(grant());
    expect(stores).toHaveLength(1);
    now += 11 * 60 * 1000;
    live.update(grant());
    expect(stores).toHaveLength(2);
  });

  it('refreshes its token by re-reading the panel and hands that snapshot over', async () => {
    const { Live, stores } = loadPanelLive();
    const next = grant();
    const snapshot = vi.fn();
    const runtime = {
      callToolResult: vi.fn(async () => ({ data: { schema: 'orgx.panel.v1', live: next }, meta: null })),
    };
    const live = Live.create({ runtime, shownQueue: () => ({}), onSnapshot: snapshot });
    live.update(grant());
    const refreshed = await (stores[0]!.options.refreshToken as () => Promise<unknown>)();
    expect(runtime.callToolResult).toHaveBeenCalledWith('orgx_panel_snapshot', {});
    expect(refreshed).toBe(next);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('refreshes its token with the panel\'s current read, so the selection stays put', async () => {
    const { Live, stores } = loadPanelLive();
    const runtime = { callToolResult: vi.fn(async () => ({ data: { live: grant() } })) };
    const live = Live.create({
      runtime,
      shownQueue: () => ({}),
      refreshArgs: () => ({ focus: { type: 'decision', id: D2 }, view: 'work' }),
    });
    live.update(grant());
    await (stores[0]!.options.refreshToken as () => Promise<unknown>)();
    expect(runtime.callToolResult).toHaveBeenCalledWith('orgx_panel_snapshot', {
      focus: { type: 'decision', id: D2 },
      view: 'work',
    });
  });

  it('ignores a poll whose agent read failed instead of reporting no work', () => {
    const { Live, stores } = loadPanelLive();
    const work = vi.fn();
    const live = Live.create({ runtime: {}, shownQueue: () => ({}), onWork: work });
    live.update(grant());
    stores[0]!.emit(graphState({}, { t1: 'running' }));
    const unavailable = graphState({});
    (unavailable.data.nodes as Array<Record<string, unknown>>).push({ id: 'meta:work-unavailable', phase: 'pending' });
    stores[0]!.emit(unavailable);
    stores[0]!.emit(graphState({}, { t1: 'running' }));
    expect(work.mock.calls.map((c) => c[1])).toEqual([false, false]);
  });

  it('stays off without EventSource, leaving the panel on refresh-when-visible', () => {
    const { Live, stores } = loadPanelLive(false);
    const live = Live.create({ runtime: {}, shownQueue: () => ({}) });
    live.update(grant());
    expect(stores).toHaveLength(0);
    expect(live.status()).toBe('off');
  });
});

describe('start versus plan prompts', () => {
  function loadLaunch() {
    const scope: Record<string, any> = {};
    new Function('globalThis', 'window', readSharedScript('panel/panel-launch.js')).call(scope, scope, scope);
    return scope.OrgXPanelLaunch;
  }

  it('offers plan only for a named initiative, so it never doubles as "start"', () => {
    const Launch = loadLaunch();
    const keys = (ctx: Record<string, unknown>) => Launch.prompts('calm', ctx).map((p: { key: string }) => p.key);
    expect(keys({})).not.toContain('plan');
    expect(keys({})).toContain('launch');
    expect(keys({ initiative: 'OrgX Live' })).toContain('plan');
  });

  it('says start creates something new and plan changes nothing until accepted', () => {
    const Launch = loadLaunch();
    const byKey = Object.fromEntries(
      Launch.prompts('calm', { initiative: 'OrgX Live' }).map((p: { key: string }) => [p.key, p])
    );
    expect(byKey.launch.does).toMatch(/creates a new initiative/i);
    expect(byKey.plan.text).toContain('OrgX Live');
    expect(byKey.plan.does).toMatch(/nothing changes until you accept/i);
    expect(byKey.launch.does).not.toMatch(/plan/i);
  });
});

describe('panel workspaces view', () => {
  it('lists valid workspaces once each, current first, and reports a failed read as unavailable', async () => {
    const { buildPanelWorkspaces } = await import('../src/panelSurface');
    const list = buildPanelWorkspaces(
      [
        { id: D1, name: 'Zeta' },
        { id: WS, title: 'Acme' },
        { id: D1, name: 'Zeta again' },
        { id: 'not-a-uuid', name: 'Skip' },
        { id: D2, name: 'Beta' },
      ],
      WS
    );
    expect(list).toEqual({
      status: 'ok',
      items: [
        { id: WS, name: 'Acme', current: true },
        { id: D2, name: 'Beta', current: false },
        { id: D1, name: 'Zeta', current: false },
      ],
    });
    expect(buildPanelWorkspaces(null, WS)).toEqual({ status: 'unavailable', items: [] });
  });
});

describe('queue item detail', () => {
  it('carries the question past the title so repeated rows can be told apart, and passes the schema', async () => {
    const { buildPanelSnapshot } = await import('../src/panelSurface');
    const { WIDGET_OUTPUT_SCHEMAS } = await import('../src/openaiOutputSchemas/widgets');
    const title = 'The OrgX floor stopped a merge action and is waiting for you.';
    const snapshot = buildPanelSnapshot({
      workspace: { id: WS, name: 'Acme' },
      decisions: [
        { id: D1, summary: title, created_at: '2026-10-01T00:00:00Z', review_packet: { question: `${title} Command: gh pr merge 3236` } },
        { id: D2, summary: 'Ship it?', created_at: '2026-10-01T00:00:00Z' },
      ],
      artifacts: [],
    });
    const byId = Object.fromEntries(snapshot.queue.map((q) => [q.id, q]));
    expect(byId[D1]!.detail).toBe(`${title} Command: gh pr merge 3236`);
    // Nothing past the title: no detail, not a copy of the title.
    expect(byId[D2]!.detail).toBeNull();
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snapshot).success).toBe(true);
  });
});
