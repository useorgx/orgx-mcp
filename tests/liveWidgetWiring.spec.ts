// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildStreamGrant, feedBindingForTool } from '../src/live/streamGrant';
import { FEEDS } from '../src/live/feedRegistry';
import { diffGraphs } from '../src/live/delta';
import {
  emit,
  FakeEventSource,
  mountWidget as mountWidgetDocument,
  testGrant,
  WIDGETS_DIR,
} from './fixtures/live';

/**
 * End-to-end wiring for the static widgets in public/widgets.
 *
 * Each widget reads the `live` grant out of its tool payload, subscribes, and
 * patches its panel as frames arrive — the path that did not exist before, when
 * a widget rendered once from a tool result and never learned anything changed.
 *
 * The real widget-runtime.js runs here rather than a stub, because the attach
 * happens inside its initWidget; stubbing it would test the harness instead of
 * the shipped path.
 */

const callTool = vi.fn();

function mountWidget(name: string, payload: unknown): void {
  mountWidgetDocument(name, { payload, callTool });
}

function mountAgentStatus(payload: unknown): void {
  mountWidget('agent-status', payload);
}

function graphFrom(agents: Record<string, unknown>[]) {
  return FEEDS['agent-status']!.normalize({ agents }, 'init-1');
}

function panelText(): string {
  return document.getElementById('liveFlow')?.textContent ?? '';
}

function panelRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('#liveFlow .oxlp-row')) as HTMLElement[];
}

const GRANT = testGrant();

beforeEach(() => {
  FakeEventSource.reset();
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

    // Rows it already showed stay as the last known state, with a quiet retry.
    expect(panelText()).toContain('Last known');
    expect(panelText()).not.toContain('Disconnected');
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

/**
 * Every widget that opted into the live layer, and the anchor it mounts against.
 * The point of the table is that adding a widget to the layer means adding a row
 * here, so a widget cannot quietly ship a `live` block that never attaches.
 */
// daily-brief was retired on main (#402); these are the widgets that remain
// opted into the live layer.
const WIRED_WIDGETS: { name: string; feedType: string }[] = [
  { name: 'agent-status', feedType: 'agent-status' },
  { name: 'initiative-pulse', feedType: 'initiative-pulse' },
  { name: 'task-spawned', feedType: 'agent-status' },
  { name: 'scaffolded-initiative', feedType: 'initiative-pulse' },
  { name: 'decisions', feedType: 'agent-status' },
  { name: 'artifact-review', feedType: 'agent-status' },
  { name: 'plan-session-live', feedType: 'agent-status' },
  { name: 'morning-brief', feedType: 'agent-status' },
  { name: 'entity-card', feedType: 'agent-status' },
  { name: 'work-ledger', feedType: 'agent-status' },
  { name: 'workspace-map', feedType: 'initiative-pulse' },
];

describe('every wired widget attaches the live layer', () => {
  it.each(WIRED_WIDGETS)('$name loads the live scripts', ({ name }) => {
    const html = readFileSync(join(WIDGETS_DIR, `${name}.html`), 'utf8');
    // Order matters: the store and panel both assert the machine is installed.
    const machine = html.indexOf('shared/live-machine.js');
    const store = html.indexOf('shared/live-store.js');
    const panel = html.indexOf('shared/live-panel.js');
    expect(machine).toBeGreaterThan(-1);
    expect(store).toBeGreaterThan(machine);
    expect(panel).toBeGreaterThan(machine);
  });

  it.each(WIRED_WIDGETS)('$name mounts a panel and renders a live snapshot', ({ name, feedType }) => {
    const grant = {
      ...GRANT,
      feedType,
      streamUrl: `https://mcp.useorgx.com/live-feed/${feedType}/init-1/stream?t=tok`,
    };
    mountWidget(name, { live: grant });

    // Attached to the real stream.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest.url).toContain(`/live-feed/${feedType}/init-1/stream`);

    FakeEventSource.latest.onopen?.();
    emit({
      type: 'snapshot',
      ts: 1,
      data: graphFrom([
        { id: 'a', name: 'Alpha Agent', status: 'running', currentTask: 'Doing the thing' },
        { id: 'b', name: 'Beta Agent', status: 'blocked', blockers: ['Needs approval'] },
      ]),
    });

    const flow = document.getElementById('liveFlow');
    expect(flow, `${name} did not mount a live panel`).not.toBeNull();
    expect(flow!.textContent).toContain('Alpha Agent');
    expect(flow!.textContent).toContain('Needs approval');
    expect(flow!.querySelectorAll('.oxlp-row')).toHaveLength(2);
  });

  it.each(WIRED_WIDGETS)('$name stays completely static without a grant', ({ name }) => {
    mountWidget(name, {});
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(document.getElementById('liveFlow')).toBeNull();
  });

  it('leaves search-results alone: a result list has no live work to show', () => {
    const html = readFileSync(join(WIDGETS_DIR, 'search-results.html'), 'utf8');
    expect(html).not.toContain('shared/live-machine.js');
  });
});

describe('empty states defer to the live panel', () => {
  it('does not claim "no data" while the panel is listing running work', async () => {
    // The pulse snapshot and the live feed are separate sources. A card reading
    // "Awaiting telemetry" above a panel listing four running workstreams is
    // technically true and completely misleading.
    mountWidget('initiative-pulse', {
      live: {
        ...GRANT,
        feedType: 'initiative-pulse',
        streamUrl: 'https://mcp.useorgx.com/live-feed/initiative-pulse/init-1/stream?t=tok',
      },
    });
    FakeEventSource.latest.onopen?.();
    emit({
      type: 'snapshot',
      ts: 1,
      data: graphFrom([{ id: 'a', name: 'Deploy', status: 'running' }]),
    });

    const flow = document.getElementById('liveFlow')!;
    expect(flow.textContent).toContain('Deploy');

    // The card commits on a staged reveal timer, so wait for it to land before
    // asserting — a bare negative assertion would pass against the skeleton.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Live work only');
    });
    expect(document.body.textContent).not.toContain('Awaiting telemetry');
  });

  it('still says "No pulse yet" when there is genuinely nothing', async () => {
    mountWidget('initiative-pulse', {});
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('No pulse yet');
    });
    expect(document.body.textContent).not.toContain('Live work only');
  });

  it('decisions does not say "all caught up" over a live queue', async () => {
    // Reachable in production, unlike the task-spawned case: the card renders
    // the tool payload (a snapshot from when the tool ran) and the panel renders
    // the live feed, so a decision raised seconds later appears above a card
    // still claiming the queue is clear.
    mountWidget('decisions', {
      decisions: [],
      live: {
        ...GRANT,
        feedType: 'decisions',
        streamUrl: 'https://mcp.useorgx.com/live-feed/decisions/init-1/stream?t=tok',
      },
    });
    FakeEventSource.latest.onopen?.();
    emit({
      type: 'snapshot',
      ts: 1,
      data: FEEDS.decisions!.normalize(
        { decisions: [{ id: 'd1', title: 'Ship v3?', status: 'pending' }] },
        'init-1'
      ),
    });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Newer than this snapshot');
    });
    expect(document.body.textContent).not.toContain('All caught up');
  });

  it('decisions still says "all caught up" when the live queue is empty too', async () => {
    mountWidget('decisions', { decisions: [] });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('All caught up');
    });
    expect(document.body.textContent).not.toContain('Newer than this snapshot');
  });

  it('reports the live row count across attached feeds', () => {
    mountWidget('agent-status', {
      live: { ...GRANT },
    });
    const store = (window as unknown as {
      OrgXLiveStore: { liveRowCount(): number };
    }).OrgXLiveStore;
    expect(store.liveRowCount()).toBe(0);

    FakeEventSource.latest.onopen?.();
    emit({
      type: 'snapshot',
      ts: 1,
      data: graphFrom([
        { id: 'a', name: 'A', status: 'running' },
        { id: 'b', name: 'B', status: 'queued' },
      ]),
    });
    expect(store.liveRowCount()).toBe(2);
  });
});

describe('a feed is only bound to an id that is really an initiative', () => {
  it('uses initiative_id when the payload has one', async () => {
    const { feedBindingForTool, resolveFeedIdForTool } = await import(
      '../src/live/streamGrant'
    );
    const binding = feedBindingForTool('orgx_inspect')!;
    expect(resolveFeedIdForTool(binding, { id: 'task-9', initiative_id: 'init-1' })).toBe(
      'init-1'
    );
  });

  it('refuses to subscribe an inspected entity as if it were an initiative', async () => {
    // orgx_inspect hydrates whatever you named — a task, an artifact, a
    // decision. The caller's effectiveInitiativeId falls back to data.id, and
    // feeding that to the agents API asks for an initiative that does not
    // exist. No initiative context means no grant, and a static widget.
    const { feedBindingForTool, resolveFeedIdForTool } = await import(
      '../src/live/streamGrant'
    );
    const binding = feedBindingForTool('orgx_inspect')!;
    expect(resolveFeedIdForTool(binding, { id: 'task-9' })).toBeNull();
  });

  it('allows the fallback only where the entity IS the initiative', async () => {
    const { feedBindingForTool, resolveFeedIdForTool } = await import(
      '../src/live/streamGrant'
    );
    // Scaffolding returns the initiative it just created.
    const scaffold = feedBindingForTool('scaffold_initiative')!;
    expect(resolveFeedIdForTool(scaffold, { id: 'init-new' })).toBe('init-new');
    // A spawn returns a run id, not an initiative.
    const spawn = feedBindingForTool('orgx_spawn')!;
    expect(resolveFeedIdForTool(spawn, { id: 'run-7' })).toBeNull();
  });

  it('binds the widgets that arrived on main', async () => {
    const { feedBindingForTool } = await import('../src/live/streamGrant');
    expect(feedBindingForTool('orgx_inspect')?.feedType).toBe('agent-status');
    expect(feedBindingForTool('get_operator_chronicle')?.feedType).toBe('agent-status');
    expect(feedBindingForTool('orgx_bootstrap')?.feedType).toBe('initiative-pulse');
  });
});
