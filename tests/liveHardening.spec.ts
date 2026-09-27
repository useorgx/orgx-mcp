// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildWorkGraph, type WorkNode } from '../src/live/workGraph';
import { applyDelta, diffGraphs, nodeChanged } from '../src/live/delta';
import { FEEDS } from '../src/live/feedRegistry';

/**
 * Regressions for defects an adversarial review of this branch turned up. Each
 * one was reproduced before being fixed; the comments say what the failure
 * actually looked like, because several of them fail silently in production.
 */

const SHARED = join(__dirname, '..', 'public', 'widgets', 'shared');

function loadShared(): Record<string, any> {
  const scope = window as unknown as Record<string, any>;
  for (const key of ['OrgXLiveMachine', 'OrgXLiveStore', 'OrgXLivePanel']) {
    delete scope[key];
  }
  for (const file of ['live-machine.js', 'live-store.js', 'live-panel.js']) {
    window.eval(readFileSync(join(SHARED, file), 'utf8'));
  }
  return scope;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="mount"></div>';
});

describe('the stream response is returned before anything is written', () => {
  it('a TransformStream write does not resolve until the readable is consumed', async () => {
    // The premise, pinned down because it is unintuitive: the Durable Object
    // used to `await writer.write(...)` for its first snapshot *before*
    // returning `new Response(readable)`. Nothing was reading yet, so the write
    // never resolved and a cold connection never completed at all.
    const { writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const settled = vi.fn();
    void writer.write(new TextEncoder().encode('data: x\n\n')).then(settled);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).not.toHaveBeenCalled();
  });

  it('the DO hands its backfill to waitUntil rather than awaiting it inline', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'liveFeedDO.ts'), 'utf8');
    const handle = source.slice(
      source.indexOf('private async handleStream('),
      source.indexOf('private async backfill(')
    );
    // No awaited write may appear before the response is constructed.
    expect(handle).not.toMatch(/await this\.writeTo\(/);
    expect(handle).toContain('this.ctx.waitUntil(this.backfill(');
  });
});

describe('heartbeats reach the client', () => {
  it('the DO sends a named event, not a comment line', () => {
    // EventSource discards `: comment` lines entirely, so a comment heartbeat
    // never reaches the page: a healthy feed with no news went stale every 45s
    // and reconnected in a loop.
    const source = readFileSync(join(__dirname, '..', 'src', 'liveFeedDO.ts'), 'utf8');
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
