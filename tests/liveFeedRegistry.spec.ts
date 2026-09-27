import { describe, expect, it } from 'vitest';

import {
  buildWorkGraph,
  deriveHeadline,
  phaseForStatus,
  readBlockers,
  resolvePhase,
  summarize,
  type WorkNode,
} from '../src/live/workGraph';
import {
  cadenceFor,
  FEEDS,
  FEED_ROUTE_PATTERN,
  FEED_TYPES,
  getFeed,
} from '../src/live/feedRegistry';
import { applyDelta, diffGraphs, nodeChanged } from '../src/live/delta';

function node(overrides: Partial<WorkNode> & { id: string }): WorkNode {
  return { title: overrides.id, phase: 'pending', ...overrides };
}

describe('phase vocabulary', () => {
  it('agrees with the widget-side and /live classifications', () => {
    expect(phaseForStatus('EXECUTING')).toBe('executing');
    expect(phaseForStatus('in-progress')).toBe('executing');
    expect(phaseForStatus('COMPLETED')).toBe('terminal');
    expect(phaseForStatus('needs_approval')).toBe('blocked');
    expect(phaseForStatus('queued')).toBe('pending');
    expect(phaseForStatus(undefined)).toBe('pending');
  });

  it('treats a running node with blockers as blocked, not running', () => {
    // An upstream that reports `running` alongside a blocker is describing a
    // stalled run. Filing it under running is how a stuck initiative looks
    // healthy on a dashboard.
    expect(resolvePhase('running', [{ reason: 'Waiting on credentials' }])).toBe('blocked');
    expect(resolvePhase('running', [])).toBe('executing');
  });

  it('keeps terminal terminal even with stale blockers attached', () => {
    expect(resolvePhase('completed', [{ reason: 'was blocked earlier' }])).toBe('terminal');
  });
});

describe('blocker normalization', () => {
  it('reads string, object and single-field blocker spellings', () => {
    expect(readBlockers({ blockers: ['no credentials'] })).toEqual([
      { reason: 'no credentials' },
    ]);
    expect(
      readBlockers({ blockers: [{ reason: 'needs approval', resolve_tool: 'orgx_decide' }] })
    ).toEqual([{ reason: 'needs approval', resolveTool: 'orgx_decide', actionable: true }]);
    expect(readBlockers({ blocked_reason: 'rate limited' })).toEqual([
      { reason: 'rate limited' },
    ]);
  });

  it('drops empty entries and de-duplicates the single-field spelling', () => {
    expect(readBlockers({ blockers: ['', {}], blocker: 'only one' })).toEqual([
      { reason: 'only one' },
    ]);
  });
});

describe('summary', () => {
  it('counts each phase once', () => {
    const summary = summarize([
      node({ id: 'a', phase: 'executing' }),
      node({ id: 'b', phase: 'executing' }),
      node({ id: 'c', phase: 'pending' }),
      node({ id: 'd', phase: 'blocked' }),
      node({ id: 'e', phase: 'terminal' }),
    ]);
    expect(summary).toMatchObject({ running: 2, queued: 1, blocked: 1, done: 1, total: 5 });
  });

  it('counts a finished node with no reported progress as complete', () => {
    // Otherwise a feed that only reports progress for in-flight work reads as
    // *less* complete the more of it finishes.
    expect(summarize([node({ id: 'a', phase: 'terminal' })]).progress).toBe(100);
    expect(
      summarize([
        node({ id: 'a', phase: 'terminal' }),
        node({ id: 'b', phase: 'executing', progress: 50 }),
      ]).progress
    ).toBe(75);
  });

  it('reports zero progress for an empty graph rather than NaN', () => {
    expect(summarize([]).progress).toBe(0);
  });
});

describe('headline', () => {
  it('names the single blocked workstream and its reason', () => {
    const nodes = [
      node({ id: 'a', title: 'Deploy', phase: 'blocked', blockers: [{ reason: 'no creds' }] }),
      node({ id: 'b', phase: 'executing' }),
    ];
    expect(deriveHeadline(nodes, summarize(nodes))).toBe('Deploy is blocked — no creds');
  });

  it('prefers blocked work over running counts', () => {
    const nodes = [
      node({ id: 'a', phase: 'blocked', blockers: [{ reason: 'x' }] }),
      node({ id: 'b', phase: 'blocked', blockers: [{ reason: 'y' }] }),
      node({ id: 'c', phase: 'executing' }),
    ];
    expect(deriveHeadline(nodes, summarize(nodes))).toBe('2 workstreams blocked');
  });

  it('makes completion unmistakable instead of leaving it to be inferred', () => {
    const nodes = [node({ id: 'a', phase: 'terminal' })];
    expect(deriveHeadline(nodes, summarize(nodes))).toBe('All work complete');
  });

  it('says nothing for an empty graph', () => {
    expect(deriveHeadline([], summarize([]))).toBeUndefined();
  });
});

describe('feed registry', () => {
  it('derives the edge route pattern from the catalogue', () => {
    for (const type of FEED_TYPES) {
      const match = `/live-feed/${type}/init-123/stream`.match(FEED_ROUTE_PATTERN);
      expect(match, `${type} should route`).not.toBeNull();
      expect(match![1]).toBe(type);
      expect(match![2]).toBe('init-123');
    }
    expect('/live-feed/not-a-feed/x/stream'.match(FEED_ROUTE_PATTERN)).toBeNull();
    expect('/live-feed/agent-status/x/other'.match(FEED_ROUTE_PATTERN)).toBeNull();
  });

  it('encodes feed ids into upstream URLs', () => {
    const url = FEEDS['agent-status']!.buildUrl('a b/c', 'https://api.test');
    expect(url).toBe('https://api.test/api/live/agents?initiative=a%20b%2Fc');
  });

  it('returns null for unknown feeds without touching the prototype chain', () => {
    expect(getFeed('nope')).toBeNull();
    expect(getFeed('constructor')).toBeNull();
    expect(getFeed('agent-status')).not.toBeNull();
  });

  it('normalizes the agent payload into canonical nodes', () => {
    const graph = FEEDS['agent-status']!.normalize(
      {
        agents: [
          {
            id: 'eng-1',
            name: 'Engineering Autopilot',
            domain: 'engineering',
            status: 'running',
            currentTask: 'Implement SSE fan-out',
            progress: 62,
          },
          { id: 'ops-1', name: 'Control Tower', status: 'running', blockers: ['no creds'] },
        ],
      },
      'init-1'
    );
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toMatchObject({
      id: 'eng-1',
      kind: 'agent',
      phase: 'executing',
      progress: 62,
      domain: 'engineering',
    });
    // Reported as running upstream, but it has a blocker.
    expect(graph.nodes[1]!.phase).toBe('blocked');
    expect(graph.summary).toMatchObject({ running: 1, blocked: 1, total: 2 });
    expect(graph.headline).toContain('blocked');
  });

  it('normalizes snake_case and camelCase spellings identically', () => {
    const snake = FEEDS['agent-status']!.normalize(
      { agents: [{ agent_id: 'a', agent_name: 'A', current_task: 'T', status: 'running' }] },
      'i'
    );
    const camel = FEEDS['agent-status']!.normalize(
      { agents: [{ agentId: 'a', agentName: 'A', currentTask: 'T', status: 'running' }] },
      'i'
    );
    expect(snake.nodes[0]).toEqual(camel.nodes[0]);
  });

  it('puts the initiative at the root of the pulse graph', () => {
    const graph = FEEDS['initiative-pulse']!.normalize(
      {
        initiatives: [
          {
            id: 'init-9',
            title: 'Operation Prism',
            status: 'active',
            progress: 62,
            workstreams: [
              { name: 'SSE Infrastructure', status: 'done', progress: 100 },
              { name: 'Deploy', status: 'blocked', progress: 20 },
            ],
          },
        ],
      },
      'init-9'
    );
    expect(graph.nodes[0]).toMatchObject({ id: 'init-9', kind: 'initiative' });
    expect(graph.nodes[1]).toMatchObject({ kind: 'workstream', parentId: 'init-9' });
    expect(graph.title).toBe('Operation Prism');
  });

  it('ships only feeds whose upstream the DO can actually read', () => {
    // decisions and execution-room are intentionally absent: LiveFeedDO polls
    // with a service key and neither upstream accepts one, so registering them
    // would mean a widget subscribing to a feed that 401s on its first poll.
    expect(FEED_TYPES.sort()).toEqual(['agent-status', 'initiative-pulse']);
  });

  it('survives empty, null and unexpected payloads', () => {
    for (const type of FEED_TYPES) {
      const feed = FEEDS[type]!;
      for (const payload of [null, undefined, {}, [], 'text', 42, { agents: null }]) {
        const graph = feed.normalize(payload, 'id');
        expect(Array.isArray(graph.nodes)).toBe(true);
        expect(graph.summary.total).toBe(graph.nodes.length);
      }
    }
  });
});

describe('adaptive cadence', () => {
  const feed = FEEDS['agent-status']!;

  it('polls fast while work is executing', () => {
    const graph = buildWorkGraph({
      feedType: 'agent-status',
      feedId: 'i',
      nodes: [node({ id: 'a', phase: 'executing' })],
    });
    expect(cadenceFor(feed, graph)).toBe(feed.cadence.activeMs);
  });

  it('keeps the fast rate while work is blocked so the unblock is seen promptly', () => {
    const graph = buildWorkGraph({
      feedType: 'agent-status',
      feedId: 'i',
      nodes: [node({ id: 'a', phase: 'blocked' })],
    });
    expect(cadenceFor(feed, graph)).toBe(feed.cadence.activeMs);
  });

  it('drops to the idle rate once everything is resting', () => {
    const graph = buildWorkGraph({
      feedType: 'agent-status',
      feedId: 'i',
      nodes: [node({ id: 'a', phase: 'terminal' }), node({ id: 'b', phase: 'pending' })],
    });
    expect(cadenceFor(feed, graph)).toBe(feed.cadence.idleMs);
    expect(feed.cadence.idleMs).toBeGreaterThan(feed.cadence.activeMs);
  });

  it('polls at the active rate before the first snapshot exists', () => {
    expect(cadenceFor(feed, null)).toBe(feed.cadence.activeMs);
  });
});

describe('row-level deltas', () => {
  const graph = (nodes: WorkNode[]) =>
    buildWorkGraph({ feedType: 'agent-status', feedId: 'i', nodes, updatedAt: 'T' });

  it('sends only the nodes that moved', () => {
    const before = graph([
      node({ id: 'a', phase: 'executing', progress: 41 }),
      node({ id: 'b', phase: 'executing' }),
      node({ id: 'c', phase: 'pending' }),
    ]);
    const after = graph([
      node({ id: 'a', phase: 'executing', progress: 42 }),
      node({ id: 'b', phase: 'executing' }),
      node({ id: 'c', phase: 'pending' }),
    ]);
    const delta = diffGraphs(before, after);
    expect(delta).not.toBeNull();
    // One number moved; one row is sent, not three.
    expect(delta!.changed.map((n) => n.id)).toEqual(['a']);
    expect(delta!.removed).toEqual([]);
  });

  it('reports nothing when nothing changed', () => {
    const nodes = [node({ id: 'a', phase: 'executing', progress: 1 })];
    expect(diffGraphs(graph(nodes), graph(nodes))).toBeNull();
  });

  it('is not fooled by key reordering from the upstream serializer', () => {
    const a: WorkNode = { id: 'a', title: 'A', phase: 'executing', progress: 5 };
    const b: WorkNode = { progress: 5, phase: 'executing', title: 'A', id: 'a' };
    expect(nodeChanged(a, b)).toBe(false);
  });

  it('treats the first graph as an all-new delta', () => {
    const delta = diffGraphs(null, graph([node({ id: 'a' })]));
    expect(delta!.changed).toHaveLength(1);
  });

  it('reports removals', () => {
    const delta = diffGraphs(graph([node({ id: 'a' }), node({ id: 'b' })]), graph([node({ id: 'a' })]));
    expect(delta!.removed).toEqual(['b']);
  });

  it('notices blocker changes even when status is unchanged', () => {
    const before = graph([node({ id: 'a', phase: 'executing', status: 'running' })]);
    const after = graph([
      node({ id: 'a', phase: 'blocked', status: 'running', blockers: [{ reason: 'stuck' }] }),
    ]);
    expect(diffGraphs(before, after)!.changed.map((n) => n.id)).toEqual(['a']);
  });

  it('emits a delta when only the summary moved', () => {
    // Progress rollup shifts even when no individual node field this diff
    // inspects has changed; the header must still update.
    const before = graph([node({ id: 'a', phase: 'pending' })]);
    const after = graph([node({ id: 'a', phase: 'pending' }), node({ id: 'b', phase: 'pending' })]);
    const delta = diffGraphs(before, after);
    expect(delta!.summary.total).toBe(2);
  });

  it('converges: applying a delta stream equals the full snapshot', () => {
    // The property that makes shipping deltas instead of snapshots safe.
    const steps = [
      [node({ id: 'a', phase: 'pending' })],
      [node({ id: 'a', phase: 'executing', progress: 10 }), node({ id: 'b', phase: 'pending' })],
      [
        node({ id: 'a', phase: 'executing', progress: 80 }),
        node({ id: 'b', phase: 'blocked', blockers: [{ reason: 'waiting' }] }),
      ],
      [node({ id: 'a', phase: 'terminal', progress: 100 })],
    ];

    let replayed = graph(steps[0]!);
    let previous = graph(steps[0]!);
    for (const step of steps.slice(1)) {
      const next = graph(step);
      const delta = diffGraphs(previous, next);
      if (delta) replayed = applyDelta(replayed, delta);
      previous = next;
    }

    expect(replayed.nodes).toEqual(previous.nodes);
    expect(replayed.summary).toEqual(previous.summary);
    expect(replayed.headline).toEqual(previous.headline);
  });
});
