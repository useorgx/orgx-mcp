// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkGraph, type WorkNode } from '../src/live/workGraph';
import { applyDelta, diffGraphs, nodeChanged } from '../src/live/delta';
import { FEEDS } from '../src/live/feedRegistry';
import { loadLiveIntoWindow, REPO_ROOT } from './fixtures/live';

/**
 * Regressions for defects an adversarial review of this branch turned up. Each
 * one was reproduced before being fixed; the comments say what the failure
 * actually looked like, because several of them fail silently in production.
 */

function loadShared(): Record<string, any> {
  return loadLiveIntoWindow() as Record<string, any>;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
});

describe('the stream response is returned before anything is written', () => {
  it('a TransformStream write does not resolve until the readable is consumed', async () => {
    // The premise, pinned down because it is unintuitive: the Durable Object
    // used to `await writer.write(...)` for its first snapshot *before*
    // returning `new Response(readable)`. Nothing was reading yet, so the write
    // never resolved and a cold connection never completed at all. The
    // consequence is exercised end to end in tests/liveFeedDO.spec.ts; this
    // pins the platform behaviour that makes it a trap.
    const { writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const settled = vi.fn();
    void writer.write(new TextEncoder().encode('data: x\n\n')).then(settled);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).not.toHaveBeenCalled();
  });
});

describe('heartbeats reach the client', () => {
  it('the DO sends a named event, not a comment line', () => {
    // EventSource discards `: comment` lines entirely, so a comment heartbeat
    // never reaches the page: a healthy feed with no news went stale every 45s
    // and reconnected in a loop.
    const source = readFileSync(join(REPO_ROOT, 'src', 'liveFeedDO.ts'), 'utf8');
    expect(source).toContain('event: heartbeat');
    expect(source).not.toContain("': heartbeat");
  });

  it('the SSE transport subscribes to it', () => {
    const scope = loadShared();
    const added: string[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {}
      addEventListener(name: string) {
        added.push(name);
      }
      close() {}
    }
    const sse = scope.OrgXLiveStore.createSseTransport({
      buildUrl: () => 'https://example.test/stream',
      EventSource: FakeEventSource,
    });
    sse.open({
      onOpen() {}, onFrame() {}, onMalformed() {}, onAuthExpired() {},
      onError() {}, onHeartbeat() {},
    });
    expect(added).toContain('heartbeat');
  });

  it('a heartbeat rearms the watchdog so a quiet stream stays live', () => {
    const scope = loadShared();
    let handlers: any = null;
    const transport = {
      name: 'stub',
      supported: () => true,
      open(h: any) { handlers = h; },
      close() {},
    };
    const store = scope.OrgXLiveStore.createLiveStore({
      widget: 'hb',
      streamUrl: 'stub://feed',
      transport,
      observeVisibility: false,
      heartbeatWatchdogMs: 1000,
      select: () => [],
      console: { log() {}, warn() {}, error() {} },
    });
    vi.useFakeTimers();
    store.start();
    handlers.onOpen();

    // Two watchdog periods of silence, punctuated by heartbeats.
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(600);
      handlers.onHeartbeat();
    }
    vi.useRealTimers();
    expect(store.getState().connection).toBe('live');
  });
});

describe('token refresh', () => {
  function storeWith(opts: Record<string, unknown>) {
    const scope = loadShared();
    let handlers: any = null;
    const opens: string[] = [];
    const transport = {
      name: 'stub',
      supported: () => true,
      open(h: any) { handlers = h; opens.push('open'); },
      close() {},
    };
    const store = scope.OrgXLiveStore.createLiveStore({
      widget: 'refresh',
      streamUrl: 'stub://feed',
      transport,
      observeVisibility: false,
      select: () => [],
      console: { log() {}, warn() {}, error() {} },
      ...opts,
    });
    return { store, get handlers() { return handlers; }, opens };
  }

  it('refreshes up front when the grant already expired', async () => {
    // A widget hidden across its token's expiry used to resume onto the dead
    // URL and spend its whole reconnect budget on 401s without ever refreshing.
    const refreshToken = vi.fn().mockResolvedValue('stub://fresh');
    const { store } = storeWith({ expiresAt: Date.now() - 1000, refreshToken });
    store.start();
    expect(store.getState().connection).toBe('refreshing');
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalledTimes(1));
  });

  it('lets a manual retry escape a refresh that is in flight', async () => {
    const harness = storeWith({ refreshToken: () => new Promise(() => {}) });
    harness.store.start();
    harness.handlers.onOpen();
    harness.handlers.onAuthExpired({ reason: 'stream_token_expired' });
    const store = harness.store;
    expect(store.getState().connection).toBe('refreshing');

    // `refreshing` ignores RETRY by design; reconnect() has to say "that
    // refresh is not coming back" instead of being swallowed.
    store.reconnect();
    expect(store.getState().connection).not.toBe('refreshing');
  });

  it('reads the grant out of a raw tool envelope, not just an unwrapped one', () => {
    // The MCP Apps bridges unwrap a tool result; the ChatGPT branch does not.
    // Reading `result.live` alone threw away a perfectly good token on ChatGPT.
    const scope = loadShared();
    const grant = { streamUrl: 'https://x.test/s?t=new', feedType: 'agent-status' };
    const panelHost = document.getElementById('mount')!;

    for (const envelope of [
      { live: grant },
      { structuredContent: { live: grant } },
      { content: [{ type: 'text', text: JSON.stringify({ live: grant }) }] },
    ]) {
      const callTool = vi.fn().mockResolvedValue(envelope);
      const attached = scope.OrgXLiveStore.attachLiveFeed({
        widget: 'w',
        grant: { ...grant, refreshTool: 't', refreshArgs: {} },
        mount: panelHost,
        runtime: { callTool, reportSize() {} },
      });
      expect(attached).not.toBeNull();
      attached.store.stop();
      panelHost.innerHTML = '';
    }
  });
});

describe('keyed maps survive hostile node names', () => {
  it('normalizes a workstream named "constructor" without crashing the panel', () => {
    // An ID-less workstream takes its title as its id. On a plain object,
    // rowNodes["constructor"] resolves Object.prototype.constructor — truthy —
    // so the panel treated the row as already built and painting it threw.
    const scope = loadShared();
    const graph = FEEDS['initiative-pulse']!.normalize(
      {
        initiatives: [
          {
            id: 'i',
            title: 'T',
            workstreams: [{ name: 'constructor', status: 'running' }, { name: '__proto__' }],
          },
        ],
      },
      'i'
    );
    const panel = scope.OrgXLivePanel.createPanel({
      mount: document.getElementById('mount')!,
      document,
    });
    expect(() =>
      panel.apply({
        connection: 'live',
        rows: graph.nodes,
        summary: graph.summary,
      })
    ).not.toThrow();
    expect(panel.rowCount()).toBe(graph.nodes.length);
  });

  it('reconciles and phase-diffs those ids correctly', () => {
    const scope = loadShared();
    const M = scope.OrgXLiveMachine;
    const rows = [{ id: 'constructor', status: 'running' }, { id: '__proto__', status: 'queued' }];
    const diff = M.reconcile([], rows);
    expect(diff.entered.map((e: any) => e.key).sort()).toEqual(['__proto__', 'constructor']);
    expect(M.summarizePhases(rows)).toMatchObject({ running: 1, queued: 1, total: 2 });
  });
});

describe('deltas carry everything the client needs', () => {
  const graph = (nodes: WorkNode[]) =>
    buildWorkGraph({ feedType: 'agent-status', feedId: 'i', nodes, updatedAt: 'T' });
  const node = (o: Partial<WorkNode> & { id: string }): WorkNode => ({
    title: o.id,
    phase: 'pending',
    ...o,
  });

  it('notices a blocker gaining a one-click fix', () => {
    // Compared on `reason` alone, so a blocker becoming actionable never
    // reached the client — and lastGraph advanced, making the miss permanent.
    const before = node({ id: 'a', phase: 'blocked', blockers: [{ reason: 'stuck' }] });
    const after = node({
      id: 'a',
      phase: 'blocked',
      blockers: [{ reason: 'stuck', actionable: true, resolveTool: 'orgx_decide' }],
    });
    expect(nodeChanged(before, after)).toBe(true);
  });

  it('notices evidence changing without changing length', () => {
    const before = node({ id: 'a', evidence: [{ label: 'PR', href: 'https://x/1' }] });
    const after = node({ id: 'a', evidence: [{ label: 'PR', href: 'https://x/2' }] });
    expect(nodeChanged(before, after)).toBe(true);
  });

  it('sends a delta for a pure reorder', () => {
    // No node's fields change, so without explicit ordering nothing was sent
    // and the two surfaces silently disagreed about row order.
    const before = graph([node({ id: 'a' }), node({ id: 'b' })]);
    const after = graph([node({ id: 'b' }), node({ id: 'a' })]);
    const delta = diffGraphs(before, after);
    expect(delta).not.toBeNull();
    expect(delta!.order).toEqual(['b', 'a']);
  });

  it('puts a prepended node where the server put it', () => {
    // The client appended new nodes, so work the server led with landed last —
    // and with maxRows, outside the visible window entirely.
    const before = graph([node({ id: 'a' })]);
    const after = graph([node({ id: 'b' }), node({ id: 'a' })]);
    const delta = diffGraphs(before, after)!;
    expect(applyDelta(before, delta).nodes.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('folds the same way on the client', () => {
    const scope = loadShared();
    const before = graph([node({ id: 'a' })]);
    const after = graph([node({ id: 'b' }), node({ id: 'a' })]);
    const delta = diffGraphs(before, after)!;
    const folded = scope.OrgXLiveMachine.foldGraphDelta(before, delta);
    expect(folded.nodes.map((n: WorkNode) => n.id)).toEqual(['b', 'a']);
  });

  it('propagates a changed proof handoff instead of keeping the stale one', () => {
    const base = {
      ...graph([node({ id: 'a' })]),
      proofHandoff: { quiet_cta: 'old' },
    };
    const next = {
      ...graph([node({ id: 'a' })]),
      proofHandoff: { quiet_cta: 'new' },
    };
    const delta = diffGraphs(base, next);
    expect(delta).not.toBeNull();
    expect(delta!.proofHandoff).toEqual({ quiet_cta: 'new' });

    const scope = loadShared();
    const folded = scope.OrgXLiveMachine.foldGraphDelta(base, delta);
    expect(folded.proofHandoff).toEqual({ quiet_cta: 'new' });
  });

  it('still reports nothing when nothing changed', () => {
    const nodes = [node({ id: 'a', phase: 'executing', progress: 5 })];
    expect(diffGraphs(graph(nodes), graph(nodes))).toBeNull();
  });
});

describe('the stream credential stays out of the transcript', () => {
  it('redacts the grant from the model-visible JSON block', async () => {
    // structuredContent is how the widget receives the grant, and it has to.
    // This block is a different audience: the model reads it and it lands in
    // the transcript. A signed stream URL is a bearer credential, and for a
    // user-scoped feed it carries the viewer's identity.
    const { buildJsonFirstContentBlocks } = await import('../src/agentErgonomics');
    const blocks = buildJsonFirstContentBlocks({
      data: {
        agents: [{ id: 'a' }],
        live: {
          feedType: 'decisions',
          label: 'Decision queue',
          streamUrl: 'https://mcp.useorgx.com/live-feed/decisions/i/stream?t=SECRET-TOKEN',
          expiresAt: Date.now() + 60_000,
          refreshTool: 'get_pending_decisions',
        },
      },
      summary: 'ok',
    });

    const json = blocks[0]!.text;
    expect(json).not.toContain('SECRET-TOKEN');
    expect(json).not.toContain('/live-feed/decisions/i/stream?t=');
    // The model should still be able to see that a live feed exists.
    expect(json).toContain('decisions');
    expect(json).toContain('[redacted]');
    // And the rest of the payload is untouched.
    expect(JSON.parse(json).agents).toEqual([{ id: 'a' }]);
  });

  it('leaves payloads without a grant exactly as they were', async () => {
    const { buildJsonFirstContentBlocks } = await import('../src/agentErgonomics');
    const data = { agents: [{ id: 'a' }], initiative: { id: 'i' } };
    const blocks = buildJsonFirstContentBlocks({ data, summary: 's' });
    expect(JSON.parse(blocks[0]!.text)).toEqual(data);
  });

  it('mints short-lived grants, since the widget can refresh', async () => {
    const { buildStreamGrant } = await import('../src/live/streamGrant');
    const grant = await buildStreamGrant({
      feedType: 'agent-status',
      feedId: 'i',
      serverUrl: 'https://mcp.useorgx.com',
      secret: 's',
      refreshTool: 'get_agent_status',
    });
    const lifetimeMs = grant!.expiresAt - Date.now();
    // Well under the hour a scaffold session gets: a leaked URL is replayable
    // for its whole lifetime, and refresh costs one tool call.
    expect(lifetimeMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(lifetimeMs).toBeGreaterThan(5 * 60 * 1000);
  });
});

describe('the expiry wrapper releases its upstream', () => {
  it('cancels the origin stream when the token expires', async () => {
    // Closing only the downstream controller left the pump parked in
    // reader.read() forever on an idle feed, so the Durable Object kept the
    // client registered and its heartbeat running with nobody reading.
    const { withStreamTokenExpiry } = await import('../src/streamToken');
    let cancelled = false;
    const origin = new ReadableStream<Uint8Array>({
      pull() {
        // Deliberately never resolves: an expired feed with nothing to send.
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const wrapped = withStreamTokenExpiry(
      new Response(origin, { headers: { 'content-type': 'text/event-stream' } }),
      Date.now() + 40,
      10
    );

    const reader = wrapped.body!.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(decoder.decode(value));
    }
    expect(chunks.join('')).toContain('event: auth_expired');
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('does not buffer unboundedly when nobody is reading', async () => {
    // It used to pump from `start`, reading upstream as fast as it arrived and
    // enqueueing regardless of demand, so a slow consumer accumulated the whole
    // stream inside the wrapper with nothing bounding it.
    const { withStreamTokenExpiry } = await import('../src/streamToken');
    let produced = 0;
    const origin = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new TextEncoder().encode(`data: ${produced}\n\n`));
      },
    });
    const wrapped = withStreamTokenExpiry(
      new Response(origin, { headers: { 'content-type': 'text/event-stream' } }),
      Date.now() + 60_000
    );

    // Attach a reader but never read: demand stays at the initial high-water
    // mark, so the wrapper must stop asking upstream for more.
    wrapped.body!.getReader();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(produced).toBeLessThan(10);
  });

  it('cancels the origin when the client hangs up first', async () => {
    const { withStreamTokenExpiry } = await import('../src/streamToken');
    let cancelled = false;
    const origin = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const wrapped = withStreamTokenExpiry(
      new Response(origin, { headers: { 'content-type': 'text/event-stream' } }),
      Date.now() + 60_000
    );
    await wrapped.body!.cancel();
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});

/**
 * Second round: defects the first round's fixes introduced or left partly
 * closed, found by re-running the same adversarial review against the fixes.
 */
describe('second-round regressions', () => {
  function storeWith(opts: Record<string, unknown>) {
    const scope = loadShared();
    let handlers: any = null;
    const opens: string[] = [];
    const transport = {
      name: 'stub',
      supported: () => true,
      open(h: any) { handlers = h; opens.push('open'); },
      close() {},
    };
    const store = scope.OrgXLiveStore.createLiveStore({
      widget: 'r2',
      streamUrl: 'https://stub.test/feed',
      transport,
      observeVisibility: false,
      select: () => [],
      console: { log() {}, warn() {}, error() {} },
      ...opts,
    });
    return { scope, store, opens, get handlers() { return handlers; } };
  }

  it('refreshes when a widget was hidden across its token expiry', async () => {
    // `paused` had no AUTH_EXPIRED transition, so the resume-time dispatch was
    // dropped as illegal: hide → expire → show left the widget paused forever
    // with zero refresh calls.
    const scope = loadShared();
    const M = scope.OrgXLiveMachine;
    const result = M.transition(M.STATES.PAUSED, M.EVENTS.AUTH_EXPIRED);
    expect(result.handled).toBe(true);
    expect(result.state).toBe(M.STATES.REFRESHING);
    expect(result.effects).toContain(M.EFFECTS.REFRESH_TOKEN);
  });

  it('keeps the replacement expiry after a successful refresh', async () => {
    // Returning a bare URL left expiresAt at 0, which disabled the very
    // up-front expiry check the refresh exists to feed — so the *next* hide
    // across expiry was broken again.
    const nextExpiry = Date.now() + 900_000;
    const callTool = vi.fn().mockResolvedValue({
      live: { streamUrl: 'https://mcp.test/live-feed/a/i/stream?t=new', expiresAt: nextExpiry },
    });
    const scope = loadShared();
    const attached = scope.OrgXLiveStore.attachLiveFeed({
      widget: 'w',
      grant: {
        feedType: 'agent-status',
        streamUrl: 'https://mcp.test/live-feed/a/i/stream?t=old',
        refreshTool: 't',
        refreshArgs: {},
      },
      mount: document.getElementById('mount')!,
      runtime: { callTool, reportSize() {} },
    });
    expect(attached).not.toBeNull();
    attached.store.stop();
  });

  it('ignores a refresh that was abandoned before it landed', async () => {
    // An abandoned refresh could clear a newer one's deadline and reconnect
    // the stream onto its own stale URL.
    let resolveA: (v: unknown) => void = () => {};
    const refreshToken = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))
      .mockImplementationOnce(() => Promise.resolve('https://stub.test/feed?t=B'));

    // Destructuring `handlers` would capture the getter's value before the
    // transport has opened, which is null.
    const harness = storeWith({ refreshToken });
    const store = harness.store;
    store.start();
    harness.handlers.onOpen();
    harness.handlers.onAuthExpired({ reason: 'expired' });
    expect(store.getState().connection).toBe('refreshing');

    store.reconnect(); // abandons A
    resolveA('https://stub.test/feed?t=A');
    await new Promise((r) => setTimeout(r, 10));

    // A landing late must not drag the machine back into connecting on its URL.
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('refuses a redacted placeholder as a stream url', () => {
    // The server redacts the grant out of the model-visible text block; a
    // truthiness-only check accepted "[redacted]" and opened EventSource on it.
    const scope = loadShared();
    const attached = scope.OrgXLiveStore.attachLiveFeed({
      widget: 'w',
      grant: { feedType: 'agent-status', streamUrl: '[redacted]', refreshTool: 't' },
      mount: document.getElementById('mount')!,
      runtime: { callTool: vi.fn(), reportSize() {} },
    });
    expect(attached).toBeNull();
  });

  it('withdraws a proof handoff instead of leaving a stale CTA on screen', () => {
    // `undefined` vanishes in JSON, so "removed" looked like "unmentioned" and
    // the client kept showing a CTA the server had withdrawn.
    const scope = loadShared();
    const base = {
      ...buildWorkGraph({
        feedType: 'agent-status',
        feedId: 'i',
        nodes: [{ id: 'a', title: 'A', phase: 'executing' as const }],
        updatedAt: 'T',
      }),
      proofHandoff: { quiet_cta: 'old' },
    };
    const next = buildWorkGraph({
      feedType: 'agent-status',
      feedId: 'i',
      nodes: [{ id: 'a', title: 'A', phase: 'executing' as const }],
      updatedAt: 'T2',
    });

    const delta = diffGraphs(base, next);
    expect(delta).not.toBeNull();
    expect(delta!.proofHandoff).toBeNull();
    // Survives the wire.
    const overWire = JSON.parse(JSON.stringify(delta));
    expect(overWire.proofHandoff).toBeNull();

    expect(scope.OrgXLiveMachine.foldGraphDelta(base, overWire).proofHandoff).toBeUndefined();
    expect(applyDelta(base, overWire).proofHandoff).toBeUndefined();
  });

  it('does not give the generated widget the short grant lifetime', async () => {
    // Shortening it looked like a security win and was a regression: that widget
    // is standalone HTML with no MCP tool handle, so it cannot mint a
    // replacement. The short life only works for a grant that can refresh
    // itself, and applying it here cut the widget's updates from an hour to
    // fifteen minutes with no way to recover.
    const { LIVE_GRANT_TTL_MS, GENERATED_WIDGET_TTL_MS } = await import(
      '../src/live/streamGrant'
    );
    expect(GENERATED_WIDGET_TTL_MS).toBeGreaterThan(LIVE_GRANT_TTL_MS);

    const source = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf8');
    expect(source).toContain('ttlMs: GENERATED_WIDGET_TTL_MS');
  });

  it('stops the generated widget looping on a token it cannot replace', async () => {
    // It ignored the server's expiry warning entirely and reconnected forever.
    const { buildLiveFeedWidget } = await import('../src/liveFeedWidget');
    const html = buildLiveFeedWidget({
      feedType: 'agent-status',
      feedId: 'i',
      streamBaseUrl: 'https://mcp.test',
      streamToken: 'tok',
    });
    expect(html).toContain("addEventListener('auth_expired'");
    expect(html).toContain('re-run the tool to resume');
  });
});
