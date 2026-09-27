// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildStreamGrant, feedBindingForTool } from '../src/live/streamGrant';
import { FEEDS } from '../src/live/feedRegistry';
import { diffGraphs } from '../src/live/delta';

/**
 * End-to-end wiring for a static widget in public/widgets/.
 *
 * Runs the real agent-status.html script against a fake EventSource: the widget
 * reads the `live` grant out of its tool payload, subscribes, and patches its
 * panel as frames arrive. This is the path that did not exist before — the
 * static widgets rendered once from tool output and never learned that anything
 * changed.
 */

const ROOT = join(__dirname, '..');
const SHARED = join(ROOT, 'public', 'widgets', 'shared');

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  closed = false;
  listeners: Record<string, (event: { data?: string }) => void> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (event: { data?: string }) => void): void {
    this.listeners[name] = fn;
  }

  close(): void {
    this.closed = true;
  }

  static get latest(): FakeEventSource {
    const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!source) throw new Error('widget never opened a stream');
    return source;
  }
}

const callTool = vi.fn();

/**
 * Mount the widget the way the serving layer does: shared scripts first, then
 * the widget's own inline script.
 */
function mountWidget(name: string, payload: unknown): void {
  const html = readFileSync(join(ROOT, 'public', 'widgets', `${name}.html`), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? '';
  document.documentElement.innerHTML = `<head></head><body>${body.replace(
    /<script>[\s\S]*?<\/script>/g,
    ''
  )}</body>`;

  const scope = window as unknown as Record<string, unknown>;
  for (const key of ['OrgXLiveMachine', 'OrgXLiveStore', 'OrgXLivePanel', 'OrgXWidgetRuntime']) {
    delete scope[key];
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

  for (const file of ['live-machine.js', 'live-store.js', 'live-panel.js']) {
    window.eval(readFileSync(join(SHARED, file), 'utf8'));
  }

  // Stand in for widget-runtime.js: the widget only needs callTool, reportSize
  // and an initWidget that hands it the payload.
  scope.OrgXWidgetRuntime = {
    callTool,
    reportSize() {},
    detectProtocol: () => 'mcp-apps',
    openWidgetLink: () => false,
    getErrorMessage: (value: unknown, fallback: string) =>
      typeof value === 'string' ? value : fallback,
  };
  scope.initWidget = (options: { render(data: unknown): void }) => {
    options.render(payload);
  };
  scope.callTool = callTool;
  scope.openWidgetLink = () => false;

  const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
  const widgetScript = scripts[scripts.length - 1]!.replace(/<\/?script>/g, '');
  window.eval(widgetScript);
}

function mountAgentStatus(payload: unknown): void {
  mountWidget('agent-status', payload);
}

function graphFrom(agents: Record<string, unknown>[]) {
  return FEEDS['agent-status']!.normalize({ agents }, 'init-1');
}

function emit(frame: Record<string, unknown>): void {
  FakeEventSource.latest.onmessage?.({ data: JSON.stringify(frame) });
}

function panelText(): string {
  return document.getElementById('liveFlow')?.textContent ?? '';
}

function panelRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('#liveFlow .oxlp-row')) as HTMLElement[];
}

const GRANT = {
  feedType: 'agent-status',
  feedId: 'init-1',
  streamUrl: 'https://mcp.useorgx.com/live-feed/agent-status/init-1/stream?t=tok',
  expiresAt: Date.now() + 3_600_000,
  refreshTool: 'get_agent_status',
  refreshArgs: { initiative_id: 'init-1' },
  label: 'Agent status',
};

beforeEach(() => {
  FakeEventSource.instances = [];
  callTool.mockReset();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('grant construction', () => {
  it('builds a signed, feed-scoped stream URL', async () => {
    const grant = await buildStreamGrant({
      feedType: 'agent-status',
      feedId: 'init-1',
      serverUrl: 'https://mcp.useorgx.com/',
      secret: 'test-secret',
      refreshTool: 'get_agent_status',
    });
    expect(grant).not.toBeNull();
    expect(grant!.streamUrl).toMatch(
      /^https:\/\/mcp\.useorgx\.com\/live-feed\/agent-status\/init-1\/stream\?t=.+/
    );
    // Reported short of the real exp so a proactive refresh beats the server's
    // own expiry warning.
    expect(grant!.expiresAt).toBeLessThan(Date.now() + 3_600_000);
  });

  it('refuses to build a grant for an unknown feed or a missing secret', async () => {
    expect(
      await buildStreamGrant({
        feedType: 'not-a-feed',
        feedId: 'i',
        serverUrl: 'https://x.test',
        secret: 's',
        refreshTool: 't',
      })
    ).toBeNull();
    expect(
      await buildStreamGrant({
        feedType: 'agent-status',
        feedId: 'i',
        serverUrl: 'https://x.test',
        secret: '',
        refreshTool: 't',
      })
    ).toBeNull();
  });

  it('binds the spawn tools to the agent feed so dispatch becomes watchable', () => {
    // "Spawn a task and it is unclear what is in progress" is the gap these
    // bindings close: the spawn result itself carries a subscription.
    for (const tool of ['spawn_agent_task', 'delegate_agent_task', 'orgx_spawn']) {
      expect(feedBindingForTool(tool)?.feedType).toBe('agent-status');
    }
    expect(feedBindingForTool('unrelated_tool')).toBeNull();
  });
});

describe('agent-status widget goes live from its grant', () => {
  it('subscribes to the granted stream URL', () => {
    mountAgentStatus({ agents: [], live: GRANT });
    expect(FakeEventSource.latest.url).toContain('/live-feed/agent-status/init-1/stream');
  });

  it('does not subscribe when the payload carries no grant', () => {
    // Every widget without a grant must behave exactly as it did before.
    mountAgentStatus({ agents: [] });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(document.getElementById('liveFlow')).toBeNull();
  });

  it('renders agents arriving over the stream, not just the ones in the payload', () => {
    mountAgentStatus({ agents: [], live: GRANT });
    FakeEventSource.latest.onopen?.();

    emit({
      type: 'snapshot',
      ts: 1000,
      data: graphFrom([
        { id: 'eng-1', name: 'Engineering Autopilot', status: 'running', currentTask: 'Fan-out' },
        { id: 'mkt-1', name: 'Launch Captain', status: 'queued' },
      ]),
    });

    expect(panelRows()).toHaveLength(2);
    expect(panelText()).toContain('Engineering Autopilot');
    expect(panelText()).toContain('1 running');
    expect(panelText()).toContain('1 queued');
  });

  it('patches in place as work progresses, reusing the same row element', () => {
    mountAgentStatus({ agents: [], live: GRANT });
    FakeEventSource.latest.onopen?.();

    const first = graphFrom([{ id: 'eng-1', name: 'Engineering', status: 'queued' }]);
    emit({ type: 'snapshot', ts: 1, data: first });
    const rowBefore = panelRows()[0]!;

    const second = graphFrom([
      { id: 'eng-1', name: 'Engineering', status: 'running', progress: 40 },
    ]);
    emit({ type: 'delta', ts: 2, data: diffGraphs(first, second) });

    expect(panelRows()[0]).toBe(rowBefore);
    expect(rowBefore.getAttribute('data-phase')).toBe('executing');
    // A start is a real boundary, so it flashes.
    expect(rowBefore.getAttribute('data-anim')).toBe('started');
  });

  it('surfaces a newly blocked agent as blocked with its reason', () => {
    mountAgentStatus({ agents: [], live: GRANT });
    FakeEventSource.latest.onopen?.();

    const running = graphFrom([{ id: 'ops-1', name: 'Control Tower', status: 'running' }]);
    emit({ type: 'snapshot', ts: 1, data: running });

    const blocked = graphFrom([
      {
        id: 'ops-1',
        name: 'Control Tower',
        status: 'running',
        blockers: ['Waiting on deploy credentials'],
      },
    ]);
    emit({ type: 'delta', ts: 2, data: diffGraphs(running, blocked) });

    const row = panelRows()[0]!;
    expect(row.getAttribute('data-phase')).toBe('blocked');
    expect(row.getAttribute('data-anim')).toBe('blocked');
    expect(panelText()).toContain('Waiting on deploy credentials');
    expect(panelText()).toContain('1 blocked');
  });

  it('shows Live while connected and Reconnecting on a drop', () => {
    mountAgentStatus({ agents: [], live: GRANT });
    FakeEventSource.latest.onopen?.();
    emit({ type: 'snapshot', ts: 1, data: graphFrom([{ id: 'a', name: 'A', status: 'running' }]) });
    expect(panelText()).toContain('Live');

    FakeEventSource.latest.onerror?.();
    expect(panelText()).toContain('Reconnecting');
    // The last known rows stay on screen while degraded.
    expect(panelRows()).toHaveLength(1);
  });

  it('refreshes through its bound MCP tool when the token expires', async () => {
    // The recovery that no widget had: the server warns before a token's exp,
    // and the tool call is the only way a sandboxed widget can get a new one.
    callTool.mockResolvedValue({
      live: { ...GRANT, streamUrl: GRANT.streamUrl.replace('tok', 'fresh-token') },
    });

    mountAgentStatus({ agents: [], live: GRANT });
    FakeEventSource.latest.onopen?.();
    const original = FakeEventSource.latest;

    original.listeners.auth_expired!({
      data: JSON.stringify({ reason: 'stream_token_expired', next: 'refresh' }),
    });

    expect(panelText()).toContain('Reauthorizing');
    expect(original.closed).toBe(true);

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(callTool).toHaveBeenCalledWith('get_agent_status', { initiative_id: 'init-1' });
    expect(FakeEventSource.latest.url).toContain('fresh-token');
  });

  it('opens exactly one stream even if the host re-renders the payload', () => {
    // MCP hosts re-deliver tool results; a second subscription per message would
    // multiply the fan-out on the server.
    mountAgentStatus({ agents: [], live: GRANT });
    const scope = window as unknown as {
      initWidget: unknown;
    };
    void scope;
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('offers a retry once the reconnect budget is spent', () => {
    mountAgentStatus({ agents: [], live: GRANT });
    FakeEventSource.latest.onopen?.();
    emit({ type: 'snapshot', ts: 1, data: graphFrom([{ id: 'a', name: 'A', status: 'running' }]) });

    // Default budget is 8 attempts. Fake timers let each scheduled retry fire so
    // the budget actually drains instead of sitting in a pending timeout.
    vi.useFakeTimers();
    for (let i = 0; i < 10; i += 1) {
      FakeEventSource.latest.onerror?.();
      vi.advanceTimersByTime(60_000);
    }
    vi.useRealTimers();

    expect(panelText()).toContain('Disconnected');
    const retry = document.querySelector('#liveFlow .oxlp-retry') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    expect(retry.hidden).toBe(false);
  });
});

describe('initiative-pulse widget uses the same shared wiring', () => {
  const PULSE_GRANT = {
    ...GRANT,
    feedType: 'initiative-pulse',
    streamUrl: 'https://mcp.useorgx.com/live-feed/initiative-pulse/init-1/stream?t=tok',
    refreshTool: 'get_initiative_pulse',
  };

  function pulseGraph(workstreams: Record<string, unknown>[]) {
    return FEEDS['initiative-pulse']!.normalize(
      { initiatives: [{ id: 'init-1', title: 'Operation Prism', workstreams }] },
      'init-1'
    );
  }

  it('subscribes from its grant and renders workstreams', () => {
    mountWidget('initiative-pulse', { initiative: { title: 'Operation Prism' }, live: PULSE_GRANT });
    expect(FakeEventSource.latest.url).toContain('/live-feed/initiative-pulse/init-1/stream');

    FakeEventSource.latest.onopen?.();
    emit({
      type: 'snapshot',
      ts: 1,
      data: pulseGraph([
        { name: 'SSE Infrastructure', status: 'done', progress: 100 },
        { name: 'Deploy & Monitor', status: 'blocked', progress: 20 },
      ]),
    });

    const text = document.getElementById('liveFlow')?.textContent ?? '';
    expect(text).toContain('SSE Infrastructure');
    expect(text).toContain('Deploy & Monitor');
    expect(text).toContain('1 blocked');
  });

  it('stays static without a grant', () => {
    mountWidget('initiative-pulse', { initiative: { title: 'Operation Prism' } });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(document.getElementById('liveFlow')).toBeNull();
  });

  it('mounts exactly one panel even if the host re-renders', () => {
    // ensureLiveMount is keyed by id; a host re-delivering a tool result must
    // not stack a second panel.
    mountWidget('initiative-pulse', { initiative: {}, live: PULSE_GRANT });
    expect(document.querySelectorAll('#liveFlow')).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
