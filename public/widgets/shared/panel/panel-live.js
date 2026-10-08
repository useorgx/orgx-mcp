/**
 * OrgXPanelLive — keeps the OrgX panel current from its live feed.
 *
 * The panel snapshot carries a grant for a per-viewer, per-workspace feed. The
 * feed reports the decision queue (id and version per decision) and the work
 * agents are running. This module compares that with what the panel is showing
 * and tells the panel what to do:
 *
 *  - decisions that left the queue: remove them now, before any re-read;
 *  - anything new or changed: re-read the snapshot once, so rendering and
 *    approval tokens still come from the tool, never from the stream;
 *  - In progress moved: re-read it if it is open, otherwise mark it stale.
 *
 * It compares against the panel, not against the previous frame, so it is
 * self-correcting after a missed frame. It acts at most once per distinct feed
 * state, so a feed and a snapshot that disagree cannot loop on re-reads.
 *
 * Transport, reconnects, backoff, pausing while hidden and token refresh are
 * the shared live store's job (live-store.js). When live is unavailable — no
 * grant, no EventSource, a halted feed — the panel falls back to refreshing
 * when it becomes visible again.
 */
(function (global) {
  'use strict';

  /** Feed errors that mean "do not keep this stream open". */
  var HALTED = /live_refresh_metered|requires a viewer|user_scope_requires_identity/;

  function decisionMap(graph) {
    var map = {};
    (graph && Array.isArray(graph.nodes) ? graph.nodes : []).forEach(function each(node) {
      if (node && typeof node.id === 'string' && node.id.indexOf('decision:') === 0) {
        map[node.id.slice(9)] = node.updatedAt || '';
      }
    });
    return map;
  }

  /** Null when the feed could not read agent status this time. */
  function workSummary(graph) {
    var items = [];
    var rows = [];
    var blocked = 0;
    var nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
    if (nodes.some(function unavailable(node) { return node && node.id === 'meta:work-unavailable'; })) return null;
    nodes.forEach(function each(node) {
      if (!node || typeof node.id !== 'string' || node.id.indexOf('work:') !== 0) return;
      items.push(node.id + '=' + (node.status || node.phase || ''));
      if (node.phase === 'blocked') blocked += 1;
      // The panel's own In progress rows, in the feed's (and the snapshot's) order.
      rows.push({ id: node.id.slice(5), agent: node.owner || 'Agent', title: node.title || 'Task', state: node.status || 'queued' });
    });
    items.sort();
    return { signature: items.join('|'), total: items.length, blocked: blocked, items: rows };
  }

  function signatureOf(map) {
    return Object.keys(map).sort().map(function pair(id) { return id + '@' + map[id]; }).join('|');
  }

  /**
   * Pure: what the panel should do, given the feed's queue and the panel's.
   * `shown` maps decision id to the version the panel rendered.
   */
  function compareQueues(feed, shown) {
    var removed = Object.keys(shown).filter(function gone(id) { return !(id in feed); });
    var stale = Object.keys(feed).some(function differs(id) {
      return !(id in shown) || (shown[id] && feed[id] && shown[id] !== feed[id]);
    });
    return { removed: removed, stale: stale || removed.length > 0 };
  }

  /** The server holds a halted feed this long; retrying sooner only reopens it. */
  var HALT_RETRY_MS = 10 * 60 * 1000;

  function statusOf(state) {
    var connection = state && state.connection;
    if (connection === 'live') return 'live';
    if (connection === 'connecting') return 'connecting';
    if (connection === 'paused') return 'paused';
    if (connection === 'stale' || connection === 'reconnecting' || connection === 'refreshing') return 'reconnecting';
    return 'off';
  }

  /**
   * options:
   *   runtime        OrgXWidgetRuntime (callToolResult)
   *   store          OrgXLiveStore (createLiveStore), injectable for tests
   *   shownQueue()   { id: version } of the decisions the panel is showing
   *   onRemoved(ids) decisions the feed says are gone
   *   onStale()      the queue changed; re-read the snapshot
   *   onWork(summary, changed)  { total, blocked } and whether it moved
   *   onSnapshot(result)        a snapshot read made to refresh the grant
   *   refreshArgs()             arguments for that read (selection, tab)
   *   onStatus(status)  'live' | 'connecting' | 'reconnecting' | 'paused' | 'off'
   */
  function create(options) {
    var opts = options || {};
    var Store = opts.store || global.OrgXLiveStore;
    var runtime = opts.runtime || global.OrgXWidgetRuntime;
    var store = null;
    var unsubscribe = null;
    var feedKey = null;
    var status = 'off';
    var actedOn = null;
    var lastWork = null;
    var halted = null;
    var now = opts.now || function nowMs() { return Date.now(); };

    function setStatus(next) {
      if (next === status) return;
      status = next;
      if (opts.onStatus) opts.onStatus(status);
    }

    function stop() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (store) store.stop();
      store = null;
      feedKey = null;
      actedOn = null;
      lastWork = null;
      setStatus('off');
    }

    function onState(state) {
      if (state.error && HALTED.test(String(state.error))) {
        // The server stopped this feed on purpose; reconnecting would only
        // restart what it stopped. A later grant may try again.
        halted = { key: feedKey, at: now() };
        stop();
        return;
      }
      setStatus(statusOf(state));
      var graph = state.data;
      if (!graph || !Array.isArray(graph.nodes)) return;

      var feed = decisionMap(graph);
      var signature = signatureOf(feed);
      if (signature !== actedOn) {
        var shown = (opts.shownQueue && opts.shownQueue()) || {};
        var verdict = compareQueues(feed, shown);
        actedOn = signature;
        if (verdict.removed.length && opts.onRemoved) opts.onRemoved(verdict.removed);
        if (verdict.stale && opts.onStale) opts.onStale();
      }

      var work = workSummary(graph);
      // A failed agent read is not "nothing running": keep what is shown.
      if (!work) return;
      var moved = lastWork !== null && lastWork !== work.signature;
      lastWork = work.signature;
      if (opts.onWork) opts.onWork({ total: work.total, blocked: work.blocked, items: work.items }, moved);
    }

    function refreshGrant(grant) {
      // The panel's own read arguments (its selected decision, its open tab),
      // so a token refresh never moves the person off what they are reading.
      var args = typeof opts.refreshArgs === 'function' ? opts.refreshArgs() : null;
      return runtime.callToolResult(grant.refreshTool || 'orgx_panel_snapshot', args || grant.refreshArgs || {})
        .then(function read(result) {
          if (opts.onSnapshot) opts.onSnapshot(result);
          var next = result && result.data && result.data.live;
          if (!next || !next.streamUrl) throw new Error('refresh carried no grant');
          return next;
        });
    }

    /**
     * Adopt the grant from a snapshot. The same feed keeps its stream (the
     * store refreshes its own token); a different feed — the workspace changed
     * — replaces it.
     */
    function update(grant) {
      if (!grant || !grant.streamUrl || !Store || !Store.createLiveStore) {
        if (!grant) stop();
        return;
      }
      if (typeof global.EventSource === 'undefined') return;
      var key = grant.feedType + ':' + grant.feedId;
      if (store && key === feedKey) return;
      if (halted && halted.key === key && now() - halted.at < HALT_RETRY_MS) return;
      stop();
      halted = null;
      feedKey = key;
      store = Store.createLiveStore({
        widget: 'orgx-panel',
        streamUrl: grant.streamUrl,
        expiresAt: grant.expiresAt,
        select: function nodes(payload) {
          return payload && Array.isArray(payload.nodes) ? payload.nodes : [];
        },
        refreshToken: runtime && runtime.callToolResult
          ? function refresh() { return refreshGrant(grant); }
          : undefined,
      });
      unsubscribe = store.subscribe(onState);
      store.start();
    }

    return {
      update: update,
      stop: stop,
      status: function current() { return status; },
      /** True while a usable live feed is attached (not merely reconnecting). */
      isLive: function isLive() { return status === 'live'; },
      reconnect: function reconnect() { if (store) store.reconnect(); },
    };
  }

  global.OrgXPanelLive = {
    create: create,
    compareQueues: compareQueues,
    decisionMap: decisionMap,
    workSummary: workSummary,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
