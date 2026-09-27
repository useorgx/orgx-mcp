(function installOrgXLivePanel(global) {
  'use strict';

  if (global.OrgXLivePanel) return;

  var machine = global.OrgXLiveMachine;
  if (!machine) {
    throw new Error('live-panel.js requires live-machine.js to be loaded first');
  }

  // ===========================================================================
  // The shared control-flow surface.
  //
  // Every widget previously answered "what is happening right now?" its own way,
  // or not at all: you could spawn a task or start an initiative and the widget
  // would show the moment of dispatch and then nothing. This renders the
  // canonical WorkGraph the way /live does — lanes of work with their phase — and
  // patches the DOM by key so arriving data never reflows the page.
  //
  // Two rules the whole component exists to enforce:
  //
  //  1. No layout shift. Row height is fixed by CSS, the connection chip
  //     reserves its widest state, and a row that changes updates in place. The
  //     old widgets re-rendered a container's innerHTML on every delta, which
  //     resized the iframe mid-read and made the host jump.
  //
  //  2. Loud only on boundaries. A row flashes when it *starts*, *finishes*, or
  //     *blocks* — the transitions from live-machine's phase diff. Progress
  //     ticking 41→42 updates silently. Animating every change is what makes a
  //     live surface feel noisy rather than alive.
  // ===========================================================================

  var PHASE_LABEL = {
    executing: 'Running',
    pending: 'Queued',
    blocked: 'Blocked',
    terminal: 'Done',
  };

  // Connection copy is deliberately plain. "Live" earns no adornment, and a
  // degraded state says what it means rather than showing a spinner forever.
  var CONNECTION_COPY = {
    idle: { label: 'Idle', tone: 'idle' },
    connecting: { label: 'Connecting', tone: 'pending' },
    live: { label: 'Live', tone: 'ok' },
    stale: { label: 'Reconnecting', tone: 'warn' },
    reconnecting: { label: 'Reconnecting', tone: 'warn' },
    refreshing: { label: 'Reauthorizing', tone: 'warn' },
    paused: { label: 'Paused', tone: 'idle' },
    fatal: { label: 'Disconnected', tone: 'error' },
    closed: { label: 'Closed', tone: 'idle' },
  };

  var STYLE_ID = 'orgx-live-panel-style';

  // Height is fixed per row so the list's height is a pure function of row
  // count. `contain: layout` stops a row's internal change from invalidating
  // the ancestors' layout.
  var CSS = [
    '.oxlp{display:flex;flex-direction:column;gap:10px}',
    '.oxlp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px}',
    '.oxlp-headline{font-size:.78rem;color:var(--ox-text-muted,#526078);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.oxlp-headline[data-blocked="true"]{color:var(--ox-warn,#fbbf24);font-weight:600}',
    /* Reserve the widest connection state so the chip never resizes the header. */
    '.oxlp-conn{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:.68rem;letter-spacing:.04em;text-transform:uppercase;color:var(--ox-text-dim,#657188);min-width:104px;justify-content:flex-end}',
    '.oxlp-dot{width:6px;height:6px;border-radius:50%;background:var(--ox-text-dim,#657188);flex:none}',
    '.oxlp-conn[data-tone="ok"] .oxlp-dot{background:var(--ox-success,#22c55e);animation:oxlp-pulse 2s ease-in-out infinite}',
    '.oxlp-conn[data-tone="warn"] .oxlp-dot{background:var(--ox-warn,#fbbf24)}',
    '.oxlp-conn[data-tone="error"] .oxlp-dot{background:var(--ox-danger,#f43f5e)}',
    '.oxlp-conn[data-tone="pending"] .oxlp-dot{background:var(--ox-text-dim,#657188);animation:oxlp-pulse 1.2s ease-in-out infinite}',
    '@keyframes oxlp-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '.oxlp-summary{display:flex;gap:6px;flex-wrap:wrap}',
    '.oxlp-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:.7rem;font-variant-numeric:tabular-nums;background:var(--ox-well,#f1f5f9);color:var(--ox-text-muted,#526078)}',
    '.oxlp-badge[data-kind="running"]{color:rgb(var(--s-running,6,182,212))}',
    '.oxlp-badge[data-kind="blocked"]{color:var(--ox-warn,#fbbf24)}',
    '.oxlp-rows{display:flex;flex-direction:column;gap:6px;list-style:none;margin:0;padding:0}',
    '.oxlp-row{display:grid;grid-template-columns:3px 1fr auto;align-items:center;gap:10px;',
    'min-height:44px;padding:7px 10px 7px 0;border-radius:8px;background:var(--ox-panel,#fff);',
    'border:1px solid var(--ox-border,rgba(0,0,0,.08));contain:layout;overflow:hidden}',
    /* A phase rail reads faster than a coloured pill and costs no width. */
    '.oxlp-rail{align-self:stretch;border-radius:3px 0 0 3px;background:var(--ox-border,rgba(0,0,0,.08))}',
    '.oxlp-row[data-phase="executing"] .oxlp-rail{background:rgb(var(--s-running,6,182,212))}',
    '.oxlp-row[data-phase="blocked"] .oxlp-rail{background:var(--ox-warn,#fbbf24)}',
    '.oxlp-row[data-phase="terminal"] .oxlp-rail{background:var(--ox-success,#22c55e)}',
    '.oxlp-body{min-width:0;display:flex;flex-direction:column;gap:2px}',
    '.oxlp-title{font-size:.8rem;font-weight:600;color:var(--ox-text,#0f172a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.oxlp-sub{font-size:.72rem;color:var(--ox-text-muted,#526078);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.oxlp-sub[data-blocked="true"]{color:var(--ox-warn,#fbbf24)}',
    '.oxlp-meta{display:flex;align-items:center;gap:8px;flex:none}',
    '.oxlp-phase{font-size:.68rem;letter-spacing:.03em;text-transform:uppercase;color:var(--ox-text-dim,#657188);font-variant-numeric:tabular-nums}',
    /* Fixed-width track: a progress change must not move the text beside it. */
    '.oxlp-track{display:block;width:44px;height:3px;border-radius:2px;background:var(--ox-well,#f1f5f9);overflow:hidden;flex:none}',
    // display:block is load-bearing: the fill is a <span> inside a non-flex
    // parent, so without it the element stays inline, width:% is ignored, and
    // the bar renders 0px wide however much progress a node reports.
    '.oxlp-fill{display:block;height:100%;width:0;background:rgb(var(--ox-primary-rgb,0,201,167));transition:width .45s cubic-bezier(.4,0,.2,1)}',
    '.oxlp-empty{padding:16px 0;text-align:center;font-size:.78rem;color:var(--ox-text-dim,#657188)}',
    '.oxlp-retry{appearance:none;border:1px solid var(--ox-border-strong,rgba(0,0,0,.15));background:transparent;',
    'color:var(--ox-text,#0f172a);font:inherit;font-size:.72rem;padding:3px 10px;border-radius:6px;cursor:pointer}',
    /* Boundary flashes. Kept to opacity/background so they never trigger layout. */
    '@keyframes oxlp-enter{from{opacity:0}to{opacity:1}}',
    '@keyframes oxlp-flash{0%{background:var(--ox-panel,#fff)}18%{background:rgba(var(--ox-primary-rgb,0,201,167),.14)}100%{background:var(--ox-panel,#fff)}}',
    '@keyframes oxlp-flash-warn{0%{background:var(--ox-panel,#fff)}18%{background:rgba(var(--ox-warn-rgb,251,191,36),.16)}100%{background:var(--ox-panel,#fff)}}',
    '.oxlp-row[data-anim="enter"]{animation:oxlp-enter .28s ease-out}',
    '.oxlp-row[data-anim="started"],.oxlp-row[data-anim="finished"]{animation:oxlp-flash .9s ease-out}',
    '.oxlp-row[data-anim="blocked"]{animation:oxlp-flash-warn .9s ease-out}',
    /* Exit collapses height so the list closes the gap without a jump. */
    '.oxlp-row[data-anim="exit"]{animation:oxlp-exit .24s ease-in forwards;pointer-events:none}',
    '@keyframes oxlp-exit{to{opacity:0;min-height:0;height:0;padding-top:0;padding-bottom:0;margin-top:-6px}}',
    // Narrow widths: the reserved chip costs the headline ~104px, and the
    // headline is the more useful of the two on a phone. Stacking gives it the
    // full width. It stays single-line and truncated — letting it wrap would
    // make header height depend on copy length, reintroducing the shift.
    '@media(max-width:440px){',
    '.oxlp-head{flex-direction:column-reverse;align-items:stretch;gap:3px}',
    '.oxlp-conn{justify-content:flex-start;min-width:0}',
    '.oxlp-headline{width:100%}}',
    '@media(prefers-reduced-motion:reduce){',
    '.oxlp-row[data-anim]{animation:none!important}',
    '.oxlp-fill{transition:none}',
    '.oxlp-conn .oxlp-dot{animation:none!important}}',
  ].join('');

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function el(doc, tag, className) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function setText(node, value) {
    var next = value === null || value === undefined ? '' : String(value);
    // Guarding the write keeps the browser from invalidating layout for a
    // no-op, which matters when a poll returns an unchanged row.
    if (node.textContent !== next) node.textContent = next;
  }

  function setAttr(node, name, value) {
    if (value === null || value === undefined || value === '') {
      if (node.hasAttribute(name)) node.removeAttribute(name);
      return;
    }
    if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  }

  /** The one-line "why is this row like this" string. */
  function subtitleFor(node) {
    if (node.blockers && node.blockers.length) return node.blockers[0].reason;
    if (node.owner) return node.owner;
    if (node.domain) return node.domain;
    return '';
  }

  function createPanel(options) {
    var opts = options || {};
    var doc = opts.document || global.document;
    var mount = opts.mount;
    if (!mount) throw new Error('live-panel requires a mount element');
    ensureStyle(doc);

    var emptyLabel = opts.emptyLabel || 'No active work';
    var onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    var maxRows = opts.maxRows || 0;

    var root = el(doc, 'div', 'oxlp');
    var head = el(doc, 'div', 'oxlp-head');
    var headline = el(doc, 'div', 'oxlp-headline');
    var conn = el(doc, 'span', 'oxlp-conn');
    var connDot = el(doc, 'span', 'oxlp-dot');
    var connLabel = el(doc, 'span', 'oxlp-conn-label');
    conn.appendChild(connDot);
    conn.appendChild(connLabel);
    head.appendChild(headline);
    head.appendChild(conn);

    var summary = el(doc, 'div', 'oxlp-summary');
    var rowsEl = el(doc, 'ul', 'oxlp-rows');
    var empty = el(doc, 'div', 'oxlp-empty');
    empty.hidden = true;

    root.appendChild(head);
    root.appendChild(summary);
    root.appendChild(rowsEl);
    root.appendChild(empty);
    mount.appendChild(root);

    var rowNodes = {}; // key → { row, title, sub, phase, fill, track }
    var badges = {};
    var retryButton = null;

    function buildRow(node) {
      var row = el(doc, 'li', 'oxlp-row');
      var rail = el(doc, 'span', 'oxlp-rail');
      var body = el(doc, 'div', 'oxlp-body');
      var title = el(doc, 'div', 'oxlp-title');
      var sub = el(doc, 'div', 'oxlp-sub');
      var meta = el(doc, 'div', 'oxlp-meta');
      var phase = el(doc, 'span', 'oxlp-phase');
      var track = el(doc, 'span', 'oxlp-track');
      var fill = el(doc, 'span', 'oxlp-fill');

      track.appendChild(fill);
      body.appendChild(title);
      body.appendChild(sub);
      meta.appendChild(phase);
      meta.appendChild(track);
      row.appendChild(rail);
      row.appendChild(body);
      row.appendChild(meta);

      if (onSelect) {
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.addEventListener('click', function onClick() {
          onSelect(node.id);
        });
        row.addEventListener('keydown', function onKey(event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(node.id);
          }
        });
      }

      return { row: row, title: title, sub: sub, phase: phase, track: track, fill: fill };
    }

    function paintRow(entry, node) {
      setText(entry.title, node.title || node.id);
      var subtitle = subtitleFor(node);
      setText(entry.sub, subtitle);
      entry.sub.hidden = !subtitle;
      setAttr(entry.sub, 'data-blocked', node.blockers && node.blockers.length ? 'true' : null);
      setText(entry.phase, PHASE_LABEL[node.phase] || node.phase || '');
      setAttr(entry.row, 'data-phase', node.phase);
      setAttr(entry.row, 'data-id', node.id);

      var hasProgress = typeof node.progress === 'number' && isFinite(node.progress);
      var pct = hasProgress
        ? Math.max(0, Math.min(100, node.progress))
        : node.phase === 'terminal'
        ? 100
        : null;
      // The track keeps its width even with no value, so a row that gains
      // progress later does not widen and push the phase label.
      entry.track.style.visibility = pct === null ? 'hidden' : 'visible';
      if (pct !== null) entry.fill.style.width = pct + '%';

      var label = (node.title || node.id) + ' — ' + (PHASE_LABEL[node.phase] || node.phase);
      setAttr(entry.row, 'aria-label', subtitle ? label + '. ' + subtitle : label);
    }

    function flash(entry, kind) {
      // Restart the animation by clearing the attribute first; without the
      // reflow read the browser coalesces the two writes and nothing plays.
      entry.row.removeAttribute('data-anim');
      void entry.row.offsetWidth;
      setAttr(entry.row, 'data-anim', kind);
    }

    function renderSummary(counts) {
      var wanted = [];
      if (counts.running) wanted.push(['running', counts.running + ' running']);
      if (counts.blocked) wanted.push(['blocked', counts.blocked + ' blocked']);
      if (counts.queued) wanted.push(['queued', counts.queued + ' queued']);
      if (counts.done) wanted.push(['done', counts.done + ' done']);

      var seen = {};
      for (var i = 0; i < wanted.length; i += 1) {
        var kind = wanted[i][0];
        var text = wanted[i][1];
        seen[kind] = true;
        if (!badges[kind]) {
          badges[kind] = el(doc, 'span', 'oxlp-badge');
          setAttr(badges[kind], 'data-kind', kind);
          summary.appendChild(badges[kind]);
        }
        setText(badges[kind], text);
        badges[kind].hidden = false;
      }
      var kinds = Object.keys(badges);
      for (var j = 0; j < kinds.length; j += 1) {
        if (!seen[kinds[j]]) badges[kinds[j]].hidden = true;
      }
    }

    function renderConnection(state, attempts) {
      var copy = CONNECTION_COPY[state] || CONNECTION_COPY.idle;
      setText(connLabel, copy.label);
      setAttr(conn, 'data-tone', copy.tone);
      setAttr(conn, 'data-state', state);

      if (state === 'fatal' && onRetry) {
        if (!retryButton) {
          retryButton = el(doc, 'button', 'oxlp-retry');
          retryButton.type = 'button';
          setText(retryButton, 'Retry');
          retryButton.addEventListener('click', function onClick() {
            onRetry();
          });
          conn.appendChild(retryButton);
        }
        retryButton.hidden = false;
      } else if (retryButton) {
        retryButton.hidden = true;
      }
      setAttr(conn, 'data-attempts', attempts ? String(attempts) : null);
    }

    /**
     * Apply a store snapshot. `diff` and `phases` come from the store; when they
     * are absent (the first paint, or a connection-only change) the panel falls
     * back to a full keyed sync with no animation.
     */
    function apply(snapshot) {
      renderConnection(snapshot.connection, snapshot.attempts);

      var nodes = snapshot.rows || [];
      if (maxRows && nodes.length > maxRows) nodes = nodes.slice(0, maxRows);

      setText(headline, snapshot.headline || (snapshot.data && snapshot.data.headline) || '');
      setAttr(
        headline,
        'data-blocked',
        snapshot.summary && snapshot.summary.blocked ? 'true' : null
      );
      renderSummary(snapshot.summary || {});

      var boundaries = {};
      if (snapshot.phases) {
        var mark = function mark(ids, kind) {
          for (var i = 0; i < (ids || []).length; i += 1) boundaries[ids[i]] = kind;
        };
        mark(snapshot.phases.finished, 'finished');
        mark(snapshot.phases.blocked, 'blocked');
        mark(snapshot.phases.started, 'started');
      }

      var seen = {};
      var previousSibling = null;
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (!node || !node.id) continue;
        seen[node.id] = true;
        var entry = rowNodes[node.id];
        var isNew = !entry;
        if (isNew) {
          entry = buildRow(node);
          rowNodes[node.id] = entry;
        }
        paintRow(entry, node);

        // Insert in order without touching rows already in position.
        var expected = previousSibling ? previousSibling.nextSibling : rowsEl.firstChild;
        if (entry.row !== expected) {
          rowsEl.insertBefore(entry.row, expected);
        }
        previousSibling = entry.row;

        if (boundaries[node.id]) flash(entry, boundaries[node.id]);
        else if (isNew && snapshot.diff) flash(entry, 'enter');
      }

      var keys = Object.keys(rowNodes);
      for (var j = 0; j < keys.length; j += 1) {
        if (seen[keys[j]]) continue;
        removeRow(keys[j]);
      }

      var isEmpty = nodes.length === 0;
      setText(empty, snapshot.connection === 'fatal' ? 'Live updates unavailable' : emptyLabel);
      empty.hidden = !isEmpty;
      rowsEl.hidden = isEmpty;
    }

    function removeRow(key) {
      var entry = rowNodes[key];
      if (!entry) return;
      delete rowNodes[key];
      flash(entry, 'exit');
      var remove = function remove() {
        if (entry.row.parentNode) entry.row.parentNode.removeChild(entry.row);
      };
      if (typeof entry.row.addEventListener === 'function') {
        entry.row.addEventListener('animationend', remove, { once: true });
      }
      // jsdom and reduced-motion never fire animationend, so guarantee removal.
      global.setTimeout(remove, 300);
    }

    return {
      apply: apply,
      element: root,
      /** Row count currently mounted — used by tests to assert no duplication. */
      rowCount: function rowCount() {
        return rowsEl.children.length;
      },
      destroy: function destroy() {
        if (root.parentNode) root.parentNode.removeChild(root);
        rowNodes = {};
        badges = {};
      },
    };
  }

  global.OrgXLivePanel = {
    createPanel: createPanel,
    PHASE_LABEL: PHASE_LABEL,
    CONNECTION_COPY: CONNECTION_COPY,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
