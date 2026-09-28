import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The live connection core is shipped as a plain script so widgets can load it
 * directly, so the tests load the real file rather than a TS port of it. A port
 * would be the thing under test drifting from the thing that ships.
 */

interface Transition {
  state: string;
  effects: string[];
  handled: boolean;
}

interface LiveMachine {
  STATES: Record<string, string>;
  EVENTS: Record<string, string>;
  EFFECTS: Record<string, string>;
  PHASES: Record<string, string>;
  transition(state: string, event: string): Transition;
  isLiveish(state: string): boolean;
  isDegraded(state: string): boolean;
  createBackoff(options?: Record<string, unknown>): {
    next(): number | null;
    reset(): void;
    attempts(): number;
    exhausted(): boolean;
  };
  reconcile(
    prev: unknown[],
    next: unknown[],
    keyFn?: (row: unknown, index: number) => string
  ): {
    entered: { key: string; position: number }[];
    updated: { key: string }[];
    exited: { key: string }[];
    moved: { key: string; from: number; to: number }[];
    keys: string[];
    changed: boolean;
  };
  phaseForStatus(status: unknown): string;
  phaseForRow(row: unknown): string;
  buildPhaseMap(rows: unknown[]): Record<string, string>;
  diffPhases(
    prev: Record<string, string> | null,
    rows: unknown[]
  ): {
    started: string[];
    finished: string[];
    blocked: string[];
    unblocked: string[];
    next: Record<string, string>;
    changed: boolean;
  };
  summarizePhases(rows: unknown[]): {
    running: number;
    queued: number;
    blocked: number;
    done: number;
    total: number;
  };
}

let M: LiveMachine;

beforeAll(() => {
  const source = readFileSync(
    join(__dirname, '..', 'public', 'widgets', 'shared', 'live-machine.js'),
    'utf8'
  );
  const scope = {} as { OrgXLiveMachine?: LiveMachine };
  new Function('globalThis', 'window', source).call(scope, scope, scope);
  if (!scope.OrgXLiveMachine) throw new Error('live-machine.js did not install');
  M = scope.OrgXLiveMachine;
});

describe('connection state machine', () => {
  it('walks the happy path idle → connecting → live', () => {
    const connect = M.transition(M.STATES.IDLE, M.EVENTS.CONNECT);
    expect(connect.state).toBe(M.STATES.CONNECTING);
    expect(connect.effects).toContain(M.EFFECTS.OPEN_STREAM);

    const open = M.transition(M.STATES.CONNECTING, M.EVENTS.OPEN);
    expect(open.state).toBe(M.STATES.LIVE);
    expect(open.effects).toContain(M.EFFECTS.RESET_BACKOFF);
  });

  it('treats data before open as an implicit open so no first frame is dropped', () => {
    const result = M.transition(M.STATES.CONNECTING, M.EVENTS.DATA);
    expect(result.state).toBe(M.STATES.LIVE);
    expect(result.effects).toContain(M.EFFECTS.EMIT_DATA);
  });

  it('routes auth_expired to a token refresh rather than plain backoff', () => {
    // The regression this whole machine exists to prevent: the server emits
    // auth_expired before a stream token's exp, and the old widgets ignored it.
    for (const from of [M.STATES.LIVE, M.STATES.CONNECTING, M.STATES.STALE]) {
      const result = M.transition(from, M.EVENTS.AUTH_EXPIRED);
      expect(result.state).toBe(M.STATES.REFRESHING);
      expect(result.effects).toContain(M.EFFECTS.REFRESH_TOKEN);
    }
  });

  it('reconnects after a refreshed token and backs off after a failed one', () => {
    const refreshed = M.transition(M.STATES.REFRESHING, M.EVENTS.TOKEN_REFRESHED);
    expect(refreshed.state).toBe(M.STATES.CONNECTING);
    expect(refreshed.effects).toContain(M.EFFECTS.OPEN_STREAM);

    const failed = M.transition(M.STATES.REFRESHING, M.EVENTS.REFRESH_FAILED);
    expect(failed.state).toBe(M.STATES.RECONNECTING);
    expect(failed.effects).toContain(M.EFFECTS.SCHEDULE_RETRY);
  });

  it('distinguishes a silent stream (stale) from an errored one (reconnecting)', () => {
    expect(M.transition(M.STATES.LIVE, M.EVENTS.HEARTBEAT_TIMEOUT).state).toBe(
      M.STATES.STALE
    );
    expect(M.transition(M.STATES.LIVE, M.EVENTS.ERROR).state).toBe(
      M.STATES.RECONNECTING
    );
    expect(M.isDegraded(M.STATES.STALE)).toBe(true);
    expect(M.isDegraded(M.STATES.LIVE)).toBe(false);
  });

  it('closes the stream whenever the host hides the widget, from any live state', () => {
    for (const from of [
      M.STATES.CONNECTING,
      M.STATES.LIVE,
      M.STATES.STALE,
      M.STATES.RECONNECTING,
    ]) {
      const result = M.transition(from, M.EVENTS.PAUSE);
      expect(result.state).toBe(M.STATES.PAUSED);
    }
    const resumed = M.transition(M.STATES.PAUSED, M.EVENTS.RESUME);
    expect(resumed.state).toBe(M.STATES.CONNECTING);
    expect(resumed.effects).toContain(M.EFFECTS.OPEN_STREAM);
  });

  it('stops retrying once fatal and only leaves on an explicit reconnect', () => {
    expect(M.transition(M.STATES.FATAL, M.EVENTS.ERROR).handled).toBe(false);
    expect(M.transition(M.STATES.FATAL, M.EVENTS.RETRY).handled).toBe(false);
    expect(M.transition(M.STATES.FATAL, M.EVENTS.CONNECT).state).toBe(
      M.STATES.CONNECTING
    );
  });

  it('reports unhandled events instead of silently swallowing them', () => {
    const result = M.transition(M.STATES.IDLE, M.EVENTS.DATA);
    expect(result.handled).toBe(false);
    expect(result.state).toBe(M.STATES.IDLE);
    expect(result.effects).toEqual([]);
  });

  it('never leaves a stream open when entering a non-streaming state', () => {
    // Any transition away from an active connection must close the transport,
    // or the widget leaks an EventSource per reconnect.
    const active = [M.STATES.CONNECTING, M.STATES.LIVE];
    const leaving = [M.EVENTS.ERROR, M.EVENTS.AUTH_EXPIRED, M.EVENTS.PAUSE, M.EVENTS.CLOSE];
    for (const state of active) {
      for (const event of leaving) {
        const result = M.transition(state, event);
        if (!result.handled) continue;
        expect(result.effects).toContain(M.EFFECTS.CLOSE_STREAM);
      }
    }
  });

  it('terminates in closed with no outgoing transitions', () => {
    for (const event of Object.keys(M.EVENTS)) {
      expect(M.transition(M.STATES.CLOSED, M.EVENTS[event]!).handled).toBe(false);
    }
  });
});

describe('backoff', () => {
  it('grows exponentially and clamps at the cap', () => {
    const backoff = M.createBackoff({
      baseMs: 1000,
      capMs: 8000,
      jitter: 0,
      random: () => 0.5,
    });
    expect(backoff.next()).toBe(1000);
    expect(backoff.next()).toBe(2000);
    expect(backoff.next()).toBe(4000);
    expect(backoff.next()).toBe(8000);
    expect(backoff.next()).toBe(8000);
  });

  it('spreads reconnects with jitter so simultaneous drops do not sync up', () => {
    const low = M.createBackoff({ baseMs: 1000, jitter: 0.5, random: () => 0 });
    const high = M.createBackoff({ baseMs: 1000, jitter: 0.5, random: () => 1 });
    expect(low.next()).toBe(750);
    expect(high.next()).toBe(1250);
  });

  it('resets after a successful connection', () => {
    const backoff = M.createBackoff({ baseMs: 1000, jitter: 0, random: () => 0.5 });
    backoff.next();
    backoff.next();
    expect(backoff.attempts()).toBe(2);
    backoff.reset();
    expect(backoff.attempts()).toBe(0);
    expect(backoff.next()).toBe(1000);
  });

  it('gives up after maxAttempts so a dead endpoint goes fatal', () => {
    const backoff = M.createBackoff({ maxAttempts: 2, jitter: 0 });
    expect(backoff.next()).not.toBeNull();
    expect(backoff.next()).not.toBeNull();
    expect(backoff.next()).toBeNull();
    expect(backoff.exhausted()).toBe(true);
  });
});

describe('keyed reconciliation', () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id, status: 'running' }));

  it('classifies enters, exits and updates by key', () => {
    const result = M.reconcile(
      [
        { id: 'a', status: 'queued' },
        { id: 'b', status: 'running' },
      ],
      [
        { id: 'a', status: 'running' },
        { id: 'c', status: 'queued' },
      ]
    );
    expect(result.updated.map((u) => u.key)).toEqual(['a']);
    expect(result.entered.map((e) => e.key)).toEqual(['c']);
    expect(result.exited.map((e) => e.key)).toEqual(['b']);
    expect(result.changed).toBe(true);
  });

  it('reports no change for an identical snapshot so the DOM is left alone', () => {
    const before = rows('a', 'b', 'c');
    const after = rows('a', 'b', 'c');
    const result = M.reconcile(before, after);
    expect(result.changed).toBe(false);
    expect(result.updated).toEqual([]);
    expect(result.moved).toEqual([]);
  });

  it('detects reordering separately from content changes', () => {
    const result = M.reconcile(rows('a', 'b'), rows('b', 'a'));
    expect(result.updated).toEqual([]);
    expect(result.moved.map((m) => m.key).sort()).toEqual(['a', 'b']);
    expect(result.keys).toEqual(['b', 'a']);
  });

  it('compares one level of nesting so nested payload edits are not missed', () => {
    const result = M.reconcile(
      [{ id: 'a', meta: { task: 'old' } }],
      [{ id: 'a', meta: { task: 'new' } }]
    );
    expect(result.updated.map((u) => u.key)).toEqual(['a']);
  });

  it('falls back to positional keys for rows with no identity', () => {
    const result = M.reconcile([{ label: 'x' }], [{ label: 'y' }]);
    expect(result.updated.map((u) => u.key)).toEqual(['idx:0']);
  });

  it('handles null and undefined snapshots without throwing', () => {
    expect(M.reconcile(null as never, rows('a')).entered).toHaveLength(1);
    expect(M.reconcile(rows('a'), null as never).exited).toHaveLength(1);
  });
});

// The status vocabulary itself lives in tests/statusVocabulary.spec.ts, which
// checks every spelling against BOTH the client and the server. What is left
// here is phase *semantics*: how a row is classified once its status is known.
describe('work phases', () => {
  it('treats blocked and approval-waiting work as its own phase, never as pending', () => {
    // A blocked workstream is the most action-relevant row on the screen;
    // collapsing it into "pending" is how it gets missed.
    expect(M.phaseForStatus('blocked')).toBe(M.PHASES.BLOCKED);
    expect(M.phaseForStatus('needs_approval')).toBe(M.PHASES.BLOCKED);
    expect(M.phaseForStatus('AWAITING_INPUT')).toBe(M.PHASES.BLOCKED);
    expect(M.phaseForRow({ isBlocked: true })).toBe(M.PHASES.BLOCKED);
  });

  it('prefers lifecycle booleans over status strings', () => {
    expect(M.phaseForRow({ isCompleted: true, status: 'running' })).toBe(
      M.PHASES.TERMINAL
    );
    expect(M.phaseForRow({ isExecuting: true })).toBe(M.PHASES.EXECUTING);
  });

  it('reports only boundaries into executing, terminal and blocked', () => {
    const first = M.diffPhases(null, [
      { id: 'a', status: 'queued' },
      { id: 'b', status: 'running' },
    ]);
    // `b` ignited on first sight; `a` arriving already queued is not news.
    expect(first.started).toEqual(['b']);
    expect(first.finished).toEqual([]);

    const second = M.diffPhases(first.next, [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'completed' },
    ]);
    expect(second.started).toEqual(['a']);
    expect(second.finished).toEqual(['b']);
    expect(second.changed).toBe(true);
  });

  it('ignores churn inside a phase so the surface does not flicker', () => {
    // RUNNING and IN_PROGRESS are the same phase under different names, which
    // upstreams do swap between. (EXECUTING → WAITING used to stand in here,
    // but a bare "waiting" means waiting on someone and is now blocked — a real
    // boundary, and news worth showing.)
    const first = M.diffPhases(null, [{ id: 'a', status: 'RUNNING' }]);
    const second = M.diffPhases(first.next, [{ id: 'a', status: 'IN_PROGRESS' }]);
    expect(second.changed).toBe(false);
    expect(second.started).toEqual([]);
  });

  it('treats a bare waiting status as a block, because it is one', () => {
    const first = M.diffPhases(null, [{ id: 'a', status: 'RUNNING' }]);
    const second = M.diffPhases(first.next, [{ id: 'a', status: 'waiting' }]);
    expect(second.blocked).toEqual(['a']);
  });

  it('reports a block and the later unblock', () => {
    const running = M.diffPhases(null, [{ id: 'a', status: 'running' }]);
    const blocked = M.diffPhases(running.next, [{ id: 'a', status: 'blocked' }]);
    expect(blocked.blocked).toEqual(['a']);
    const resumed = M.diffPhases(blocked.next, [{ id: 'a', status: 'running' }]);
    expect(resumed.unblocked).toEqual(['a']);
    expect(resumed.started).toEqual(['a']);
  });

  it('ignores rows that disappeared from the window', () => {
    const first = M.diffPhases(null, [{ id: 'a', status: 'running' }]);
    const second = M.diffPhases(first.next, []);
    expect(second.changed).toBe(false);
    expect(second.finished).toEqual([]);
  });

  it('produces the one header summary every widget shares', () => {
    const summary = M.summarizePhases([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
      { id: 'c', status: 'queued' },
      { id: 'd', status: 'blocked' },
      { id: 'e', status: 'completed' },
    ]);
    expect(summary).toEqual({ running: 2, queued: 1, blocked: 1, done: 1, total: 5 });
  });
});
