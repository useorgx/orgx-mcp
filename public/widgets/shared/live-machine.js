(function installOrgXLiveMachine(global) {
  'use strict';

  if (global.OrgXLiveMachine) return;

  // ===========================================================================
  // Connection state machine
  //
  // Every live widget shares one explicit, table-driven machine so the states a
  // stream can be in are enumerable and the illegal ones are unrepresentable.
  // Before this existed each widget open-coded `es.onerror` + a retry timer,
  // which is why `auth_expired` went unhandled for a year: there was no single
  // place that owned "what happens next".
  //
  //   idle ──CONNECT──▶ connecting ──OPEN──▶ live
  //                          │                 │
  //                          │              STALE (heartbeat gap)
  //                          │                 │
  //                          ├──ERROR──▶ reconnecting ──RETRY──▶ connecting
  //                          │
  //                          └──AUTH_EXPIRED──▶ refreshing ──TOKEN──▶ connecting
  //
  // `paused` is entered whenever the host hides the widget: a backgrounded
  // iframe must not hold an open stream or burn poll cycles. `fatal` is
  // terminal — the widget stops retrying and shows a manual retry affordance
  // rather than hammering a server that has told us no.
  // ===========================================================================

  var STATES = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    LIVE: 'live',
    STALE: 'stale',
    RECONNECTING: 'reconnecting',
    REFRESHING: 'refreshing',
    PAUSED: 'paused',
    FATAL: 'fatal',
    CLOSED: 'closed',
  };

  var EVENTS = {
    CONNECT: 'CONNECT',
    OPEN: 'OPEN',
    DATA: 'DATA',
    HEARTBEAT_TIMEOUT: 'HEARTBEAT_TIMEOUT',
    ERROR: 'ERROR',
    AUTH_EXPIRED: 'AUTH_EXPIRED',
    TOKEN_REFRESHED: 'TOKEN_REFRESHED',
    REFRESH_FAILED: 'REFRESH_FAILED',
    RETRY: 'RETRY',
    PAUSE: 'PAUSE',
    RESUME: 'RESUME',
    FATAL: 'FATAL',
    CLOSE: 'CLOSE',
  };

  // Effects are declarative: the machine names what should happen, the store
  // performs it. Keeping side effects out of the transition table is what makes
  // the table testable without a network or a DOM.
  var EFFECTS = {
    OPEN_STREAM: 'openStream',
    CLOSE_STREAM: 'closeStream',
    SCHEDULE_RETRY: 'scheduleRetry',
    CANCEL_RETRY: 'cancelRetry',
    REFRESH_TOKEN: 'refreshToken',
    RESET_BACKOFF: 'resetBackoff',
    ARM_HEARTBEAT: 'armHeartbeat',
    CLEAR_HEARTBEAT: 'clearHeartbeat',
    EMIT_DATA: 'emitData',
  };

  // Terminal + paused states accept a narrow event set; anything else is a
  // no-op rather than an exception, because hosts fire lifecycle events in
  // orders no widget can control.
  var TABLE = {};

  TABLE[STATES.IDLE] = {};
  TABLE[STATES.IDLE][EVENTS.CONNECT] = {
    next: STATES.CONNECTING,
    effects: [EFFECTS.OPEN_STREAM, EFFECTS.ARM_HEARTBEAT],
  };
  TABLE[STATES.IDLE][EVENTS.PAUSE] = { next: STATES.PAUSED, effects: [] };
  // A store can fail before it ever opens — an unsupported transport, or a
  // missing stream URL — and must be able to say so rather than sitting in
  // `idle` looking like it simply had not started yet.
  TABLE[STATES.IDLE][EVENTS.FATAL] = { next: STATES.FATAL, effects: [] };
  // A store can start with a grant whose token already expired — a widget that
  // was hidden across the expiry. Without this it would sit in `idle` having
  // silently dropped the refresh it asked for.
  TABLE[STATES.IDLE][EVENTS.AUTH_EXPIRED] = {
    next: STATES.REFRESHING,
    effects: [EFFECTS.REFRESH_TOKEN],
  };

  TABLE[STATES.CONNECTING] = {};
  TABLE[STATES.CONNECTING][EVENTS.OPEN] = {
    next: STATES.LIVE,
    effects: [EFFECTS.RESET_BACKOFF, EFFECTS.ARM_HEARTBEAT],
  };
  // Some hosts deliver the first frame before the open event. Data is proof of
  // a working stream, so treat it as an implicit OPEN instead of dropping it.
  TABLE[STATES.CONNECTING][EVENTS.DATA] = {
    next: STATES.LIVE,
    effects: [EFFECTS.RESET_BACKOFF, EFFECTS.EMIT_DATA, EFFECTS.ARM_HEARTBEAT],
  };
  TABLE[STATES.CONNECTING][EVENTS.ERROR] = {
    next: STATES.RECONNECTING,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.SCHEDULE_RETRY],
  };
  TABLE[STATES.CONNECTING][EVENTS.AUTH_EXPIRED] = {
    next: STATES.REFRESHING,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.REFRESH_TOKEN],
  };
  TABLE[STATES.CONNECTING][EVENTS.HEARTBEAT_TIMEOUT] = {
    next: STATES.RECONNECTING,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.SCHEDULE_RETRY],
  };
  TABLE[STATES.CONNECTING][EVENTS.PAUSE] = {
    next: STATES.PAUSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.CONNECTING][EVENTS.FATAL] = {
    next: STATES.FATAL,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.CONNECTING][EVENTS.CLOSE] = {
    next: STATES.CLOSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };

  TABLE[STATES.LIVE] = {};
  TABLE[STATES.LIVE][EVENTS.DATA] = {
    next: STATES.LIVE,
    effects: [EFFECTS.EMIT_DATA, EFFECTS.ARM_HEARTBEAT],
  };
  // A heartbeat gap means the transport is silent but not errored. Surfacing
  // `stale` rather than `reconnecting` keeps the widget honest — the data on
  // screen is still the last known truth, it just may have aged.
  TABLE[STATES.LIVE][EVENTS.HEARTBEAT_TIMEOUT] = {
    next: STATES.STALE,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.SCHEDULE_RETRY],
  };
  TABLE[STATES.LIVE][EVENTS.ERROR] = {
    next: STATES.RECONNECTING,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.SCHEDULE_RETRY],
  };
  TABLE[STATES.LIVE][EVENTS.AUTH_EXPIRED] = {
    next: STATES.REFRESHING,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.REFRESH_TOKEN],
  };
  TABLE[STATES.LIVE][EVENTS.PAUSE] = {
    next: STATES.PAUSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.LIVE][EVENTS.FATAL] = {
    next: STATES.FATAL,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.LIVE][EVENTS.CLOSE] = {
    next: STATES.CLOSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };

  TABLE[STATES.STALE] = {};
  TABLE[STATES.STALE][EVENTS.RETRY] = {
    next: STATES.CONNECTING,
    effects: [EFFECTS.OPEN_STREAM, EFFECTS.ARM_HEARTBEAT],
  };
  TABLE[STATES.STALE][EVENTS.DATA] = {
    next: STATES.LIVE,
    effects: [EFFECTS.RESET_BACKOFF, EFFECTS.EMIT_DATA, EFFECTS.ARM_HEARTBEAT],
  };
  TABLE[STATES.STALE][EVENTS.ERROR] = {
    next: STATES.RECONNECTING,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.SCHEDULE_RETRY],
  };
  TABLE[STATES.STALE][EVENTS.AUTH_EXPIRED] = {
    next: STATES.REFRESHING,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.REFRESH_TOKEN],
  };
  TABLE[STATES.STALE][EVENTS.PAUSE] = {
    next: STATES.PAUSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.STALE][EVENTS.FATAL] = {
    next: STATES.FATAL,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.STALE][EVENTS.CLOSE] = {
    next: STATES.CLOSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CLEAR_HEARTBEAT, EFFECTS.CANCEL_RETRY],
  };

  TABLE[STATES.RECONNECTING] = {};
  TABLE[STATES.RECONNECTING][EVENTS.RETRY] = {
    next: STATES.CONNECTING,
    effects: [EFFECTS.OPEN_STREAM, EFFECTS.ARM_HEARTBEAT],
  };
  TABLE[STATES.RECONNECTING][EVENTS.PAUSE] = {
    next: STATES.PAUSED,
    effects: [EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.RECONNECTING][EVENTS.FATAL] = {
    next: STATES.FATAL,
    effects: [EFFECTS.CANCEL_RETRY, EFFECTS.CLOSE_STREAM],
  };
  TABLE[STATES.RECONNECTING][EVENTS.AUTH_EXPIRED] = {
    next: STATES.REFRESHING,
    effects: [EFFECTS.CANCEL_RETRY, EFFECTS.REFRESH_TOKEN],
  };
  TABLE[STATES.RECONNECTING][EVENTS.CLOSE] = {
    next: STATES.CLOSED,
    effects: [EFFECTS.CANCEL_RETRY, EFFECTS.CLOSE_STREAM],
  };

  // `refreshing` is the state the old code was missing entirely. The server
  // emits `event: auth_expired` ~10s before a stream token's exp; the only way
  // a sandboxed widget can obtain a fresh token is to re-invoke its bound MCP
  // tool, so the tool call *is* the refresh mechanism.
  TABLE[STATES.REFRESHING] = {};
  TABLE[STATES.REFRESHING][EVENTS.TOKEN_REFRESHED] = {
    next: STATES.CONNECTING,
    effects: [EFFECTS.RESET_BACKOFF, EFFECTS.OPEN_STREAM, EFFECTS.ARM_HEARTBEAT],
  };
  // A failed refresh falls back to plain backoff rather than going fatal: the
  // failure is usually a transient host hiccup, not a revoked grant.
  TABLE[STATES.REFRESHING][EVENTS.REFRESH_FAILED] = {
    next: STATES.RECONNECTING,
    effects: [EFFECTS.SCHEDULE_RETRY],
  };
  TABLE[STATES.REFRESHING][EVENTS.PAUSE] = { next: STATES.PAUSED, effects: [] };
  TABLE[STATES.REFRESHING][EVENTS.FATAL] = {
    next: STATES.FATAL,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CANCEL_RETRY],
  };
  TABLE[STATES.REFRESHING][EVENTS.CLOSE] = {
    next: STATES.CLOSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CANCEL_RETRY],
  };

  TABLE[STATES.PAUSED] = {};
  TABLE[STATES.PAUSED][EVENTS.RESUME] = {
    next: STATES.CONNECTING,
    effects: [EFFECTS.RESET_BACKOFF, EFFECTS.OPEN_STREAM, EFFECTS.ARM_HEARTBEAT],
  };
  // A widget hidden across its token's expiry resumes into a refresh, not into
  // a doomed reconnect. Without this the store's resume-time AUTH_EXPIRED was
  // dropped as illegal and the widget stayed paused for good.
  TABLE[STATES.PAUSED][EVENTS.AUTH_EXPIRED] = {
    next: STATES.REFRESHING,
    effects: [EFFECTS.REFRESH_TOKEN],
  };
  TABLE[STATES.PAUSED][EVENTS.CLOSE] = {
    next: STATES.CLOSED,
    effects: [EFFECTS.CLOSE_STREAM, EFFECTS.CANCEL_RETRY],
  };

  // Fatal is escapable only by an explicit operator retry, which re-enters via
  // CONNECT. That keeps "the server said stop" distinct from "the network
  // blipped" in both the UI and the logs.
  TABLE[STATES.FATAL] = {};
  TABLE[STATES.FATAL][EVENTS.CONNECT] = {
    next: STATES.CONNECTING,
    effects: [EFFECTS.RESET_BACKOFF, EFFECTS.OPEN_STREAM, EFFECTS.ARM_HEARTBEAT],
  };
  TABLE[STATES.FATAL][EVENTS.CLOSE] = { next: STATES.CLOSED, effects: [] };

  TABLE[STATES.CLOSED] = {};

  /**
   * Pure transition. Returns the next state plus the effects the caller should
   * run, and `handled: false` when the event is not legal in this state so the
   * store can log it as a protocol anomaly instead of silently dropping it.
   */
  function transition(state, event) {
    var row = TABLE[state];
    var entry = row ? row[event] : null;
    if (!entry) {
      return { state: state, effects: [], handled: false };
    }
    return { state: entry.next, effects: entry.effects.slice(), handled: true };
  }

  /** Every state a widget may render a connection chip for. */
  function isLiveish(state) {
    return state === STATES.LIVE || state === STATES.CONNECTING;
  }

  /** True when the data on screen should be treated as possibly aged. */
  function isDegraded(state) {
    return (
      state === STATES.STALE ||
      state === STATES.RECONNECTING ||
      state === STATES.REFRESHING
    );
  }

  // ===========================================================================
  // Backoff
  //
  // Jitter matters more here than it looks: a single OrgX initiative can have
  // one widget open per participant, and a DO restart drops them all at once.
  // Deterministic backoff would reconnect them in lockstep forever.
  // ===========================================================================

  function createBackoff(options) {
    var opts = options || {};
    var base = opts.baseMs || 1000;
    var cap = opts.capMs || 30000;
    var factor = opts.factor || 2;
    var jitter = opts.jitter === undefined ? 0.3 : opts.jitter;
    var random = opts.random || Math.random;
    var maxAttempts = opts.maxAttempts || 0; // 0 = unlimited
    var attempt = 0;

    return {
      /** Next delay in ms, or null once maxAttempts is exhausted. */
      next: function next() {
        if (maxAttempts && attempt >= maxAttempts) return null;
        var raw = Math.min(cap, base * Math.pow(factor, attempt));
        attempt += 1;
        var spread = raw * jitter;
        return Math.round(raw - spread / 2 + random() * spread);
      },
      reset: function reset() {
        attempt = 0;
      },
      attempts: function attempts() {
        return attempt;
      },
      exhausted: function exhausted() {
        return Boolean(maxAttempts) && attempt >= maxAttempts;
      },
    };
  }

  // ===========================================================================
  // Keyed reconciliation
  //
  // The layout-shift fix. Widgets used to re-render a whole list on every delta,
  // which throws away scroll position, focus, and in-flight CSS transitions, and
  // reflows the iframe so the host resizes it mid-read. Reconciling to
  // enter/update/exit/move lets a widget patch only what changed and animate
  // only what genuinely moved.
  // ===========================================================================

  function defaultKey(row, index) {
    if (row && typeof row === 'object') {
      if (row.id !== undefined && row.id !== null) return String(row.id);
      if (row.key !== undefined && row.key !== null) return String(row.key);
    }
    return 'idx:' + index;
  }

  function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    var aKeys = Object.keys(a);
    var bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (var i = 0; i < aKeys.length; i += 1) {
      var key = aKeys[i];
      var av = a[key];
      var bv = b[key];
      if (av === bv) continue;
      // One level deep is enough for feed rows and avoids a JSON.stringify per
      // row per tick, which showed up as the hot path with ~60 agents.
      if (av && bv && typeof av === 'object' && typeof bv === 'object') {
        if (JSON.stringify(av) === JSON.stringify(bv)) continue;
      }
      return false;
    }
    return true;
  }

  /**
   * Diff two keyed lists.
   *
   * Returns `entered`, `updated`, `exited`, `moved` and the ordered `keys`, so a
   * renderer can decide independently how loud each class of change should be:
   * entered rows fade in, updated rows flash a value, exited rows collapse, and
   * moved rows animate to position.
   */
  function reconcile(prevRows, nextRows, keyFn) {
    var key = keyFn || defaultKey;
    var prev = Array.isArray(prevRows) ? prevRows : [];
    var next = Array.isArray(nextRows) ? nextRows : [];

    // Null-prototype: a row keyed "constructor" or "__proto__" would otherwise
    // resolve an inherited member and read as an already-present entry.
    var prevIndex = Object.create(null);
    var prevOrder = [];
    for (var i = 0; i < prev.length; i += 1) {
      var pk = key(prev[i], i);
      prevIndex[pk] = { row: prev[i], position: i };
      prevOrder.push(pk);
    }

    var entered = [];
    var updated = [];
    var moved = [];
    var keys = [];
    var seen = Object.create(null);

    for (var j = 0; j < next.length; j += 1) {
      var nk = key(next[j], j);
      keys.push(nk);
      seen[nk] = true;
      var before = prevIndex[nk];
      if (!before) {
        entered.push({ key: nk, row: next[j], position: j });
        continue;
      }
      if (!shallowEqual(before.row, next[j])) {
        updated.push({ key: nk, row: next[j], prev: before.row, position: j });
      }
      if (before.position !== j) {
        moved.push({ key: nk, row: next[j], from: before.position, to: j });
      }
    }

    var exited = [];
    for (var k = 0; k < prevOrder.length; k += 1) {
      if (!seen[prevOrder[k]]) {
        exited.push({ key: prevOrder[k], row: prevIndex[prevOrder[k]].row });
      }
    }

    return {
      entered: entered,
      updated: updated,
      exited: exited,
      moved: moved,
      keys: keys,
      changed:
        entered.length > 0 ||
        updated.length > 0 ||
        exited.length > 0 ||
        moved.length > 0,
    };
  }

  // ===========================================================================
  // Work phases + boundary diffing
  //
  // Mirrors orgx/lib/live/executionRoomRealtimeClient.ts so a widget and the
  // /live execution room classify the same run the same way. Only boundaries
  // *into* `executing` and *into* `terminal` are worth announcing; churn inside
  // a phase is noise, and treating it as news is what makes a live surface feel
  // jittery instead of alive.
  // ===========================================================================

  var PHASES = {
    PENDING: 'pending',
    EXECUTING: 'executing',
    TERMINAL: 'terminal',
    BLOCKED: 'blocked',
  };

  // These sets are a superset of the vocabulary in shared/widget-state.js, and
  // must stay that way: both run on the same page, so a status either one
  // recognizes but the other does not means the panel and the surrounding card
  // can show the same node in different states. tests/statusVocabulary.spec.ts
  // pins the agreement.
  var EXECUTING_STATUSES = {
    EXECUTING: 1,
    REEXECUTING: 1,
    RUNNING: 1,
    IN_PROGRESS: 1,
    ACTIVE: 1,
    STREAMING: 1,
    WORKING: 1,
  };

  var TERMINAL_STATUSES = {
    COMPLETED: 1,
    COMPLETE: 1,
    DONE: 1,
    CANCELED: 1,
    CANCELLED: 1,
    FAILED: 1,
    CRASHED: 1,
    SYSTEM_FAILURE: 1,
    EXPIRED: 1,
    TIMED_OUT: 1,
    INTERRUPTED: 1,
    SHIPPED: 1,
    APPROVED: 1,
    RESOLVED: 1,
    SUCCESS: 1,
  };

  // Blocked is a first-class phase here even though Trigger has no such run
  // status, because in OrgX a blocked workstream is the single most
  // action-relevant thing a founder can see and must never be filed under
  // "pending".
  var BLOCKED_STATUSES = {
    BLOCKED: 1,
    NEEDS_APPROVAL: 1,
    AWAITING_APPROVAL: 1,
    AWAITING_INPUT: 1,
    NEEDS_ATTENTION: 1,
    ESCALATED: 1,
    AT_RISK: 1,
    PAUSED: 1,
    NEEDS_INPUT: 1,
    NEEDS_REVIEW: 1,
    // A bare "waiting" status means waiting on someone, which is blocked.
    // Trigger's WAITING run state means something else — suspended on a child
    // while still executing — and reaches us as the `isWaiting` lifecycle
    // boolean, which phaseForRow reads before it ever looks at this table.
    WAITING: 1,
  };

  function phaseForStatus(status) {
    if (!status) return PHASES.PENDING;
    var normalized = String(status).toUpperCase().replace(/[\s-]+/g, '_');
    if (BLOCKED_STATUSES[normalized]) return PHASES.BLOCKED;
    if (TERMINAL_STATUSES[normalized]) return PHASES.TERMINAL;
    if (EXECUTING_STATUSES[normalized]) return PHASES.EXECUTING;
    return PHASES.PENDING;
  }

  /** True when a value is already one of our own canonical phase names. */
  function isCanonicalPhase(value) {
    return (
      value === PHASES.PENDING ||
      value === PHASES.EXECUTING ||
      value === PHASES.BLOCKED ||
      value === PHASES.TERMINAL
    );
  }

  function phaseForRow(row) {
    if (!row || typeof row !== 'object') return PHASES.PENDING;
    // A node normalized by src/live/workGraph.ts already carries a canonical
    // phase. Re-deriving it from the status vocabulary would mis-bucket it —
    // "terminal" is not a word any upstream status set contains, so it used to
    // fall through to pending and a finished row counted as queued.
    if (isCanonicalPhase(row.phase)) return row.phase;
    if (row.isCompleted || row.isFailed || row.isCancelled) return PHASES.TERMINAL;
    if (row.isBlocked) return PHASES.BLOCKED;
    if (row.isExecuting || row.isWaiting) return PHASES.EXECUTING;
    if (row.isQueued) return PHASES.PENDING;
    return phaseForStatus(row.phase || row.status || row.state);
  }

  function buildPhaseMap(rows, keyFn) {
    var key = keyFn || defaultKey;
    var map = Object.create(null);
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i += 1) {
      map[key(list[i], i)] = phaseForRow(list[i]);
    }
    return map;
  }

  /**
   * Report which rows crossed a phase boundary since the previous snapshot.
   *
   * A row `started` when it enters `executing` from anything else (including
   * first sight, so a run we subscribe to mid-flight still registers),
   * `finished` on entry to `terminal`, and `blocked` on entry to `blocked`.
   * A brand-new row that arrives already `pending` is not a boundary — nothing
   * has ignited yet. Rows that vanished are ignored: their terminal transition
   * was already reported while they were present.
   */
  function diffPhases(prevMap, rows, keyFn) {
    var key = keyFn || defaultKey;
    var prev = prevMap || Object.create(null);
    var next = buildPhaseMap(rows, key);
    var started = [];
    var finished = [];
    var blocked = [];
    var unblocked = [];

    var keys = Object.keys(next);
    for (var i = 0; i < keys.length; i += 1) {
      var id = keys[i];
      var before = prev[id];
      var after = next[id];
      if (before === after) continue;
      if (after === PHASES.EXECUTING) {
        started.push(id);
        if (before === PHASES.BLOCKED) unblocked.push(id);
      } else if (after === PHASES.TERMINAL) {
        finished.push(id);
      } else if (after === PHASES.BLOCKED) {
        blocked.push(id);
      }
    }

    return {
      started: started,
      finished: finished,
      blocked: blocked,
      unblocked: unblocked,
      next: next,
      changed:
        started.length > 0 ||
        finished.length > 0 ||
        blocked.length > 0,
    };
  }

  /**
   * Roll a set of rows into the counts every live widget headers with. Computed
   * once here so `3 running · 2 queued · 1 blocked` cannot disagree between the
   * agent-status widget, the initiative pulse, and the /live room.
   */
  function summarizePhases(rows, keyFn) {
    var map = buildPhaseMap(rows, keyFn);
    var summary = { running: 0, queued: 0, blocked: 0, done: 0, total: 0 };
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i += 1) {
      summary.total += 1;
      var phase = map[keys[i]];
      if (phase === PHASES.EXECUTING) summary.running += 1;
      else if (phase === PHASES.BLOCKED) summary.blocked += 1;
      else if (phase === PHASES.TERMINAL) summary.done += 1;
      else summary.queued += 1;
    }
    return summary;
  }

  // ===========================================================================
  // Delta folding
  //
  // LiveFeedDO sends a full snapshot once, then row-level deltas naming only the
  // nodes that moved. Folding belongs here rather than in each widget: a widget
  // that rendered a delta directly would drop every node the delta did not
  // mention. Kept pure so the convergence property — a delta stream lands on the
  // same state as a snapshot — is testable.
  // ===========================================================================

  function isWorkGraph(payload) {
    return Boolean(payload && Array.isArray(payload.nodes) && payload.summary);
  }

  /**
   * A canonical node delta, as opposed to a full graph. The SSE frame's `type`
   * cannot be trusted alone: legacy `delta` frames carried whole payloads, so
   * discriminate on the delta's own fields.
   */
  function isNodeDelta(payload) {
    return Boolean(
      payload &&
        !Array.isArray(payload.nodes) &&
        (Array.isArray(payload.changed) || Array.isArray(payload.removed))
    );
  }

  /**
   * Apply a node delta to a held graph. Returns null when there is no base to
   * fold onto — which happens on a `since=` reconnect that replays deltas from
   * before this client attached. Rendering a partial graph would be worse than
   * waiting for the next snapshot.
   */
  function foldGraphDelta(base, delta) {
    if (!base || !delta) return null;
    var byId = Object.create(null);
    var order = [];
    var index;

    for (index = 0; index < base.nodes.length; index += 1) {
      byId[base.nodes[index].id] = base.nodes[index];
      order.push(base.nodes[index].id);
    }

    var changed = delta.changed || [];
    for (index = 0; index < changed.length; index += 1) {
      if (!byId[changed[index].id]) order.push(changed[index].id);
      byId[changed[index].id] = changed[index];
    }

    var removed = delta.removed || [];
    for (index = 0; index < removed.length; index += 1) {
      delete byId[removed[index]];
    }

    // The server's order when it sent one. Appending locally cannot express a
    // reorder, and put a node the server prepended at the bottom instead.
    if (Array.isArray(delta.order) && delta.order.length) order = delta.order;

    var nodes = [];
    for (index = 0; index < order.length; index += 1) {
      if (byId[order[index]]) nodes.push(byId[order[index]]);
    }

    return {
      feedType: base.feedType,
      feedId: base.feedId,
      title: delta.title || base.title,
      nodes: nodes,
      summary: delta.summary || base.summary,
      headline: delta.headline,
      updatedAt: delta.updatedAt || base.updatedAt,
      // A delta that mentions the handoff wins, including `null` for "withdrawn".
      // Falling back to the base on anything but `undefined` would leave a CTA
      // on screen after the server removed it.
      proofHandoff:
        delta.proofHandoff !== undefined
          ? delta.proofHandoff || undefined
          : base.proofHandoff,
    };
  }

  global.OrgXLiveMachine = {
    STATES: STATES,
    EVENTS: EVENTS,
    EFFECTS: EFFECTS,
    PHASES: PHASES,
    transition: transition,
    isWorkGraph: isWorkGraph,
    isNodeDelta: isNodeDelta,
    foldGraphDelta: foldGraphDelta,
    isLiveish: isLiveish,
    isDegraded: isDegraded,
    createBackoff: createBackoff,
    reconcile: reconcile,
    shallowEqual: shallowEqual,
    defaultKey: defaultKey,
    phaseForStatus: phaseForStatus,
    phaseForRow: phaseForRow,
    isCanonicalPhase: isCanonicalPhase,
    buildPhaseMap: buildPhaseMap,
    diffPhases: diffPhases,
    summarizePhases: summarizePhases,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
