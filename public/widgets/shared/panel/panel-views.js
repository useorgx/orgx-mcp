/**
 * OrgX panel views: tabs, In progress, Done (session receipts).
 *
 * Pure string builders; the controller owns state and events. Every
 * actionable element uses data-action so the controller's one click
 * handler routes it. Kit elements: ox-state-chip, ox-receipt-row and, via
 * OrgXAgentIdentity, ox-avatar.
 */
(function attachPanelViews(global) {
  'use strict';
  if (global.OrgXPanelViews) return;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function links() { return global.OrgXLinks || null; }
  function liveUrl() { var l = links(); return l && l.live ? l.live() : 'https://useorgx.com/live'; }

  /** Avatar for an agent or person; OrgX's mark when nobody is named. */
  function avatar(name, size) {
    var identity = global.OrgXAgentIdentity;
    if (identity && typeof identity.avatar === 'function') return identity.avatar({ agent: name || '', name: name || '', size: size || 'row' });
    return '';
  }

  var TABS = [['needs', 'Needs you'], ['work', 'In progress'], ['done', 'Done'], ['start', 'Start']];

  /**
   * opts: { active, counts: { needs, work, done }, tones: { needs, work, done }, changed: { [tab]: true } }.
   * A count of null renders no badge (not loaded yet), never a fake zero.
   */
  function tabsHtml(opts) {
    var counts = opts.counts || {};
    var tones = opts.tones || {};
    // Start only exists when its module loaded; a tab that cannot open is worse than none.
    var tabs = TABS.filter(function present(t) { return t[0] !== 'start' || Boolean(global.OrgXPanelStart); });
    return '<div class="pn-tabs" role="tablist" aria-label="Panel views">' + tabs.map(function tab(t) {
      var on = opts.active === t[0];
      var n = counts[t[0]];
      return '<button type="button" class="pn-tab" role="tab" id="pn-tab-' + t[0] + '" aria-selected="' + on + '" aria-controls="pn-view" tabindex="' + (on ? '0' : '-1') + '" data-action="tab" data-tab="' + t[0] + '">' +
        '<span>' + t[1] + '</span>' + (typeof n === 'number' ? '<span class="pn-tab-n' + (opts.changed && opts.changed[t[0]] ? ' tick' : '') + '" data-tone="' + esc(tones[t[0]] || '') + '">' + n + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  var WORK_GROUPS = [['blocked', 'Blocked'], ['running', 'Running'], ['queued', 'Queued']];
  var WORK_CHIP = { blocked: 'blocked', running: 'running', queued: 'queued' };

  function skeletonRows(n) {
    var out = '';
    for (var i = 0; i < n; i += 1) {
      out += '<div class="pn-sk-row" aria-hidden="true"><span class="sk pn-sk-av"></span><span class="pn-sk-lines"><span class="sk sk-line" style="width:' + (78 - i * 9) + '%"></span><span class="sk sk-line" style="width:42%"></span></span><span class="sk pn-sk-chip"></span></div>';
    }
    return out;
  }

  function runsUrl() { var l = links(); return l && l.run ? l.run() : 'https://useorgx.com/runs'; }
  function ago(iso) { var t = global.OrgXTime; return iso && t && t.relative ? t.relative(iso) : ''; }
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  var STATE_ORDER = ['blocked', 'running', 'queued'];
  var STATE_NAME = { blocked: 'Blocked', running: 'Running', queued: 'Queued' };
  var ROWS_PER_AGENT = 4;

  function workChip(i) {
    if (i.stale) return '<ox-state-chip state="stale" label="' + esc(i.updated_at && ago(i.updated_at) ? 'No update in ' + ago(i.updated_at).replace(/\s*ago$/, '') : 'No recent update') + '"></ox-state-chip>';
    return '<ox-state-chip state="' + WORK_CHIP[i.state] + '"></ox-state-chip>';
  }

  /** One agent's work: who, what domain, how much is in each state. */
  function groupByAgent(items) {
    var order = [];
    var by = {};
    items.forEach(function bucket(i) {
      var key = i.agent || 'Agent';
      if (!by[key]) { by[key] = { agent: key, domain: i.domain || '', items: [], n: { blocked: 0, running: 0, queued: 0 } }; order.push(key); }
      by[key].items.push(i);
      by[key].n[i.state] += 1;
    });
    // Agents with blocked work first, then by how much they hold.
    return order.map(function get(k) { return by[k]; }).sort(function rank(a, b) {
      return (b.n.blocked - a.n.blocked) || (b.items.length - a.items.length);
    });
  }

  function stateCounts(n) {
    return STATE_ORDER.filter(function has(s) { return n[s]; }).map(function c(s) {
      return '<span class="ag-n" data-s="' + s + '" title="' + esc(count(n[s], STATE_NAME[s].toLowerCase(), STATE_NAME[s].toLowerCase())) + '">' + n[s] + '<span class="sr-only"> ' + STATE_NAME[s].toLowerCase() + '</span></span>';
    }).join('');
  }

  function workDetailHtml(item, onClose) {
    if (!item) return '';
    var meta = [item.agent + (item.domain ? ' · ' + item.domain : ''), item.updated_at ? 'Updated ' + ago(item.updated_at) : ''].filter(Boolean);
    var stateLine = item.stale
      ? 'Marked in progress, but nothing has been reported for ' + (ago(item.updated_at) || 'a while') + '. It may be stalled.'
      : item.state === 'blocked' ? 'Waiting on something before it can continue.'
      : item.state === 'running' ? 'An agent is working on this now.'
      : 'Assigned and waiting its turn.';
    var ask = 'In OrgX, what is ' + (item.state === 'blocked' || item.stale ? 'holding up' : 'the status of') + ' “' + item.title.slice(0, 120) + '”?';
    return '<div class="md-card" role="region" aria-label="Task details">' +
      (onClose ? '<button type="button" class="md-close" data-action="work-select" data-id="" aria-label="Close details">×</button>' : '') +
      '<p class="md-kicker">' + workChip(item) + '</p>' +
      '<h3 class="md-title">' + esc(item.title) + '</h3>' +
      '<p class="md-who"><span class="md-av">' + avatar(item.agent, 'inline') + '</span>' + esc(meta.join(' · ')) + '</p>' +
      '<p class="md-text">' + esc(stateLine) + '</p>' +
      '<div class="md-acts"><button type="button" class="pn-btn" data-action="open" data-url="' + esc(item.url) + '">Open in OrgX ↗</button>' +
      '<button type="button" class="pn-btn ghost" data-action="launch" data-prompt="' + esc(ask) + '">Ask ChatGPT</button></div></div>';
  }

  function workOverviewHtml(groups, work) {
    var rows = groups.slice(0, 8).map(function agentLine(g) {
      return '<li class="ov-row"><button type="button" class="ov-btn" data-action="agent-focus" data-id="' + esc(g.agent) + '">' +
        '<span class="md-av">' + avatar(g.agent, 'inline') + '</span><span class="ov-name">' + esc(g.agent) + (g.domain ? '<span class="ov-dom">' + esc(g.domain) + '</span>' : '') + '</span>' +
        '<span class="ov-bar" aria-hidden="true">' + STATE_ORDER.map(function seg(s) { return g.n[s] ? '<i data-s="' + s + '" style="flex:' + g.n[s] + '"></i>' : ''; }).join('') + '</span>' +
        '<span class="ov-c">' + stateCounts(g.n) + '</span></button></li>';
    }).join('');
    return '<div class="md-card md-overview" role="region" aria-label="Agents overview"><p class="md-kicker">' + count(groups.length, 'agent', 'agents') + ' · ' + count(work.total, 'task', 'tasks') + '</p>' +
      '<h3 class="md-title">Who holds what</h3><ul class="ov-list" role="list">' + rows + '</ul>' +
      '<p class="md-text">Select a task to see where it stands.</p></div>';
  }

  /**
   * In progress, built to stay readable at hundreds of tasks: grouped by agent
   * (blocked work first), a state filter, search once the list is long, a few
   * rows per agent with the rest one press away, and a detail pane for the
   * selected task. opts: { sel, filter, query, expanded, narrow }.
   */
  function workHtml(work, phase, launch, opts) {
    opts = opts || {};
    var head = '<div class="pn-view-head"><h2 class="pn-view-h">In progress</h2>' +
      '<button type="button" class="text-btn" data-action="open" data-url="' + esc(runsUrl()) + '">All runs in OrgX ↗</button></div>';
    if (phase === 'loading' && !work) {
      return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work" aria-busy="true">' + head + skeletonRows(5) + '<p class="sr-only">Loading what your agents are running.</p></section>';
    }
    if (!work || work.status === 'unavailable' || phase === 'failed') {
      return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work">' + head +
        '<div class="notice" data-tone="amber" role="status"><p>Agent status could not be read right now. Nothing is hidden: open runs in OrgX, or try again.</p>' +
        '<button type="button" class="text-btn" data-action="work-retry">Try again</button></div></section>';
    }
    if (!work.items.length) {
      return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work">' + head +
        '<p class="pn-empty-t">Nothing is running right now.</p><p class="sub">Agents pick up work you start or delegate; it shows here with its state.</p>' + (launch || '') + '</section>';
    }
    var totals = { blocked: 0, running: 0, queued: 0 };
    work.items.forEach(function t(i) { totals[i.state] += 1; });
    var filter = STATE_ORDER.indexOf(opts.filter) !== -1 ? opts.filter : 'all';
    var q = String(opts.query || '').trim().toLowerCase();
    var visible = work.items.filter(function keep(i) {
      return (filter === 'all' || i.state === filter) &&
        (!q || (i.title + ' ' + i.agent + ' ' + (i.domain || '')).toLowerCase().indexOf(q) !== -1);
    });
    var groups = groupByAgent(visible);
    var filters = '<div class="seg" role="group" aria-label="Filter by state">' +
      [['all', 'All', work.items.length]].concat(STATE_ORDER.map(function f(s) { return [s, STATE_NAME[s], totals[s]]; }))
        .filter(function nonzero(f) { return f[0] === 'all' || f[2] > 0; })
        .map(function btn(f) {
          return '<button type="button" class="seg-b" data-action="work-filter" data-id="' + f[0] + '" aria-pressed="' + (filter === f[0]) + '"' + (f[0] !== 'all' ? ' data-s="' + f[0] + '"' : '') + '>' + f[1] + '<span class="seg-n">' + f[2] + '</span></button>';
        }).join('') + '</div>';
    var search = work.items.length > 12
      ? '<label class="pn-search"><span class="sr-only">Search tasks</span><input type="search" data-action="work-query" placeholder="Search tasks or agents" value="' + esc(opts.query || '') + '" autocomplete="off"></label>' : '';
    var selected = null;
    var list = groups.map(function agentGroup(g) {
      var open = opts.expanded && opts.expanded[g.agent];
      var shown = open ? g.items : g.items.slice(0, ROWS_PER_AGENT);
      var rows = shown.map(function row(i) {
        var on = opts.sel === i.id;
        if (on) selected = i;
        return '<li><button type="button" class="wk-row' + (i.stale ? ' is-stale' : '') + '" data-action="work-select" data-id="' + esc(i.id) + '" aria-pressed="' + on + '">' +
          '<span class="wk-t">' + esc(i.title) + '</span>' +
          '<span class="wk-m">' + esc(i.updated_at ? ago(i.updated_at) : STATE_NAME[i.state]) + '</span>' +
          '<span class="wk-s">' + workChip(i) + '</span></button></li>';
      }).join('');
      var more = g.items.length > ROWS_PER_AGENT
        ? '<button type="button" class="text-btn ag-more" data-action="agent-expand" data-id="' + esc(g.agent) + '" aria-expanded="' + Boolean(open) + '">' + (open ? 'Show fewer' : 'Show ' + (g.items.length - ROWS_PER_AGENT) + ' more') + '</button>' : '';
      return '<section class="ag" data-agent="' + esc(g.agent) + '"><h3 class="ag-h"><span class="md-av">' + avatar(g.agent, 'inline') + '</span>' +
        '<span class="ag-name">' + esc(g.agent) + (g.domain ? '<span class="ag-dom">' + esc(g.domain) + '</span>' : '') + '</span>' +
        '<span class="ag-c">' + stateCounts(g.n) + '</span></h3><ul class="wk-rows" role="list">' + rows + '</ul>' + more + '</section>';
    }).join('');
    if (!selected && opts.sel) selected = work.items.filter(function f(i) { return i.id === opts.sel; })[0] || null;
    var empty = !visible.length ? '<p class="sub">No tasks match. <button type="button" class="text-btn" data-action="work-filter" data-id="all">Show all</button></p>' : '';
    var more = work.total > work.items.length
      ? '<p class="sub">Showing ' + work.items.length + ' of ' + work.total + '. <button type="button" class="text-btn" data-action="open" data-url="' + esc(runsUrl()) + '">All runs in OrgX ↗</button></p>' : '';
    return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work"' + (phase === 'loading' ? ' aria-busy="true"' : '') + '>' + head +
      '<div class="pn-tools">' + filters + search + '</div>' +
      '<div class="pn-md' + (selected ? ' has-sel' : '') + '"><div class="pn-md-list">' + list + empty + more + '</div>' +
      '<aside class="pn-md-detail">' + (selected ? workDetailHtml(selected, true) : workOverviewHtml(groupByAgent(work.items), work)) + '</aside></div>' +
      (launch || '') + '</section>';
  }

  /**
   * The lightweight receipt: what the panel actually knows about a settled
   * decision, in the Work Receipt's grammar. Three marks (decided, recorded,
   * outcome), each proven / partly / fails / no proof, and the missing one
   * named. Nothing is shown as proven that the panel did not see: the outcome
   * of a decision is never known here, so it is always the missing layer.
   */
  var MARK = {
    pass: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6-6.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    partial: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3a5 5 0 0 1 0 10z" fill="currentColor"/></svg>',
    fail: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    none: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2.2"/></svg>',
  };
  var STATE_WORD = { pass: 'proven', partial: 'partly', fail: 'fails', none: 'no proof' };

  function trailOf(entry) {
    var p = entry.phase;
    var elsewhere = p === 'elsewhere';
    var decided = { key: 'decided', name: 'Decided', s: 'pass', line: elsewhere ? 'Settled in OrgX' : (entry.verb || 'Decided') + ' by you', value: entry.at || '' };
    var recorded = p === 'confirmed' || p === 'rejected' || elsewhere
      ? { s: 'pass', line: elsewhere ? 'Outcome recorded in OrgX' : 'Recorded in OrgX' }
      : p === 'failed'
        ? { s: 'fail', line: 'OrgX did not record it' }
        : p === 'recorded'
          ? { s: 'partial', line: 'Not confirmed yet' }
          : { s: 'partial', line: 'Recording' };
    recorded.key = 'recorded'; recorded.name = 'Recorded'; recorded.value = entry.detail || '';
    var outcome = { key: 'outcome', name: 'Outcome', s: 'none', line: 'not on this receipt yet; it lands in OrgX with the work', value: '' };
    return [decided, recorded, outcome];
  }

  /** The three marks in a row, for a collapsed receipt or the post-decision line. */
  function trailMarks(entry) {
    var t = trailOf(entry);
    return '<span class="rt" role="img" aria-label="' + esc(t.map(function said(m) { return m.name + ': ' + STATE_WORD[m.s]; }).join('. ')) + '">' +
      t.map(function mark(m) { return '<span class="rt-m" data-s="' + m.s + '" title="' + esc(m.name + ': ' + STATE_WORD[m.s]) + '">' + MARK[m.s] + '</span>'; }).join('') + '</span>';
  }

  function receiptHtml(entry, open) {
    var t = trailOf(entry);
    var lines = t.map(function line(m) {
      return '<li class="rt-line" data-s="' + m.s + '"><span class="rt-m" data-s="' + m.s + '" aria-hidden="true">' + MARK[m.s] + '</span>' +
        '<span class="rt-l"><b>' + esc(m.name) + '</b> ' + esc(m.line) + (m.value && m.key !== 'decided' ? ' · <span class="rt-v">' + esc(m.value) + '</span>' : '') + '</span>' +
        (m.key === 'decided' && m.value ? '<span class="rt-t">' + esc(m.value) + '</span>' : '') + '</li>';
    }).join('');
    return '<li class="pn-rc' + (open ? ' is-open' : '') + '">' +
      '<button type="button" class="pn-rc-head" data-action="receipt" data-id="' + esc(entry.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="rc-' + esc(entry.id) + '">' +
      '<span class="pn-row-main"><span class="pn-row-t">' + esc(entry.title) + '</span><span class="pn-row-m">' + esc(t[0].line + (entry.at ? ' · ' + entry.at : '')) + '</span></span>' +
      trailMarks(entry) + '<span class="pn-rc-chev" aria-hidden="true">›</span></button>' +
      '<div class="pn-rc-body" id="rc-' + esc(entry.id) + '"' + (open ? '' : ' hidden') + '><ul class="rt-lines" role="list">' + lines + '</ul>' +
      // The missing layer is named once, on its own line above; this only offers where to look.
      '<p class="rt-miss"><button type="button" class="text-btn" data-action="open" data-url="' + esc(entry.url) + '">Open receipt in OrgX ↗</button></p></div></li>';
  }

  var RANGES = [['session', 'This session'], ['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']];
  var OUTCOME = {
    approved: { verb: 'Approved', s: 'pass' }, declined: { verb: 'Declined', s: 'pass' },
    cancelled: { verb: 'Cancelled', s: 'pass' }, superseded: { verb: 'Superseded', s: 'pass' },
  };
  var DONE_PAGE = 10;

  /** A settled decision from OrgX's history, as a receipt the panel can show. */
  function historyEntry(h) {
    var o = OUTCOME[h.outcome] || OUTCOME.approved;
    return { id: h.id, title: h.title, action: h.outcome === 'approved' ? 'approve' : 'reject', verb: o.verb, phase: 'confirmed', detail: '', at: h.settled_at ? ago(h.settled_at) : '', url: h.url, inOrgx: true };
  }

  function receiptRow(e, on) {
    return '<li><button type="button" class="dn-row" data-action="receipt" data-id="' + esc(e.id) + '" aria-pressed="' + on + '">' +
      '<span class="dn-t">' + esc(e.title) + '</span><span class="dn-m">' + esc((e.inOrgx ? e.verb : (trailOf(e)[0].line)) + (e.at ? ' · ' + e.at : '')) + '</span>' +
      trailMarks(e) + '</button></li>';
  }

  function receiptDetailHtml(e) {
    var t = trailOf(e);
    if (e.inOrgx) { t[0].line = e.verb + ' in OrgX'; t[0].value = e.at; }
    var lines = t.map(function line(m) {
      return '<li class="rt-line" data-s="' + m.s + '"><span class="rt-m" data-s="' + m.s + '" aria-hidden="true">' + MARK[m.s] + '</span>' +
        '<span class="rt-l"><b>' + esc(m.name) + '</b> ' + esc(m.line) + (m.value && m.key !== 'decided' ? ' · <span class="rt-v">' + esc(m.value) + '</span>' : '') + '</span>' +
        (m.key === 'decided' && m.value ? '<span class="rt-t">' + esc(m.value) + '</span>' : '') + '</li>';
    }).join('');
    return '<div class="md-card" role="region" aria-label="Receipt">' +
      '<button type="button" class="md-close" data-action="receipt" data-id="" aria-label="Close receipt">×</button>' +
      '<p class="md-kicker">Receipt</p><h3 class="md-title">' + esc(e.title) + '</h3>' +
      '<ul class="rt-lines" role="list">' + lines + '</ul>' +
      '<div class="md-acts"><button type="button" class="pn-btn" data-action="open" data-url="' + esc(e.url) + '">Open decision in OrgX ↗</button></div></div>';
  }

  var WORK_RANGES = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']];

  /** Quality across the range: what the receipts showed, in one read. */
  function qualityHtml(items) {
    var c = { met: 0, unmet: 0, unknown: 0 };
    var checked = 0;
    var accepted = 0;
    var none = 0;
    items.forEach(function sum(r) {
      c.met += r.criteria.met; c.unmet += r.criteria.unmet; c.unknown += r.criteria.unknown;
      if (/^(verified|passed)$/i.test(r.verification || '')) checked += 1;
      if (/^accepted$/i.test(r.accepted || '')) accepted += 1;
      if (!(r.criteria.met + r.criteria.unmet + r.criteria.unknown)) none += 1;
    });
    var total = c.met + c.unmet + c.unknown;
    var bar = total
      ? '<div class="q-bar" role="img" aria-label="' + c.met + ' checks met, ' + c.unmet + ' not met, ' + c.unknown + ' with no evidence">' +
        ['met', 'unmet', 'unknown'].map(function seg(k) { return c[k] ? '<i data-s="' + k + '" style="flex:' + c[k] + '"></i>' : ''; }).join('') + '</div>' +
        '<ul class="q-key" role="list"><li data-s="met"><b>' + c.met + '</b> met</li><li data-s="unmet"><b>' + c.unmet + '</b> not met</li><li data-s="unknown"><b>' + c.unknown + '</b> no evidence</li></ul>'
      : '<p class="rc-quiet">None of this work wrote down what done meant, so none of it can be checked.</p>';
    return '<div class="md-card md-overview q-card" role="region" aria-label="Quality"><p class="md-kicker">Quality</p>' +
      '<h3 class="md-title">' + count(items.length, 'piece of work', 'pieces of work') + ', ' + count(total, 'check', 'checks') + '</h3>' + bar +
      '<dl class="q-facts"><div><dt>Checked after the change</dt><dd>' + checked + ' of ' + items.length + '</dd></div>' +
      '<div><dt>Accepted by a person</dt><dd>' + accepted + ' of ' + items.length + '</dd></div>' +
      (none ? '<div><dt>No criteria written</dt><dd>' + none + '</dd></div>' : '') + '</dl>' +
      '<p class="q-note">Pick a receipt to see each check and its evidence, then take it into the chat to fix what is not met.</p></div>';
  }

  /** The Work lens: Work Ledger receipts for the range. */
  function workReceiptsBody(opts) {
    var R = global.OrgXPanelReceipts;
    var data = opts.receipts;
    if (!R) return { body: '', detail: '' };
    if (!data && opts.receiptsPhase !== 'failed') return { body: skeletonRows(4), detail: '' };
    if (!data || data.status !== 'ok') {
      return { body: '<div class="notice" data-tone="amber" role="status"><p>' + esc((data && data.reason) || 'Work receipts could not be read right now.') + '</p>' +
        '<button type="button" class="text-btn" data-action="done-range" data-id="' + esc(opts.range) + '">Try again</button></div>', detail: '' };
    }
    if (!data.items.length) {
      return { body: '<p class="pn-done-sum">No receipts in this range. Work agents finish lands here with what done meant and whether it was met.</p>', detail: '' };
    }
    var sel = opts.rsel ? data.items.filter(function f(r) { return r.id === opts.rsel; })[0] || null : null;
    var detail = opts.rsel ? R.detailHtml(opts.receiptDetail, sel, { workspaceId: opts.workspaceId, phase: opts.receiptPhase, call: opts.receiptCall }) : qualityHtml(data.items);
    return {
      summary: '<p class="pn-done-sum"><b>' + count(data.total, 'receipt', 'receipts') + '</b> of agent work' + (data.total > data.items.length ? ' · newest ' + data.items.length + ' shown' : '') + '</p>',
      body: R.listHtml(data, { sel: opts.rsel, page: opts.page, pageSize: DONE_PAGE }),
      detail: detail,
      selected: Boolean(opts.rsel),
    };
  }

  /**
   * opts: { lens: 'work'|'decisions', session, history, historyPhase, range, sel, page, overviewHtml, launch, workspaceId,
   *         receipts, receiptsPhase, rsel, receiptDetail, receiptPhase }
   */
  function doneHtml(opts) {
    var lens = opts.lens === 'decisions' || !global.OrgXPanelReceipts ? 'decisions' : 'work';
    var lensSeg = global.OrgXPanelReceipts
      ? '<div class="seg dn-lens" role="group" aria-label="Show">' + [['work', 'Work'], ['decisions', 'Decisions']].map(function b(x) {
        return '<button type="button" class="seg-b" data-action="done-lens" data-id="' + x[0] + '" aria-pressed="' + (lens === x[0]) + '">' + x[1] + '</button>';
      }).join('') + '</div>'
      : '';
    if (lens === 'work') {
      var wrange = WORK_RANGES.some(function r(x) { return x[0] === opts.range; }) ? opts.range : '7d';
      var wseg = '<div class="seg" role="group" aria-label="Time range">' + WORK_RANGES.map(function b(r) {
        return '<button type="button" class="seg-b" data-action="done-range" data-id="' + r[0] + '" aria-pressed="' + (wrange === r[0]) + '">' + r[1] + '</button>';
      }).join('') + '</div>';
      var w = workReceiptsBody(Object.assign({}, opts, { range: wrange }));
      return '<section class="pn-done" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-done">' +
        '<div class="pn-view-head"><h2 class="pn-view-h">Done</h2><div class="dn-ctl">' + lensSeg + wseg + '</div></div>' + (w.summary || '') +
        '<div class="pn-md' + (w.selected ? ' has-sel' : '') + '"><div class="pn-md-list">' + w.body + '</div>' +
        '<aside class="pn-md-detail">' + w.detail + '</aside></div>' + (opts.launch || '') + '</section>';
    }
    var range = RANGES.some(function r(x) { return x[0] === opts.range; }) ? opts.range : 'session';
    var l = links();
    var historyUrl = l ? l.decisions({ status: 'all' }) : 'https://useorgx.com/decisions?status=all';
    var ledgerUrl = l && l.workLedger ? l.workLedger({ center: opts.workspaceId, range: range === '30d' ? '30d' : '7d' }) : 'https://useorgx.com/work-ledger';
    var seg = '<div class="seg" role="group" aria-label="Time range">' + RANGES.map(function b(r) {
      return '<button type="button" class="seg-b" data-action="done-range" data-id="' + r[0] + '" aria-pressed="' + (range === r[0]) + '">' + r[1] + '</button>';
    }).join('') + '</div>';
    var entries;
    var body;
    if (range === 'session') {
      entries = opts.session || [];
    } else if (opts.historyPhase === 'loading' && !opts.history) {
      entries = null;
      body = skeletonRows(4);
    } else if (!opts.history || opts.history.status !== 'ok') {
      entries = null;
      body = '<div class="notice" data-tone="amber" role="status"><p>' + esc((opts.history && opts.history.reason) || 'Decision history could not be read right now.') + '</p><button type="button" class="text-btn" data-action="done-range" data-id="' + range + '">Try again</button></div>';
    } else {
      entries = opts.history.items.map(historyEntry);
    }
    var selected = null;
    var summary = '';
    if (entries) {
      var approved = entries.filter(function a(e) { return e.action === 'approve'; }).length;
      var other = entries.length - approved;
      var label = range === 'session' ? 'here' : RANGES.filter(function r(x) { return x[0] === range; })[0][1].toLowerCase();
      summary = entries.length
        ? '<p class="pn-done-sum"><b>' + count(entries.length, 'decision settled', 'decisions settled') + '</b> ' + (range === 'session' ? 'since you opened the panel' : label === 'today' ? 'today' : 'in the last ' + label) +
          (approved ? ' <span aria-hidden="true">·</span> ' + approved + ' approved' : '') + (other ? ' <span aria-hidden="true">·</span> ' + other + (range === 'session' ? ' sent back' : ' declined or closed') : '') + '</p>'
        : '<p class="pn-done-sum">' + (range === 'session' ? 'Decisions you settle here collect as receipts. Pick a range to see what was settled in OrgX.' : 'Nothing was settled ' + (label === 'today' ? 'today' : 'in the last ' + label) + '.') + '</p>';
      var page = Math.max(1, opts.page || 1);
      var shown = entries.slice(0, page * DONE_PAGE);
      body = shown.length ? '<ul class="dn-rows" role="list">' + shown.map(function r(e) {
        var on = opts.sel === e.id;
        if (on) selected = e;
        return receiptRow(e, on);
      }).join('') + '</ul>' : '';
      if (entries.length > shown.length) body += '<button type="button" class="text-btn dn-more" data-action="done-more">Show ' + Math.min(DONE_PAGE, entries.length - shown.length) + ' more</button>';
      if (!selected && opts.sel) selected = entries.filter(function f(e) { return e.id === opts.sel; })[0] || null;
    }
    var overview = (opts.overviewHtml || '') +
      '<div class="md-links"><button type="button" class="pn-btn ghost" data-action="open" data-url="' + esc(historyUrl) + '">Decision history ↗</button>' +
      '<button type="button" class="pn-btn ghost" data-action="open" data-url="' + esc(ledgerUrl) + '">Work ledger ↗</button></div>';
    return '<section class="pn-done" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-done">' +
      '<div class="pn-view-head"><h2 class="pn-view-h">Done</h2><div class="dn-ctl">' + lensSeg + seg + '</div></div>' + summary +
      '<div class="pn-md' + (selected ? ' has-sel' : '') + '"><div class="pn-md-list">' + (body || '') + '</div>' +
      '<aside class="pn-md-detail">' + (selected ? receiptDetailHtml(selected) : '<div class="md-card md-overview" role="region" aria-label="Acceptance"><p class="md-kicker">Accepted work</p>' + overview + '</div>') + '</aside></div>' +
      (opts.launch || '') + '</section>';
  }

  global.OrgXPanelViews = { tabsHtml: tabsHtml, workHtml: workHtml, doneHtml: doneHtml, receiptHtml: receiptHtml, trailMarks: trailMarks, trailOf: trailOf, avatar: avatar, groupByAgent: groupByAgent };
})(typeof window !== 'undefined' ? window : globalThis);
