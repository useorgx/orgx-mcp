// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeEventSource } from './fixtures/live';
import { PROOF_SURFACE_QUIET_CTA } from '../src/widgetArtifactProof';

import { buildLiveFeedWidget } from '../src/liveFeedWidget';
import { FEEDS } from '../src/live/feedRegistry';
import { diffGraphs } from '../src/live/delta';
import type { WorkGraph } from '../src/live/workGraph';

/**
 * Binds the server's emitted payload to the widget that reads it.
 *
 * This suite exists because of a break it would have caught: when LiveFeedDO
 * switched from passing the raw OrgX response through to emitting the canonical
 * WorkGraph, every unit test still passed — the widget tests inject their own
 * synthetic raw payloads, and the server tests stop at the normalizer. Nothing
 * asserted that the two halves agreed, so the widget would have rendered
 * "No agents active" against a perfectly healthy feed.
 *
 * Every case here drives the real normalizer's output into the real widget.
 */

function mount(feedType: 'agent-status' | 'initiative-pulse'): FakeEventSource {
  const html = buildLiveFeedWidget({
    feedType,
    feedId: 'init-12345678',
    streamBaseUrl: 'https://mcp.useorgx.com',
    streamToken: 'token-123',
    title: 'Operation Prism',
  });
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, '');
  (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  window.eval(script);
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error('widget did not open an EventSource');
  return source;
}

function emit(source: FakeEventSource, frame: Record<string, unknown>): void {
  source.onmessage?.({ data: JSON.stringify(frame) });
}

/** Emit a graph exactly as LiveFeedDO would frame its first snapshot. */
function emitSnapshot(source: FakeEventSource, graph: WorkGraph): void {
  emit(source, {
    type: 'snapshot',
    feedType: graph.feedType,
    feedId: graph.feedId,
    data: graph,
    ts: Date.now(),
  });
}

function quietCtaEl(): HTMLElement {
  const el = document.getElementById('quietCta');
  if (!el) throw new Error('quiet CTA element missing');
  return el;
}

function text(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
  FakeEventSource.reset();
});

describe('agent-status: normalizer output renders in the widget', () => {
  // Shaped like /api/live/agents, including the field-spelling drift that the
  // normalizer is responsible for absorbing.
  const rawAgents = {
    agents: [
      {
        id: 'eng-1',
        name: 'Engineering Autopilot',
        domain: 'engineering',
        status: 'running',
        currentTask: 'Implement SSE fan-out logic',
        workstream: 'WS1: SSE Infrastructure',
        progress: 62,
      },
      {
        agent_id: 'ops-1',
        agent_name: 'Control Tower',
        domain: 'operations',
        status: 'running',
        current_task: 'Deploy to production',
        blockers: ['Waiting on deploy credentials'],
      },
      {
        id: 'mkt-1',
        name: 'Launch Captain',
        domain: 'marketing',
        status: 'queued',
        currentTask: 'Tweet thread draft',
      },
    ],
  };

  it('renders every agent the feed reported', () => {
    const graph = FEEDS['agent-status']!.normalize(rawAgents, 'init-12345678');
    const source = mount('agent-status');
    emitSnapshot(source, graph);

    expect(text()).toContain('Engineering Autopilot');
    expect(text()).toContain('Control Tower');
    expect(text()).toContain('Launch Captain');
    expect(text()).not.toContain('No agents active');
  });

  it('carries the current task through both field spellings', () => {
    const graph = FEEDS['agent-status']!.normalize(rawAgents, 'init-12345678');
    const source = mount('agent-status');
    emitSnapshot(source, graph);

    expect(text()).toContain('Implement SSE fan-out logic');
    expect(text()).toContain('Deploy to production');
  });

  it('shows the blocked agent as blocked, not as the running status upstream sent', () => {
    // Control Tower reports `status: running` with a blocker. The normalizer
    // resolves that to blocked, and the widget must show the resolved phase —
    // otherwise a stalled agent reads as healthy.
    const graph = FEEDS['agent-status']!.normalize(rawAgents, 'init-12345678');
    const source = mount('agent-status');
    emitSnapshot(source, graph);

    expect(graph.summary).toMatchObject({ running: 1, queued: 1, blocked: 1 });
    expect(text()).toContain('1 blocked');
    expect(text()).toContain('1 running');
    expect(document.querySelectorAll('.s-blocked').length).toBe(1);
  });

  it('renders an empty feed as empty rather than as a broken one', () => {
    const graph = FEEDS['agent-status']!.normalize({ agents: [] }, 'init-12345678');
    const source = mount('agent-status');
    emitSnapshot(source, graph);
    expect(text()).toContain('No agents active');
  });
});

describe('initiative-pulse: normalizer output renders in the widget', () => {
  const rawPulse = {
    initiatives: [
      {
        id: 'init-12345678',
        title: 'Operation Prism',
        status: 'active',
        progress: 62,
        workstreams: [
          { name: 'SSE Infrastructure', domain: 'engineering', status: 'done', progress: 100 },
          { name: 'Widget Polish', domain: 'design', status: 'running', progress: 75 },
          { name: 'Deploy & Monitor', domain: 'operations', status: 'blocked', progress: 20 },
        ],
      },
    ],
  };

  it('renders the initiative title and every workstream', () => {
    const graph = FEEDS['initiative-pulse']!.normalize(rawPulse, 'init-12345678');
    const source = mount('initiative-pulse');
    emitSnapshot(source, graph);

    expect(text()).toContain('Operation Prism');
    expect(text()).toContain('SSE Infrastructure');
    expect(text()).toContain('Widget Polish');
    expect(text()).toContain('Deploy & Monitor');
    expect(text()).not.toContain('No initiative data');
  });

  it('renders progress from the rollup, not from whatever upstream stamped on the root', () => {
    const graph = FEEDS['initiative-pulse']!.normalize(rawPulse, 'init-12345678');
    const source = mount('initiative-pulse');
    emitSnapshot(source, graph);
    // done(100) + running(75) + blocked(20) + initiative(62) → 64
    expect(graph.summary.progress).toBe(64);
    expect(text()).toContain('64%');
  });

  it('never renders NaN% when no workstream reports progress', () => {
    const graph = FEEDS['initiative-pulse']!.normalize(
      { initiatives: [{ id: 'i', title: 'Bare', workstreams: [{ name: 'A', status: 'queued' }] }] },
      'i'
    );
    const source = mount('initiative-pulse');
    emitSnapshot(source, graph);
    expect(text()).not.toContain('NaN');
  });
});

describe('delta frames converge on the same view as a snapshot', () => {
  const step = (progress: number, deployStatus: string) => ({
    initiatives: [
      {
        id: 'init-12345678',
        title: 'Operation Prism',
        status: 'active',
        progress,
        workstreams: [
          { name: 'SSE Infrastructure', status: 'done', progress: 100 },
          { name: 'Deploy & Monitor', status: deployStatus, progress: 20 },
        ],
      },
    ],
  });

  it('applies a real diffGraphs delta on top of the held snapshot', () => {
    const feed = FEEDS['initiative-pulse']!;
    const first = feed.normalize(step(62, 'blocked'), 'init-12345678');
    const second = feed.normalize(step(80, 'running'), 'init-12345678');
    const delta = diffGraphs(first, second);
    expect(delta).not.toBeNull();

    const source = mount('initiative-pulse');
    emitSnapshot(source, first);
    expect(text()).toContain('Operation Prism');

    emit(source, {
      type: 'delta',
      feedType: 'initiative-pulse',
      feedId: 'init-12345678',
      data: delta,
      ts: Date.now() + 1,
    });

    // A delta names only the changed nodes. The unchanged workstream must
    // survive — a renderer fed the delta alone would drop it.
    expect(text()).toContain('SSE Infrastructure');
    expect(text()).toContain('Deploy & Monitor');
    expect(text()).toContain(`${second.summary.progress}%`);
  });

  it('ignores a delta that arrives with no snapshot to fold onto', () => {
    // Happens on a `since=` reconnect that replays deltas cached before this
    // client attached. Rendering a partial graph would be worse than waiting.
    const source = mount('initiative-pulse');
    emit(source, {
      type: 'delta',
      feedType: 'initiative-pulse',
      feedId: 'init-12345678',
      data: { changed: [{ id: 'x', title: 'Ghost', phase: 'executing' }], removed: [], summary: {} },
      ts: Date.now(),
    });
    expect(text()).not.toContain('Ghost');
  });

  it('removes nodes the delta dropped', () => {
    const feed = FEEDS['agent-status']!;
    const before = feed.normalize(
      { agents: [{ id: 'a', name: 'Alpha', status: 'running' }, { id: 'b', name: 'Beta', status: 'running' }] },
      'i'
    );
    const after = feed.normalize({ agents: [{ id: 'a', name: 'Alpha', status: 'running' }] }, 'i');
    const delta = diffGraphs(before, after)!;

    const source = mount('agent-status');
    emitSnapshot(source, before);
    expect(text()).toContain('Beta');

    emit(source, { type: 'delta', data: delta, ts: Date.now() + 1 });
    expect(text()).toContain('Alpha');
    expect(text()).not.toContain('Beta');
  });
});

describe('legacy payloads still render after the shape change', () => {
  it('accepts a raw snapshot cached before the canonical rollout', () => {
    // A client reconnecting with `since=` can be replayed pre-deploy events.
    const source = mount('agent-status');
    emit(source, {
      type: 'snapshot',
      ts: Date.now(),
      data: {
        summary: { running: 1 },
        agents: [{ id: 'a', name: 'Legacy Agent', status: 'running', currentTask: 'Old shape' }],
      },
    });
    expect(text()).toContain('Legacy Agent');
    expect(text()).toContain('Old shape');
  });
});

describe('the generated widget folds deltas like the shared layer', () => {
  /**
   * src/liveFeedWidget.ts is a second consumer of the same wire format, built
   * as a self-contained HTML string rather than from public/widgets. It carried
   * its own copy of the fold and its own copies of the fold's bugs. These drive
   * the real generated document, so a regression there cannot hide behind the
   * shared layer's tests.
   */
  const pulse = (workstreams: Record<string, unknown>[]) => ({
    initiatives: [{ id: 'init-12345678', title: 'Operation Prism', workstreams }],
  });

  it('honours the order the server sent, rather than appending', () => {
    // A pure reorder changes no node's fields. Appending locally cannot express
    // it, and put a node the server led with at the bottom.
    const feed = FEEDS['initiative-pulse']!;
    const first = feed.normalize(
      pulse([
        { name: 'Alpha', status: 'running', progress: 10 },
        { name: 'Beta', status: 'running', progress: 20 },
      ]),
      'init-12345678'
    );
    const second = feed.normalize(
      pulse([
        { name: 'Beta', status: 'running', progress: 20 },
        { name: 'Alpha', status: 'running', progress: 10 },
      ]),
      'init-12345678'
    );
    const delta = diffGraphs(first, second)!;
    expect(delta.order).toBeTruthy();

    const source = mount('initiative-pulse');
    emitSnapshot(source, first);
    emit(source, { type: 'delta', data: delta, ts: Date.now() + 1 });

    const rendered = text();
    expect(rendered.indexOf('Beta')).toBeLessThan(rendered.indexOf('Alpha'));
  });

  it('renders a workstream named "constructor" instead of crashing', () => {
    // An id-less workstream takes its title as its id. On a plain object,
    // lookup of "constructor" resolves an inherited member and reads as an
    // already-present node.
    const feed = FEEDS['initiative-pulse']!;
    const graph = feed.normalize(
      pulse([
        { name: 'constructor', status: 'running' },
        { name: '__proto__', status: 'blocked' },
      ]),
      'init-12345678'
    );
    const source = mount('initiative-pulse');
    expect(() => emitSnapshot(source, graph)).not.toThrow();
    expect(text()).toContain('constructor');

    // A snapshot never enters the fold. Drive a delta touching that id, which
    // is where a plain-object lookup mistakes the inherited member for a node.
    const moved = feed.normalize(
      pulse([
        { name: '__proto__', status: 'blocked' },
        { name: 'constructor', status: 'done' },
      ]),
      'init-12345678'
    );
    const delta = diffGraphs(graph, moved)!;
    expect(() =>
      emit(source, { type: 'delta', data: delta, ts: Date.now() + 1 })
    ).not.toThrow();
    const rendered = text();
    expect(rendered.indexOf('__proto__')).toBeLessThan(rendered.indexOf('constructor'));
  });

  it('withdraws a proof handoff the delta removed', () => {
    const feed = FEEDS['initiative-pulse']!;
    const withCta = {
      ...feed.normalize(pulse([{ name: 'Alpha', status: 'running' }]), 'init-12345678'),
      proofHandoff: { quiet_cta: PROOF_SURFACE_QUIET_CTA },
    };
    const without = feed.normalize(pulse([{ name: 'Alpha', status: 'running' }]), 'init-12345678');
    const delta = diffGraphs(withCta, without)!;
    expect(delta.proofHandoff).toBeNull();

    const source = mount('initiative-pulse');
    emitSnapshot(source, withCta);
    expect(quietCtaEl().hidden).toBe(false);

    emit(source, { type: 'delta', data: JSON.parse(JSON.stringify(delta)), ts: Date.now() + 1 });
    expect(quietCtaEl().hidden).toBe(true);
  });
});
