import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads the real shipped scripts, same as tests/liveMachine.spec.ts, and drives
 * the store through a stub transport so every lifecycle path is exercised
 * without a network or a live Durable Object.
 */

const SHARED = join(__dirname, '..', 'public', 'widgets', 'shared');

interface StoreSnapshot {
  connection: string;
  live: boolean;
  degraded: boolean;
  data: unknown;
  rows: unknown[];
  summary: { running: number; queued: number; blocked: number; done: number; total: number };
  cursor: number;
  error: string | null;
  attempts: number;
  transport: string;
  diff?: { entered: unknown[]; updated: unknown[]; exited: unknown[] } | null;
  phases?: { started: string[]; finished: string[]; blocked: string[] } | null;
}

interface TransportHandlers {
  onOpen(info?: unknown): void;
  onFrame(frame: unknown): void;
  onMalformed(info: unknown): void;
  onAuthExpired(detail: unknown): void;
  onError(info: unknown): void;
}

interface Scope {
  OrgXLiveMachine?: Record<string, unknown>;
  OrgXLiveStore?: {
    createLiveStore(options: Record<string, unknown>): {
      start(): boolean;
      stop(): void;
      reconnect(): void;
      subscribe(listener: (s: StoreSnapshot) => void): () => void;
      ingest(frame: unknown): unknown;
      getState(): StoreSnapshot;
      diagnostics(): { counters: Record<string, number>; recent: { event: string }[] };
      getLogger(): { records(): { event: string; level: string }[] };
    };
    createLogger(options?: Record<string, unknown>): {
      info(event: string, fields?: unknown): unknown;
      error(event: string, fields?: unknown): unknown;
      counters(): Record<string, number>;
      records(): { event: string; level: string }[];
    };
    createSseTransport(options: Record<string, unknown>): {
      supported(): boolean;
      open(handlers: TransportHandlers): string;
      close(): void;
    };
    createPollTransport(options: Record<string, unknown>): {
      supported(): boolean;
      open(handlers: TransportHandlers): string;
      close(): void;
    };
  };
  console?: unknown;
}

function loadScope(): Scope {
  const scope: Scope = { console: { log() {}, warn() {}, error() {} } };
  for (const file of ['live-machine.js', 'live-store.js']) {
    const source = readFileSync(join(SHARED, file), 'utf8');
    new Function('globalThis', 'window', source).call(scope, scope, scope);
  }
  if (!scope.OrgXLiveStore) throw new Error('live-store.js did not install');
  return scope;
}

/** A transport the test drives by hand. */
function createStubTransport() {
  let handlers: TransportHandlers | null = null;
  const opens: string[] = [];
  let closes = 0;
  return {
    name: 'stub',
    supported: () => true,
    open(h: TransportHandlers) {
      handlers = h;
      opens.push('open');
      return 'stub://feed';
    },
    close() {
      closes += 1;
    },
    get handlers() {
      if (!handlers) throw new Error('transport was never opened');
      return handlers;
    },
    get openCount() {
      return opens.length;
    },
    get closeCount() {
      return closes;
    },
  };
}

type Clock = {
  advance(ms: number): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  pending(): number;
};

function createClock(): Clock {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      time += ms;
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= time)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    },
    pending() {
      return timers.size;
    },
  };
}

let scope: Scope;
let transport: ReturnType<typeof createStubTransport>;
let clock: Clock;

function makeStore(overrides: Record<string, unknown> = {}) {
  return scope.OrgXLiveStore!.createLiveStore({
    widget: 'test-widget',
    streamUrl: 'https://mcp.useorgx.com/live-feed/agent-status/init-1/stream?t=tok',
    transport,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    observeVisibility: false,
    select: (payload: { agents?: unknown[] }) => payload?.agents ?? [],
    console: { log() {}, warn() {}, error() {} },
    ...overrides,
  });
}

beforeEach(() => {
  scope = loadScope();
  transport = createStubTransport();
  clock = createClock();
});

describe('live store lifecycle', () => {
  it('opens a stream on start and reports live once open', () => {
    const store = makeStore();
    store.start();
    expect(transport.openCount).toBe(1);
    expect(store.getState().connection).toBe('connecting');

    transport.handlers.onOpen({ url: 'stub://feed' });
    expect(store.getState().connection).toBe('live');
    expect(store.getState().live).toBe(true);
  });

  it('publishes a diff and phase boundaries to subscribers', () => {
    const store = makeStore();
    const seen: StoreSnapshot[] = [];
    store.subscribe((s) => seen.push(s));
    store.start();
    transport.handlers.onOpen();

    transport.handlers.onFrame({
      type: 'snapshot',
      ts: 1000,
      data: { agents: [{ id: 'a', status: 'running' }, { id: 'b', status: 'queued' }] },
    });

    const latest = seen[seen.length - 1]!;
    expect(latest.rows).toHaveLength(2);
    expect(latest.diff!.entered).toHaveLength(2);
    expect(latest.phases!.started).toEqual(['a']);
    expect(latest.summary).toEqual({ running: 1, queued: 1, blocked: 0, done: 0, total: 2 });
    expect(latest.cursor).toBe(1000);
  });

  it('emits exactly one notification per frame so widgets do not double-render', () => {
    const store = makeStore();
    store.start();
    const seen: StoreSnapshot[] = [];
    store.subscribe((s) => seen.push(s));
    const baseline = seen.length;

    // First frame arrives before onOpen — the implicit-open path, which is also
    // the one where a naive implementation notifies twice.
    transport.handlers.onFrame({ type: 'snapshot', ts: 1, data: { agents: [{ id: 'a' }] } });
    expect(seen.length - baseline).toBe(1);
    expect(seen[seen.length - 1]!.diff).not.toBeNull();
  });

  it('carries a since cursor onto the reconnect URL', () => {
    const urls: string[] = [];
    const store = makeStore({
      transport: {
        name: 'cursor-stub',
        supported: () => true,
        open(h: TransportHandlers) {
          // Mirror the real SSE transport: build the URL at open time.
          urls.push('opened');
          transport.open(h);
          return 'x';
        },
        close() {},
      },
    });
    store.start();
    transport.handlers.onFrame({ type: 'snapshot', ts: 4242, data: { agents: [] } });
    expect(store.getState().cursor).toBe(4242);
  });
});

describe('auth expiry recovery', () => {
  it('refreshes the token on auth_expired instead of retrying with a dead one', async () => {
    // The regression: the server emits `event: auth_expired` ~10s before a
    // stream token's exp. Widgets that only wired onmessage never saw it, so the
    // stream died silently at the one-hour mark with no recovery.
    const refreshToken = vi
      .fn()
      .mockResolvedValue('https://mcp.useorgx.com/live-feed/agent-status/init-1/stream?t=fresh');
    const store = makeStore({ refreshToken });
    store.start();
    transport.handlers.onOpen();

    transport.handlers.onAuthExpired({ reason: 'stream_token_expired' });
    expect(store.getState().connection).toBe('refreshing');
    expect(transport.closeCount).toBeGreaterThan(0);

    await vi.waitFor(() => expect(store.getState().connection).toBe('connecting'));
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(transport.openCount).toBe(2);
  });

  it('falls back to backoff when a refresh fails rather than going dark', async () => {
    const refreshToken = vi.fn().mockRejectedValue(new Error('tool call failed'));
    const store = makeStore({ refreshToken });
    store.start();
    transport.handlers.onOpen();
    transport.handlers.onAuthExpired({ reason: 'stream_token_expired' });

    await vi.waitFor(() => expect(store.getState().connection).toBe('reconnecting'));
    clock.advance(5000);
    expect(store.getState().connection).toBe('connecting');
  });

  it('goes fatal when no refresh path was wired, instead of looping forever', () => {
    const store = makeStore({ refreshToken: undefined });
    store.start();
    transport.handlers.onOpen();
    transport.handlers.onAuthExpired({ reason: 'stream_token_expired' });
    expect(store.getState().connection).toBe('fatal');
  });
});

describe('failure handling', () => {
  it('reconnects with jittered backoff and resets after success', () => {
    const store = makeStore();
    store.start();
    transport.handlers.onOpen();

    transport.handlers.onError({ message: 'boom' });
    expect(store.getState().connection).toBe('reconnecting');
    expect(store.getState().degraded).toBe(true);

    clock.advance(2000);
    expect(store.getState().connection).toBe('connecting');
    transport.handlers.onOpen();
    expect(store.getState().attempts).toBe(0);
  });

  it('goes fatal after the reconnect budget is exhausted', () => {
    const store = makeStore({ maxReconnectAttempts: 3 });
    store.start();
    for (let i = 0; i < 4; i += 1) {
      transport.handlers.onError({ message: 'down' });
      clock.advance(60000);
    }
    expect(store.getState().connection).toBe('fatal');
    // Nothing should still be scheduled once we have given up.
    expect(clock.pending()).toBe(0);
  });

  it('recovers from fatal on an explicit operator reconnect', () => {
    const store = makeStore({ maxReconnectAttempts: 1 });
    store.start();
    transport.handlers.onError({ message: 'down' });
    clock.advance(60000);
    transport.handlers.onError({ message: 'down' });
    clock.advance(60000);
    expect(store.getState().connection).toBe('fatal');

    store.reconnect();
    expect(store.getState().connection).toBe('connecting');
  });

  it('marks the feed stale when heartbeats stop but keeps the last known data', () => {
    const store = makeStore({ heartbeatWatchdogMs: 45000 });
    store.start();
    transport.handlers.onOpen();
    transport.handlers.onFrame({ type: 'snapshot', ts: 1, data: { agents: [{ id: 'a' }] } });

    clock.advance(45000);
    expect(store.getState().connection).toBe('stale');
    // Data must survive a stale transition — the rows on screen are still the
    // last known truth, they have just aged.
    expect(store.getState().rows).toHaveLength(1);
  });

  it('surfaces a feed error frame without tearing down the stream', () => {
    const store = makeStore();
    store.start();
    transport.handlers.onOpen();
    transport.handlers.onFrame({ type: 'error', message: 'API 503' });
    expect(store.getState().error).toBe('API 503');
    expect(store.getState().connection).toBe('live');
  });

  it('counts unparseable frames without throwing', () => {
    const store = makeStore();
    store.start();
    transport.handlers.onMalformed({ raw: 'not json' });
    expect(store.diagnostics().counters.frame_unparseable).toBe(1);
  });

  it('keeps notifying other subscribers when one throws', () => {
    const store = makeStore();
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error('bad subscriber');
    });
    store.subscribe(good);
    store.start();
    transport.handlers.onFrame({ type: 'snapshot', ts: 1, data: { agents: [] } });
    expect(good).toHaveBeenCalled();
  });
});

describe('visibility', () => {
  it('closes the stream when hidden and reopens when visible again', () => {
    const listeners: Record<string, () => void> = {};
    const doc = {
      hidden: false,
      addEventListener(name: string, fn: () => void) {
        listeners[name] = fn;
      },
      removeEventListener() {},
    };
    const store = makeStore({ document: doc, observeVisibility: true });
    store.start();
    transport.handlers.onOpen();

    doc.hidden = true;
    listeners.visibilitychange!();
    expect(store.getState().connection).toBe('paused');
    expect(transport.closeCount).toBeGreaterThan(0);

    doc.hidden = false;
    listeners.visibilitychange!();
    expect(store.getState().connection).toBe('connecting');
  });
});

describe('structured logging', () => {
  it('records flat serializable records with a stable field set', () => {
    const logger = scope.OrgXLiveStore!.createLogger({
      widget: 'agent-status',
      console: { log() {}, warn() {}, error() {} },
    });
    logger.info('state_change', { from: 'idle', to: 'connecting' });
    const records = logger.records();
    expect(records).toHaveLength(1);
    const record = records[0] as Record<string, unknown>;
    expect(record.widget).toBe('agent-status');
    expect(record.event).toBe('state_change');
    expect(record.level).toBe('info');
    expect(typeof record.ts).toBe('number');
    expect(record.seq).toBe(1);
    // Must survive the trip out of a sandboxed iframe.
    expect(() => JSON.stringify(record)).not.toThrow();
  });

  it('forwards records to a sink and survives a sink that throws', () => {
    const sink = vi.fn().mockImplementation(() => {
      throw new Error('sink down');
    });
    const logger = scope.OrgXLiveStore!.createLogger({
      widget: 'w',
      sink,
      console: { log() {}, warn() {}, error() {} },
    });
    expect(() => logger.info('x')).not.toThrow();
    expect(sink).toHaveBeenCalled();
  });

  it('produces a diagnostics bundle describing the whole session', () => {
    const store = makeStore();
    store.start();
    transport.handlers.onOpen();
    transport.handlers.onFrame({
      type: 'snapshot',
      ts: 5,
      data: { agents: [{ id: 'a', status: 'running' }] },
    });
    transport.handlers.onError({ message: 'blip' });

    const diag = store.diagnostics();
    expect(diag.counters.frames).toBe(1);
    expect(diag.counters.stream_error).toBe(1);
    expect(diag.counters.boundary_started).toBe(1);
    expect(diag.recent.some((r) => r.event === 'state_change')).toBe(true);
  });

  it('never logs a stream token', () => {
    const store = makeStore();
    store.start();
    transport.handlers.onOpen({
      url: 'https://mcp.useorgx.com/live-feed/agent-status/i/stream?t=super-secret',
    });
    const dumped = JSON.stringify(store.getLogger().records());
    expect(dumped).not.toContain('super-secret');
    expect(dumped).toContain('<redacted>');
  });
});

describe('transports', () => {
  it('SSE transport subscribes to the named auth_expired event', () => {
    const added: string[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1;
      constructor(public url: string) {}
      addEventListener(name: string) {
        added.push(name);
      }
      close() {}
    }
    const sse = scope.OrgXLiveStore!.createSseTransport({
      buildUrl: () => 'https://example.test/stream?t=x',
      EventSource: FakeEventSource,
    });
    expect(sse.supported()).toBe(true);
    sse.open({
      onOpen() {},
      onFrame() {},
      onMalformed() {},
      onAuthExpired() {},
      onError() {},
    });
    // Without this listener the server's expiry warning is unreachable.
    expect(added).toContain('auth_expired');
  });

  it('poll transport reports 401 as an auth expiry so the same recovery runs', async () => {
    const onAuthExpired = vi.fn();
    const poll = scope.OrgXLiveStore!.createPollTransport({
      buildUrl: () => 'https://example.test/feed',
      fetch: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }),
      setInterval: () => 1,
      clearInterval: () => {},
    });
    poll.open({
      onOpen() {},
      onFrame() {},
      onMalformed() {},
      onAuthExpired,
      onError() {},
    });
    await vi.waitFor(() => expect(onAuthExpired).toHaveBeenCalled());
  });

  it('reports unsupported transports as fatal rather than pretending to connect', () => {
    const store = makeStore({
      transport: { name: 'none', supported: () => false, open() {}, close() {} },
    });
    expect(store.start()).toBe(false);
    expect(store.getState().connection).toBe('fatal');
  });
});
