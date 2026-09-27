(function installOrgXLiveStore(global) {
  'use strict';

  if (global.OrgXLiveStore) return;

  var machine = global.OrgXLiveMachine;
  if (!machine) {
    throw new Error('live-store.js requires live-machine.js to be loaded first');
  }

  var STATES = machine.STATES;
  var EVENTS = machine.EVENTS;
  var EFFECTS = machine.EFFECTS;

  // A stream token is valid for an hour and the server warns ~10s before exp.
  // The watchdog window has to be comfortably longer than the DO's 15s
  // heartbeat or a healthy-but-quiet stream would be declared stale.
  var HEARTBEAT_WATCHDOG_MS = 45000;
  var MAX_RECONNECT_ATTEMPTS = 8;
  var LOG_RING_SIZE = 100;

  // ===========================================================================
  // Structured logging
  //
  // Widgets run inside a sandboxed iframe in someone else's client, which means
  // a bug reproduces on a machine no one on the team can attach a debugger to.
  // Every record is therefore a flat, serializable object with a stable field
  // set, kept in a ring buffer the widget can dump on demand and optionally
  // forwarded to a sink. Free-text console.log was not diagnosable.
  // ===========================================================================

  function createLogger(options) {
    var opts = options || {};
    var widget = opts.widget || 'unknown';
    var sink = typeof opts.sink === 'function' ? opts.sink : null;
    var console_ = opts.console || global.console;
    var level = opts.level || 'info';
    var ring = [];
    var seq = 0;
    var counters = {};

    var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

    // Reserved keys a caller's fields may never overwrite. Without this a field
    // named `event` silently replaces the record's own event name, which makes
    // every log query for that event miss — the kind of defect that only shows
    // up when you are already debugging something else.
    var RESERVED = { ts: 1, seq: 1, level: 1, widget: 1, event: 1 };

    function emit(recordLevel, event, fields) {
      seq += 1;
      var record = {
        ts: Date.now(),
        seq: seq,
        level: recordLevel,
        widget: widget,
        event: event,
      };
      if (fields) {
        var keys = Object.keys(fields);
        for (var i = 0; i < keys.length; i += 1) {
          var field = keys[i];
          if (fields[field] === undefined) continue;
          record[RESERVED[field] ? 'field_' + field : field] = fields[field];
        }
      }

      ring.push(record);
      if (ring.length > LOG_RING_SIZE) ring.shift();

      if (sink) {
        try {
          sink(record);
        } catch (_) {
          // A failing sink must never take the widget down with it.
        }
      }

      if (LEVELS[recordLevel] >= LEVELS[level] && console_) {
        var method =
          recordLevel === 'error' && console_.error
            ? 'error'
            : recordLevel === 'warn' && console_.warn
            ? 'warn'
            : 'log';
        console_[method]('[orgx.live] ' + event, record);
      }
      return record;
    }

    function count(name, by) {
      counters[name] = (counters[name] || 0) + (by === undefined ? 1 : by);
      return counters[name];
    }

    return {
      debug: function debug(event, fields) { return emit('debug', event, fields); },
      info: function info(event, fields) { return emit('info', event, fields); },
      warn: function warn(event, fields) { return emit('warn', event, fields); },
      error: function error(event, fields) { return emit('error', event, fields); },
      count: count,
      counters: function snapshot() {
        var out = {};
        var keys = Object.keys(counters);
        for (var i = 0; i < keys.length; i += 1) out[keys[i]] = counters[keys[i]];
        return out;
      },
      records: function records() { return ring.slice(); },
    };
  }

  // ===========================================================================
  // Transports
  //
  // The store never touches EventSource directly. A transport is any object with
  // `open(handlers)` and `close()`, which is what lets the same store be driven
  // by SSE in production, by a stub in tests, and by a polling fallback on hosts
  // that block streaming responses.
  // ===========================================================================

  function createSseTransport(options) {
    var buildUrl = options.buildUrl;
    var EventSourceImpl = options.EventSource || global.EventSource;
    var es = null;

    return {
      name: 'sse',
      supported: function supported() {
        return typeof EventSourceImpl === 'function';
      },
      open: function open(handlers) {
        var url = buildUrl();
        es = new EventSourceImpl(url);

        es.onopen = function onOpen() {
          handlers.onOpen({ url: url });
        };

        es.onmessage = function onMessage(event) {
          var parsed;
          try {
            parsed = JSON.parse(event.data);
          } catch (err) {
            handlers.onMalformed({ raw: event.data });
            return;
          }
          handlers.onFrame(parsed);
        };

        // `auth_expired` is a *named* SSE event, so it never reaches onmessage.
        // Every previous widget wired only onmessage, which is exactly why the
        // server's expiry warning was dead code and streams silently died at
        // the one-hour mark.
        if (es.addEventListener) {
          es.addEventListener('auth_expired', function onAuthExpired(event) {
            var detail = null;
            try {
              detail = event && event.data ? JSON.parse(event.data) : null;
            } catch (_) {
              detail = null;
            }
            handlers.onAuthExpired(detail);
          });
        }

        es.onerror = function onError() {
          handlers.onError({ readyState: es ? es.readyState : null });
        };

        return url;
      },
      close: function close() {
        if (!es) return;
        try {
          es.close();
        } catch (_) {
          // Already closed by the host.
        }
        es = null;
      },
    };
  }

  /**
   * Polling fallback for hosts that buffer or block `text/event-stream`. Speaks
   * the same frame vocabulary as the SSE transport so nothing downstream can
   * tell the difference.
   */
  function createPollTransport(options) {
    var buildUrl = options.buildUrl;
    var fetchImpl = options.fetch || (global.fetch ? global.fetch.bind(global) : null);
    var intervalMs = options.intervalMs || 10000;
    var setIntervalImpl = options.setInterval || global.setInterval;
    var clearIntervalImpl = options.clearInterval || global.clearInterval;
    var timer = null;
    var stopped = false;

    return {
      name: 'poll',
      supported: function supported() {
        return typeof fetchImpl === 'function';
      },
      open: function open(handlers) {
        stopped = false;
        var url = buildUrl();

        function tick() {
          if (stopped) return;
          fetchImpl(buildUrl(), { headers: { Accept: 'application/json' } })
            .then(function onResponse(response) {
              if (response.status === 401 || response.status === 403) {
                handlers.onAuthExpired({ reason: 'poll_' + response.status });
                return null;
              }
              if (!response.ok) throw new Error('poll_' + response.status);
              return response.json();
            })
            .then(function onJson(payload) {
              if (payload) handlers.onFrame(payload);
            })
            .catch(function onFailure(error) {
              handlers.onError({ message: error && error.message });
            });
        }

        handlers.onOpen({ url: url, transport: 'poll' });
        tick();
        timer = setIntervalImpl(tick, intervalMs);
        return url;
      },
      close: function close() {
        stopped = true;
        if (timer) clearIntervalImpl(timer);
        timer = null;
      },
    };
  }

  // ===========================================================================
  // Store
  // ===========================================================================

  /**
   * Create a live store for one feed.
   *
   * Required:
   *   streamUrl      — absolute SSE URL including its `?t=` stream token
   *   widget         — widget id, for logs
   *
   * Optional:
   *   select(payload)  — pull the row list out of a feed frame, so the store can
   *                      reconcile and phase-diff without knowing the schema
   *   keyFn(row, i)    — row identity
   *   refreshToken()   — Promise<string> resolving to a fresh stream URL or
   *                      token; wired to the widget's MCP tool call
   *   transport        — override for tests or the polling fallback
   *   onChange(state)  — called on every state change
   */
  function createLiveStore(options) {
    var opts = options || {};
    var widget = opts.widget || 'widget';
    var logger = opts.logger || createLogger({ widget: widget, sink: opts.logSink });
    var select = opts.select || function identity(payload) { return payload; };
    var keyFn = opts.keyFn || machine.defaultKey;
    var refreshToken = typeof opts.refreshToken === 'function' ? opts.refreshToken : null;

    // Resolved per call rather than captured at construction. Binding to
    // whichever setTimeout happened to exist when the store was built makes the
    // store hostage to load order, and silently ignores a timer implementation
    // the host (or a test harness) installs later.
    function setTimeoutImpl(fn, ms) {
      return (opts.setTimeout || global.setTimeout)(fn, ms);
    }
    function clearTimeoutImpl(id) {
      return (opts.clearTimeout || global.clearTimeout)(id);
    }
    var now = opts.now || function nowMs() { return Date.now(); };

    var streamUrl = opts.streamUrl || '';
    var state = STATES.IDLE;
    var cursor = 0; // last event ts, for `since=` replay
    var data = null;
    var rows = [];
    /** Last full graph, so a node delta has something to fold onto. */
    var heldGraph = null;
    var phaseMap = {};
    var lastError = null;
    var connectedAt = null;
    var frames = 0;

    var backoff = machine.createBackoff({
      baseMs: opts.backoffBaseMs || 1000,
      capMs: opts.backoffCapMs || 30000,
      maxAttempts: opts.maxReconnectAttempts || MAX_RECONNECT_ATTEMPTS,
      random: opts.random,
    });

    var retryTimer = null;
    var heartbeatTimer = null;
    var listeners = [];

    var transport =
      opts.transport ||
      createSseTransport({
        buildUrl: function buildUrl() {
          if (!cursor) return streamUrl;
          return streamUrl + (streamUrl.indexOf('?') === -1 ? '?' : '&') + 'since=' + cursor;
        },
        EventSource: opts.EventSource,
      });

    function snapshot() {
      return {
        connection: state,
        live: machine.isLiveish(state),
        degraded: machine.isDegraded(state),
        data: data,
        rows: rows,
        summary: machine.summarizePhases(rows, keyFn),
        cursor: cursor,
        error: lastError,
        attempts: backoff.attempts(),
        transport: transport.name,
      };
    }

    function notify(diff, phases) {
      var payload = snapshot();
      payload.diff = diff || null;
      payload.phases = phases || null;
      for (var i = 0; i < listeners.length; i += 1) {
        try {
          listeners[i](payload);
        } catch (error) {
          // One bad subscriber must not stop the others from updating.
          logger.error('subscriber_failed', { message: error && error.message });
        }
      }
    }

    // ── Effect handlers ──────────────────────────────────────────────────────

    function armHeartbeat() {
      clearHeartbeat();
      heartbeatTimer = setTimeoutImpl(function onWatchdog() {
        heartbeatTimer = null;
        logger.warn('heartbeat_timeout', { state: state, sinceMs: HEARTBEAT_WATCHDOG_MS });
        logger.count('heartbeat_timeout');
        dispatch(EVENTS.HEARTBEAT_TIMEOUT);
      }, opts.heartbeatWatchdogMs || HEARTBEAT_WATCHDOG_MS);
    }

    function clearHeartbeat() {
      if (heartbeatTimer) clearTimeoutImpl(heartbeatTimer);
      heartbeatTimer = null;
    }

    function cancelRetry() {
      if (retryTimer) clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }

    function scheduleRetry() {
      cancelRetry();
      var delay = backoff.next();
      if (delay === null) {
        logger.error('reconnect_exhausted', { attempts: backoff.attempts() });
        dispatch(EVENTS.FATAL);
        return;
      }
      logger.info('reconnect_scheduled', { delayMs: delay, attempt: backoff.attempts() });
      retryTimer = setTimeoutImpl(function onRetry() {
        retryTimer = null;
        dispatch(EVENTS.RETRY);
      }, delay);
    }

    function openStream() {
      logger.info('stream_opening', { cursor: cursor, transport: transport.name });
      try {
        transport.open(handlers);
      } catch (error) {
        logger.error('stream_open_failed', { message: error && error.message });
        dispatch(EVENTS.ERROR, { message: error && error.message });
      }
    }

    function performRefresh() {
      if (!refreshToken) {
        // Without a refresh path the only honest outcome is to stop and tell the
        // operator, rather than reconnect forever with a token we know is dead.
        logger.error('token_refresh_unavailable', {});
        dispatch(EVENTS.FATAL);
        return;
      }
      logger.info('token_refresh_started', {});
      var started = now();
      Promise.resolve()
        .then(refreshToken)
        .then(function onRefreshed(next) {
          var url = typeof next === 'string' ? next : next && next.streamUrl;
          if (!url) throw new Error('refresh returned no stream url');
          streamUrl = url;
          logger.info('token_refreshed', { latencyMs: now() - started });
          logger.count('token_refresh_ok');
          dispatch(EVENTS.TOKEN_REFRESHED);
        })
        .catch(function onRefreshFailed(error) {
          logger.warn('token_refresh_failed', {
            message: error && error.message,
            latencyMs: now() - started,
          });
          logger.count('token_refresh_failed');
          dispatch(EVENTS.REFRESH_FAILED);
        });
    }

    var EFFECT_HANDLERS = {};
    EFFECT_HANDLERS[EFFECTS.OPEN_STREAM] = openStream;
    EFFECT_HANDLERS[EFFECTS.CLOSE_STREAM] = function closeStream() {
      transport.close();
    };
    EFFECT_HANDLERS[EFFECTS.SCHEDULE_RETRY] = scheduleRetry;
    EFFECT_HANDLERS[EFFECTS.CANCEL_RETRY] = cancelRetry;
    EFFECT_HANDLERS[EFFECTS.REFRESH_TOKEN] = performRefresh;
    EFFECT_HANDLERS[EFFECTS.RESET_BACKOFF] = function resetBackoff() {
      backoff.reset();
      connectedAt = now();
    };
    EFFECT_HANDLERS[EFFECTS.ARM_HEARTBEAT] = armHeartbeat;
    EFFECT_HANDLERS[EFFECTS.CLEAR_HEARTBEAT] = clearHeartbeat;
    EFFECT_HANDLERS[EFFECTS.EMIT_DATA] = function emitData() {
      // Applied inline by ingest() before dispatching, because the payload has
      // to be reconciled before subscribers are told the state changed.
    };

    function dispatch(event, detail, suppressNotify) {
      var before = state;
      var result = machine.transition(before, event);
      if (!result.handled) {
        logger.debug('event_ignored', { state: before, trigger: event });
        return false;
      }
      state = result.state;
      if (before !== state) {
        logger.info('state_change', {
          from: before,
          to: state,
          trigger: event,
          detail: detail ? detail.message || detail.reason : undefined,
        });
      }

      for (var i = 0; i < result.effects.length; i += 1) {
        var handler = EFFECT_HANDLERS[result.effects[i]];
        if (handler) handler();
      }

      // `ingest` publishes its own notification carrying the diff, so a DATA
      // dispatch must not also fire a diff-less one — subscribers would render
      // twice and lose the enter/exit animation on the first pass.
      if (before !== state && !suppressNotify) notify();
      return true;
    }

    /**
     * Fold one feed frame into store state. Reconciliation and phase diffing
     * happen here so subscribers receive `diff` and `phases` alongside the data
     * and can patch the DOM instead of rebuilding it.
     */
    function ingest(frame) {
      frames += 1;
      if (frame && frame.ts) cursor = frame.ts;

      var payload = frame && frame.data !== undefined ? frame.data : frame;

      // The DO sends one snapshot then row-level deltas. Fold here so widgets
      // receive whole graphs and never have to know the wire format.
      if (machine.isNodeDelta(payload)) {
        var folded = machine.foldGraphDelta(heldGraph, payload);
        if (!folded) {
          // A `since=` replay can deliver deltas from before this client
          // attached. Skipping is correct: the next snapshot resynchronizes.
          logger.warn('delta_without_base', { cursor: cursor });
          logger.count('delta_without_base');
          return null;
        }
        payload = folded;
      }
      if (machine.isWorkGraph(payload)) heldGraph = payload;

      var nextRows = select(payload);
      if (!Array.isArray(nextRows)) nextRows = [];

      var diff = machine.reconcile(rows, nextRows, keyFn);
      var phases = machine.diffPhases(phaseMap, nextRows, keyFn);

      data = payload;
      rows = nextRows;
      phaseMap = phases.next;

      logger.debug('frame', {
        type: frame && frame.type,
        rows: nextRows.length,
        entered: diff.entered.length,
        updated: diff.updated.length,
        exited: diff.exited.length,
        started: phases.started.length,
        finished: phases.finished.length,
        blocked: phases.blocked.length,
      });
      logger.count('frames');
      if (phases.started.length) logger.count('boundary_started', phases.started.length);
      if (phases.finished.length) logger.count('boundary_finished', phases.finished.length);
      if (phases.blocked.length) logger.count('boundary_blocked', phases.blocked.length);

      var handled = dispatch(EVENTS.DATA, null, true);
      if (handled) notify(diff, phases);
      return { diff: diff, phases: phases };
    }

    var handlers = {
      onOpen: function onOpen(info) {
        logger.info('stream_open', { url: redact(info && info.url) });
        logger.count('stream_open');
        dispatch(EVENTS.OPEN);
      },
      onFrame: function onFrame(frame) {
        if (!frame || typeof frame !== 'object') return;
        if (frame.type === 'error') {
          lastError = frame.message || 'stream error';
          logger.warn('feed_error', { message: lastError });
          logger.count('feed_error');
          notify();
          return;
        }
        if (frame.type === 'auth_expired') {
          dispatch(EVENTS.AUTH_EXPIRED, frame);
          return;
        }
        lastError = null;
        ingest(frame);
      },
      onMalformed: function onMalformed(info) {
        logger.warn('frame_unparseable', { bytes: info && info.raw ? info.raw.length : 0 });
        logger.count('frame_unparseable');
      },
      onAuthExpired: function onAuthExpired(detail) {
        logger.warn('auth_expired', { reason: detail && detail.reason });
        logger.count('auth_expired');
        dispatch(EVENTS.AUTH_EXPIRED, detail);
      },
      onError: function onError(info) {
        lastError = (info && info.message) || 'connection lost';
        logger.warn('stream_error', info || {});
        logger.count('stream_error');
        dispatch(EVENTS.ERROR, info);
      },
    };

    // ── Visibility ───────────────────────────────────────────────────────────
    // A backgrounded widget holding an open stream costs a DO alarm cycle and a
    // connection slot for a surface nobody is looking at.

    var doc = opts.document || global.document;
    function onVisibilityChange() {
      if (!doc) return;
      if (doc.hidden) {
        logger.info('paused_hidden', {});
        dispatch(EVENTS.PAUSE);
      } else if (state === STATES.PAUSED) {
        logger.info('resumed_visible', {});
        dispatch(EVENTS.RESUME);
      }
    }
    if (doc && doc.addEventListener && opts.observeVisibility !== false) {
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    function redact(url) {
      if (!url) return url;
      return String(url).replace(/([?&]t=)[^&]+/, '$1<redacted>');
    }

    return {
      start: function start() {
        if (!transport.supported || transport.supported()) {
          dispatch(EVENTS.CONNECT);
          return true;
        }
        logger.error('transport_unsupported', { transport: transport.name });
        dispatch(EVENTS.FATAL);
        return false;
      },
      /** Operator-initiated retry out of `fatal`. */
      reconnect: function reconnect() {
        backoff.reset();
        cancelRetry();
        dispatch(state === STATES.FATAL ? EVENTS.CONNECT : EVENTS.RETRY);
      },
      stop: function stop() {
        dispatch(EVENTS.CLOSE);
        if (doc && doc.removeEventListener) {
          doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
      },
      subscribe: function subscribe(listener) {
        listeners.push(listener);
        // The priming call needs the same isolation as notify(): a subscriber
        // that throws on first render must not prevent later ones registering.
        try {
          listener(snapshot());
        } catch (error) {
          logger.error('subscriber_failed', { message: error && error.message });
        }
        return function unsubscribe() {
          var index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
      /** Feed a frame directly — used by tests and by tool-result seeding. */
      ingest: ingest,
      getState: snapshot,
      getLogger: function getLogger() { return logger; },
      /** Diagnostics bundle for bug reports from inside a host sandbox. */
      diagnostics: function diagnostics() {
        return {
          widget: widget,
          connection: state,
          transport: transport.name,
          frames: frames,
          cursor: cursor,
          connectedAt: connectedAt,
          attempts: backoff.attempts(),
          counters: logger.counters(),
          recent: logger.records(),
        };
      },
    };
  }

  // ===========================================================================
  // attachLiveFeed — the whole widget-side wiring in one call.
  //
  // Every widget needs the same six steps: find a mount, create a panel, create
  // a store from the grant, wire the MCP tool call as the token refresh,
  // subscribe, and re-report height to the host. Done by hand that is ~60 lines
  // per widget, which is how the old surfaces drifted apart. Done here it is two
  // lines at the call site, and a fix lands everywhere at once.
  //
  // Returns null when the payload carries no grant, so a widget calling this
  // unconditionally still behaves exactly as it did before for hosts, tools, or
  // users that have no live feed.
  // ===========================================================================

  function attachLiveFeed(options) {
    var opts = options || {};
    var grant = opts.grant;
    if (!grant || !grant.streamUrl) return null;
    if (!global.OrgXLivePanel) return null;

    var doc = opts.document || global.document;
    var mount = typeof opts.mount === 'function' ? opts.mount() : opts.mount;
    if (!mount) return null;

    var runtime = opts.runtime || global.OrgXWidgetRuntime;
    var store = null;

    var panel = global.OrgXLivePanel.createPanel({
      document: doc,
      mount: mount,
      emptyLabel: opts.emptyLabel,
      maxRows: opts.maxRows,
      onSelect: opts.onSelect,
      onRetry: function onRetry() {
        if (store) store.reconnect();
      },
    });

    store = createLiveStore({
      widget: opts.widget || grant.feedType,
      streamUrl: grant.streamUrl,
      logSink: opts.logSink,
      // The canonical graph is a flat node list; the panel renders it directly.
      select:
        opts.select ||
        function selectNodes(payload) {
          return payload && Array.isArray(payload.nodes) ? payload.nodes : [];
        },
      // A sandboxed widget cannot mint a stream token, so re-invoking the bound
      // MCP tool IS the refresh: its result carries a fresh grant.
      refreshToken:
        runtime && runtime.callTool
          ? function refreshToken() {
              return runtime
                .callTool(grant.refreshTool, grant.refreshArgs || {})
                .then(function readGrant(result) {
                  var next = result && result.live;
                  if (!next || !next.streamUrl) {
                    throw new Error('refresh result carried no grant');
                  }
                  return next.streamUrl;
                });
            }
          : undefined,
    });

    store.subscribe(function onState(state) {
      panel.apply(state);
      // The panel changes the document height when rows enter or leave, and the
      // host only resizes the iframe when told.
      if (runtime && runtime.reportSize) runtime.reportSize();
      if (opts.onState) opts.onState(state);
    });

    store.start();
    return { store: store, panel: panel };
  }

  /**
   * Insert a live-panel host before `selector`, or at the top of the body.
   * Idempotent by id, so a host that re-delivers a tool result cannot stack a
   * second panel on the page.
   */
  function ensureLiveMount(selector, id) {
    var doc = global.document;
    var mountId = id || 'orgxLiveFlow';
    var existing = doc.getElementById(mountId);
    if (existing) return existing;

    var host = doc.createElement('section');
    host.id = mountId;
    host.style.margin = '0 0 14px';
    var anchor = selector ? doc.querySelector(selector) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor);
    else if (doc.body) doc.body.insertBefore(host, doc.body.firstChild);
    else return null;
    return host;
  }

  global.OrgXLiveStore = {
    attachLiveFeed: attachLiveFeed,
    ensureLiveMount: ensureLiveMount,
    createLiveStore: createLiveStore,
    createLogger: createLogger,
    createSseTransport: createSseTransport,
    createPollTransport: createPollTransport,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
