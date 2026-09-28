/**
 * Shared harness for the live-state tests.
 *
 * The live layer ships as plain scripts so widgets can load them directly, and
 * it is driven by SSE. Every suite that touches it therefore needs the same
 * three things: a fake EventSource, a way to evaluate the shipped scripts, and
 * a way to mount a real widget document. Five suites had grown their own copy,
 * each slightly different — one tracked `closed`, another did not; one captured
 * named listeners, another dropped them — so a fix to the harness only reached
 * whichever file the author happened to be in.
 *
 * Helpers here load the *shipped* files rather than a TypeScript port, because
 * a port is the thing under test drifting from the thing that ships.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(__dirname, '..', '..');
export const WIDGETS_DIR = join(REPO_ROOT, 'public', 'widgets');
export const SHARED_DIR = join(WIDGETS_DIR, 'shared');

/** The live scripts, in dependency order — the store and panel both assert the machine is installed. */
export const LIVE_SCRIPTS = ['live-machine.js', 'live-store.js', 'live-panel.js'] as const;

export function readSharedScript(name: string): string {
  return readFileSync(join(SHARED_DIR, name), 'utf8');
}

export function readWidgetHtml(name: string): string {
  return readFileSync(join(WIDGETS_DIR, `${name}.html`), 'utf8');
}

// ── Fake EventSource ────────────────────────────────────────────────────────

export interface SseFrame {
  data?: string;
}

/**
 * Stands in for the browser's EventSource.
 *
 * `addEventListener` is not optional decoration: `auth_expired` and `heartbeat`
 * are *named* SSE events, so a fake that only exposes `onmessage` cannot
 * observe either — which is exactly how the real bug went unnoticed.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  closed = false;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  listeners: Record<string, (event: SseFrame) => void> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (event: SseFrame) => void): void {
    this.listeners[name] = fn;
  }

  close(): void {
    this.closed = true;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  static get latest(): FakeEventSource {
    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!source) throw new Error('nothing opened a stream');
    return source;
  }

  /** Deliver an unnamed `message` frame, the way a snapshot or delta arrives. */
  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Deliver a named event, the way `auth_expired` and `heartbeat` arrive. */
  emitNamed(name: string, payload?: Record<string, unknown>): void {
    const listener = this.listeners[name];
    if (!listener) throw new Error(`no listener registered for "${name}"`);
    listener(payload === undefined ? {} : { data: JSON.stringify(payload) });
  }
}

/** Deliver a frame to the most recently opened stream. */
export function emit(frame: Record<string, unknown>): void {
  FakeEventSource.latest.emit(frame);
}

// ── Loading the shipped scripts ─────────────────────────────────────────────

export interface LiveGlobals {
  OrgXLiveMachine?: Record<string, any>;
  OrgXLiveStore?: Record<string, any>;
  OrgXLivePanel?: Record<string, any>;
  OrgXWidgetRuntime?: Record<string, any>;
  OrgXWidgetState?: Record<string, any>;
  [key: string]: unknown;
}

const SILENT_CONSOLE = { log() {}, warn() {}, error() {} };

/**
 * Evaluate the live scripts into a bare object rather than a DOM.
 *
 * Suites that only exercise pure logic (the state machine, reconciliation,
 * delta folding) do not need jsdom, and running them without it keeps them
 * fast and rules out the DOM as an explanation when one fails.
 */
export function loadLiveScope(scripts: readonly string[] = LIVE_SCRIPTS): LiveGlobals {
  const scope: LiveGlobals = { console: SILENT_CONSOLE };
  for (const file of scripts) {
    new Function('globalThis', 'window', readSharedScript(file)).call(scope, scope, scope);
  }
  return scope;
}

/**
 * Evaluate the live scripts into the ambient jsdom window, for suites that do
 * need a DOM. Clears any previous install so each test starts fresh.
 */
export function loadLiveIntoWindow(
  scripts: readonly string[] = LIVE_SCRIPTS
): LiveGlobals {
  const scope = window as unknown as LiveGlobals;
  for (const key of ['OrgXLiveMachine', 'OrgXLiveStore', 'OrgXLivePanel']) {
    delete scope[key];
  }
  for (const file of scripts) window.eval(readSharedScript(file));
  return scope;
}

// ── Mounting a real widget document ─────────────────────────────────────────

export interface MountOptions {
  /** Payload the host publishes as the tool result. */
  payload?: unknown;
  /** Stands in for the host's callTool, used by the token-refresh path. */
  callTool?: (...args: unknown[]) => unknown;
}

/**
 * Mount a widget from public/widgets the way the serving layer does: the shared
 * scripts first, then the widget's own inline script.
 *
 * The real widget-runtime.js is loaded rather than stubbed, because the live
 * attach happens inside its initWidget — stubbing it would test the harness
 * instead of the shipped path. A fake `window.openai` puts the runtime on its
 * ChatGPT branch, the one that renders from a payload synchronously.
 */
export function mountWidget(name: string, options: MountOptions = {}): void {
  const html = readWidgetHtml(name);
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? '';
  document.documentElement.innerHTML = `<head></head><body>${body.replace(
    /<script>[\s\S]*?<\/script>/g,
    ''
  )}</body>`;

  const scope = window as unknown as LiveGlobals;
  for (const key of ['OrgXLiveMachine', 'OrgXLiveStore', 'OrgXLivePanel', 'OrgXWidgetRuntime']) {
    delete scope[key];
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

  scope.openai = {
    toolOutput: options.payload,
    theme: 'dark',
    callTool: options.callTool ?? (() => undefined),
    setWidgetHeight() {},
  };

  for (const file of ['widget-runtime.js', ...LIVE_SCRIPTS]) {
    window.eval(readSharedScript(file));
  }
  (scope.OrgXWidgetRuntime as { __resetForTests(): void }).__resetForTests();

  // daily-brief's inline script was a module; match both spellings so the
  // harness does not silently pick the wrong <script> for such a widget.
  const scripts = html.match(/<script(?:\s+type="module")?>[\s\S]*?<\/script>/g) ?? [];
  const widgetScript = scripts[scripts.length - 1]!.replace(
    /<script(?:\s+type="module")?>|<\/script>/g,
    ''
  );

  // Some widgets bootstrap on DOMContentLoaded. In a real page their listener is
  // registered while the document is still parsing, so the event follows; here
  // the script runs after parsing and it has to be fired manually.
  //
  // Capturing the handler rather than dispatching on the shared document
  // matters: listeners bound to `document` outlive the innerHTML swap between
  // mounts, so a plain dispatch re-runs every previously mounted widget's
  // bootstrap against the current widget's DOM.
  const bootstraps: EventListener[] = [];
  const realAddEventListener = document.addEventListener.bind(document);
  document.addEventListener = ((type: string, listener: EventListener, ...rest: unknown[]) => {
    if (type === 'DOMContentLoaded') {
      bootstraps.push(listener);
      return;
    }
    return realAddEventListener(type, listener, ...(rest as []));
  }) as typeof document.addEventListener;

  try {
    window.eval(widgetScript);
  } finally {
    document.addEventListener = realAddEventListener;
  }

  for (const bootstrap of bootstraps) bootstrap(new window.Event('DOMContentLoaded'));
}

// ── Driving a store without real time or a real network ─────────────────────

export interface StubTransport {
  name: string;
  supported(): boolean;
  open(handlers: TransportHandlers): void;
  close(): void;
  readonly handlers: TransportHandlers;
  readonly openCount: number;
  readonly closeCount: number;
}

export interface TransportHandlers {
  onOpen(info?: unknown): void;
  onFrame(frame: unknown): void;
  onMalformed(info: unknown): void;
  onAuthExpired(detail: unknown): void;
  onError(info: unknown): void;
  onHeartbeat(): void;
}

/** A transport the test drives by hand, in place of SSE. */
export function createStubTransport(): StubTransport {
  let handlers: TransportHandlers | null = null;
  let opens = 0;
  let closes = 0;
  return {
    name: 'stub',
    supported: () => true,
    open(h: TransportHandlers) {
      handlers = h;
      opens += 1;
    },
    close() {
      closes += 1;
    },
    get handlers() {
      if (!handlers) throw new Error('transport was never opened');
      return handlers;
    },
    get openCount() {
      return opens;
    },
    get closeCount() {
      return closes;
    },
  };
}

export interface TestClock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  advance(ms: number): void;
  pending(): number;
}

/**
 * A hand-cranked clock. The store resolves its timer functions per call, so
 * passing these in exercises the same code path production uses.
 */
export function createClock(): TestClock {
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
        .filter(([, timer]) => timer.at <= time)
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

/** Options every store test shares; override what the case is about. */
export function storeOptions(overrides: Record<string, unknown> = {}) {
  return {
    widget: 'test-widget',
    streamUrl: 'https://mcp.useorgx.com/live-feed/agent-status/init-1/stream?t=tok',
    observeVisibility: false,
    console: SILENT_CONSOLE,
    ...overrides,
  };
}

// ── Canonical payloads ──────────────────────────────────────────────────────

export interface TestNode {
  id: string;
  title?: string;
  phase?: string;
  [key: string]: unknown;
}

/** A WorkGraph frame shaped the way LiveFeedDO emits one. */
export function graph(
  nodes: TestNode[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const summary = { running: 0, queued: 0, blocked: 0, done: 0, total: nodes.length, progress: 0 };
  for (const node of nodes) {
    if (node.phase === 'executing') summary.running += 1;
    else if (node.phase === 'blocked') summary.blocked += 1;
    else if (node.phase === 'terminal') summary.done += 1;
    else summary.queued += 1;
  }
  return {
    feedType: 'agent-status',
    feedId: 'init-1',
    nodes: nodes.map((node) => ({ title: node.id, phase: 'pending', ...node })),
    summary,
    ...overrides,
  };
}

/** A snapshot frame wrapping `graph`. */
export function snapshotFrame(
  nodes: TestNode[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { type: 'snapshot', ts: 1, data: graph(nodes, overrides) };
}

/** A grant shaped the way buildStreamGrant returns one. */
export function testGrant(overrides: Record<string, unknown> = {}) {
  const feedType = (overrides.feedType as string) ?? 'agent-status';
  return {
    feedType,
    feedId: 'init-1',
    streamUrl: `https://mcp.useorgx.com/live-feed/${feedType}/init-1/stream?t=tok`,
    expiresAt: Date.now() + 900_000,
    refreshTool: 'get_agent_status',
    refreshArgs: { initiative_id: 'init-1' },
    label: 'Agent status',
    ...overrides,
  };
}
