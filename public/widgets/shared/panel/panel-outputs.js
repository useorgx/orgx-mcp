/**
 * OrgX panel: Outputs. What agents made, and what happened after: made,
 * accepted by a person, landed (merged, published, shipped), and moved a
 * goal. Each step shows only what OrgX recorded; a step nobody recorded is
 * drawn empty and says so, never filled in.
 *
 * Pure string builders; the controller owns state and events. The decision
 * behind an output is the same one Needs you shows, settled through the
 * same path, only on the person's tap.
 */
(function attachPanelOutputs(global) {
  'use strict';
  if (global.OrgXPanelOutputs) return;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function V() { return global.OrgXPanelViews; }
  function I() { return global.OrgXPanelIcons; }
  function ago(iso) { var t = global.OrgXTime; return iso && t && t.relative ? t.relative(iso) : ''; }
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function avatar(name) { return V() && name ? V().avatar(name, 'inline') : ''; }
  function levelIcon(kind) { return I() ? I().level(kind, 12) : ''; }
  function outIcon(type, size) { return I() ? I().output(type || 'doc', size || 16) : ''; }

  var RANGES = [['today', 'Today', 1], ['7d', 'Last 7 days', 7], ['30d', 'Last 30 days', 30]];
  var RANGE_SHORT = { today: 'Today', '7d': '7 days', '30d': '30 days' };
  var FAMILIES = [['all', 'All types'], ['code', 'Code and data'], ['writing', 'Writing'], ['media', 'Media'], ['routine', 'Routines']];
  var FAMILY_LEAD = { code: 'code', writing: 'doc', media: 'video', routine: 'routine' };
  var DAY = 86400000;

  /** The type's own word, from the artifact type OrgX recorded. */
  function typeLabel(o) {
    var t = String(o.type || '').replace(/[_-]+/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Output';
  }

  function inRange(o, range, now) {
    var days = (RANGES.filter(function r(x) { return x[0] === range; })[0] || RANGES[1])[2];
    var t = Date.parse(o.made_at || '');
    // An output with no recorded time cannot be placed in a short range.
    if (!isFinite(t)) return days >= 30;
    if (days === 1) return new Date(t).toDateString() === new Date(now).toDateString();
    return now - t <= days * DAY;
  }

  /** Initiative id → { goal id or 'none', initiative title }, from the Goals read when it is there. */
  function goalIndex(goals) {
    var idx = {};
    if (!goals || goals.status !== 'ok') return null;
    goals.items.forEach(function g(goal) { goal.initiatives.forEach(function i(x) { idx[x.id] = { goal: goal.id, title: x.title, goalTitle: goal.title }; }); });
    (goals.unlinked || []).forEach(function u(x) { idx[x.id] = { goal: 'none', title: x.title, goalTitle: null }; });
    return idx;
  }

  function filtered(data, opts, idx) {
    var now = opts.now || Date.now();
    var fam = opts.family || 'all';
    var goal = idx ? opts.goal || 'all' : 'all';
    return data.items.filter(function keep(o) {
      if (!inRange(o, opts.range || '7d', now)) return false;
      if (fam !== 'all' && o.family !== fam) return false;
      if (goal !== 'all') {
        var at = o.initiative_id ? idx[o.initiative_id] : null;
        if (goal === 'none' ? at && at.goal !== 'none' : !at || at.goal !== goal) return false;
      }
      return true;
    });
  }

  /** Made → Accepted → Landed → Moved, each as OrgX recorded it. */
  function chainOf(o) {
    var a = o.accepted || { state: 'unknown' };
    var accepted = a.state === 'accepted'
      ? { s: 'on', line: a.by === 'you' ? 'By you' : a.by ? 'By a teammate' : 'By a person' }
      : a.state === 'waiting' ? { s: 'wait', line: 'Waiting on review' }
      : a.state === 'sent_back' ? { s: 'back', line: 'Sent back' }
      : a.state === 'not_reviewed' ? { s: 'off', line: 'Not reviewed' }
      : { s: 'off', line: 'Not recorded' };
    return [
      { name: 'Made', s: 'on', line: o.made_at ? ago(o.made_at) : 'Time not recorded' },
      { name: 'Accepted', s: accepted.s, line: accepted.line + (a.at && accepted.s === 'on' ? ' · ' + ago(a.at) : '') },
      o.landed ? { name: 'Landed', s: 'on', line: o.landed.label + (o.landed.at ? ' · ' + ago(o.landed.at) : '') } : { name: 'Landed', s: 'off', line: 'Not recorded' },
      o.moved ? { name: 'Moved', s: 'on', line: o.moved.label } : { name: 'Moved', s: 'off', line: 'Not recorded' },
    ];
  }
  function stageWord(chain) {
    var at = 0;
    chain.forEach(function last(c, k) { if (c.s === 'on') at = k; });
    var waiting = chain[1].s === 'wait' ? ', waiting on review' : chain[1].s === 'back' ? ', sent back' : '';
    return chain[at].name + waiting;
  }
  function dotsHtml(o) {
    var chain = chainOf(o);
    return '<span class="oc-dots" role="img" aria-label="' + esc(stageWord(chain)) + '" title="' + esc(stageWord(chain)) + '">' +
      chain.map(function d(c) { return '<i data-s="' + c.s + '"></i>'; }).join('') + '</span>';
  }

  function rowHtml(o, on, idx) {
    var init = o.initiative_id && idx && idx[o.initiative_id] ? idx[o.initiative_id].title : '';
    var meta = [o.made_by || '', o.made_at ? ago(o.made_at) : ''].filter(Boolean);
    return '<li><button type="button" class="oc-row" data-action="out-select" data-id="' + esc(o.id) + '" aria-pressed="' + on + '">' +
      '<span class="oc-tile" data-fam="' + esc(o.family) + '">' + outIcon(o.type, 16) + '</span>' +
      '<span class="oc-main"><span class="oc-t">' + esc(o.title) + '</span><span class="oc-m">' +
      (o.made_by ? '<span class="md-av">' + avatar(o.made_by) + '</span>' : '') +
      esc(meta.join(' · ')) + (init ? (meta.length ? ' · ' : '') + '<span class="pn-lv">' + levelIcon('initiative') + esc(init) + '</span>' : '') + '</span></span>' +
      dotsHtml(o) + '</button></li>';
  }

  /** What it says, from the widget-only preview (never the snapshot); nothing when OrgX recorded none. */
  function previewHtml(o, said) {
    said = said || {};
    var text = typeof said.preview === 'string' ? said.preview : '';
    var summary = typeof said.summary === 'string' ? said.summary : '';
    if (!text && !summary) return o.has_preview ? '<p class="oc-quiet">The preview did not come with this read. Open it in OrgX.</p>' : '';
    if (text && o.family === 'code') {
      return '<pre class="pv pv-code" data-swipe="off">' + text.split('\n').map(function line(l) {
        var k = /^\+(?!\+\+)/.test(l) ? 'a' : /^-(?!--)/.test(l) ? 'd' : '';
        return k ? '<span class="' + k + '">' + esc(l) + '</span>' : esc(l);
      }).join('\n') + '</pre>';
    }
    return '<div class="pv pv-doc">' + (summary && text !== summary ? '<p class="pv-sum">' + esc(summary) + '</p>' : '') + (text ? '<p>' + esc(text) + '</p>' : '') + '</div>';
  }

  function checksHtml(o) {
    var checks = o.checks || [];
    var met = checks.filter(function m(c) { return c.met; }).length;
    var head = (o.checks_source ? o.checks_source + ' quality bar' : typeLabel(o) + ' checks') + (checks.length ? ' · ' + met + ' of ' + checks.length + ' met' : '');
    var body = checks.length
      ? '<ul class="std" role="list">' + checks.map(function c(x) {
        return '<li data-met="' + x.met + '"><span class="std-m" aria-hidden="true">' + (x.met ? '✓' : '×') + '</span><span>' + esc(x.label) + '<span class="sr-only">' + (x.met ? ', met' : ', not met') + '</span></span></li>';
      }).join('') + '</ul>'
      : '<p class="oc-quiet">No checks were recorded for this output. A send-back note can start a bar for its type.</p>';
    return '<div class="oc-checks"><p class="oc-cap">' + esc(head) + '</p>' + body + '</div>';
  }

  /** The decision behind it, settled here only on a tap, the same as in Needs you. */
  function actbarHtml(o, decision) {
    if (!o.decision_id || !decision) return '';
    if (decision.ruling) {
      return '<div class="oc-act"><span class="oc-act-t">Same decision as in Needs you</span><ox-state-chip state="' + esc(decision.ruling.chip) + '" label="' + esc(decision.ruling.label) + '"></ox-state-chip></div>';
    }
    var acts = '<button type="button" class="pn-btn" data-action="out-decide" data-id="' + esc(o.decision_id) + '" data-mode="sendback">' + esc(decision.rejectLabel || 'Send back') + '</button>';
    acts += decision.quick
      ? '<button type="button" class="pn-btn is-primary" data-action="approve" data-id="' + esc(o.decision_id) + '">' + esc(decision.approveLabel || 'Approve') + '</button>'
      : '<button type="button" class="pn-btn is-primary" data-action="out-decide" data-id="' + esc(o.decision_id) + '" data-mode="open">Review in Needs you</button>';
    if (!decision.canDecide) acts = '<button type="button" class="pn-btn" data-action="out-decide" data-id="' + esc(o.decision_id) + '" data-mode="open">Open in Needs you</button>';
    return '<div class="oc-act"><span class="oc-act-t">Same decision as in Needs you</span>' + acts + '</div>';
  }

  function detailHtml(o, opts, idx) {
    var chain = chainOf(o);
    var at = o.initiative_id && idx ? idx[o.initiative_id] : null;
    var crumbs = at ? '<nav class="crumbs" aria-label="Where this sits">' +
      (at.goalTitle ? '<button type="button" class="crumb" data-action="goal-open" data-id="' + esc(at.goal) + '">' + levelIcon('goal') + esc(at.goalTitle) + '</button><span class="crumb-sep" aria-hidden="true">/</span>' : '') +
      '<span class="crumb">' + levelIcon('initiative') + esc(at.title) + '</span></nav>' : '';
    var decision = o.decision_id && opts.decision ? opts.decision(o.decision_id) : null;
    return '<div class="md-card oc-detail" role="region" aria-label="Output">' + V().backHtml('out-select', 'Back to Outputs') +
      '<p class="md-kicker oc-kind"><span class="oc-chip">' + outIcon(o.type, 14) + esc(typeLabel(o)) + '</span>' +
      (o.made_by ? '<span class="md-av">' + avatar(o.made_by) + '</span><span>' + esc(o.made_by) + '</span>' : '') + (o.made_at ? '<span>· ' + esc(ago(o.made_at)) + '</span>' : '') + '</p>' +
      '<h3 class="md-title">' + esc(o.title) + '</h3>' + crumbs +
      '<ol class="oc-chain" aria-label="What happened">' + chain.map(function step(c) {
        return '<li data-s="' + c.s + '"><span class="oc-cd" aria-hidden="true"></span><span class="oc-cn">' + c.name + '</span><span class="oc-cl">' + esc(c.line) + '</span></li>';
      }).join('') + '</ol>' +
      previewHtml(o, opts.previewFor ? opts.previewFor(o.id) : null) + checksHtml(o) + actbarHtml(o, decision) +
      '<div class="md-acts"><button type="button" class="pn-btn ghost" data-action="open" data-url="' + esc(o.url) + '">Open in OrgX ↗</button>' +
      (o.external_url ? '<button type="button" class="pn-btn ghost" data-action="open" data-url="' + esc(o.external_url) + '">Open the ' + esc(typeLabel(o).toLowerCase()) + ' ↗</button>' : '') + '</div></div>';
  }

  function emptyHtml(icon, h, p, act) {
    return '<div class="pn-empty"><span class="pn-empty-art" aria-hidden="true">' + icon + '</span><h3 class="pn-empty-h">' + esc(h) + '</h3><p class="pn-empty-p">' + esc(p) + '</p>' + (act || '') + '</div>';
  }

  /**
   * opts: { sel, range, family, goal, goals, pop, now, previewFor(id) → { summary, preview } | null,
   *         decision(id) → { quick, canDecide, approveLabel, rejectLabel, ruling } }
   */
  function html(data, phase, opts) {
    opts = opts || {};
    var head = '<div class="pn-view-head"><h2 class="pn-view-h">Outputs</h2></div>';
    var open = function section(body, busy) {
      return '<section class="pn-outputs" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-outputs"' + (busy ? ' aria-busy="true"' : '') + '>' + head + body + '</section>';
    };
    if (phase === 'loading' && !data) return open(V().skeletonRows(5) + '<p class="sr-only">Loading what your agents made.</p>', true);
    if (!data || data.status !== 'ok' || phase === 'failed') {
      return open('<div class="notice" data-tone="amber" role="status"><p>' + esc((data && data.reason) || 'Outputs could not be read right now.') + '</p>' +
        '<button type="button" class="text-btn" data-action="outputs-retry">Try again</button></div>');
    }
    if (!data.items.length) {
      return open(emptyHtml(outIcon('doc', 28), 'No outputs yet', 'Code, posts, videos, decks, pipelines and routines your agents make land here, with what happened after.',
        '<button type="button" class="pn-btn" data-action="tab" data-tab="work">See work</button>'));
    }
    var idx = goalIndex(opts.goals);
    var range = RANGE_SHORT[opts.range] ? opts.range : '7d';
    var family = FAMILIES.some(function f(x) { return x[0] === opts.family; }) ? opts.family : 'all';
    var goal = idx ? opts.goal || 'all' : 'all';
    var list = filtered(data, { range: range, family: family, goal: goal, now: opts.now }, idx);
    var toReview = list.filter(function w(o) { return o.accepted && o.accepted.state === 'waiting'; });
    var goalItems = idx ? [{ label: 'All goals', action: 'out-goal', id: 'all', on: goal === 'all' }].concat(opts.goals.items.map(function g(x) {
      return { label: x.title, action: 'out-goal', id: x.id, on: goal === x.id, lead: levelIcon('goal') };
    })).concat(opts.goals.unlinked_total ? [{ label: 'No goal', action: 'out-goal', id: 'none', on: goal === 'none', lead: levelIcon('initiative') }] : []) : null;
    var goalName = goal === 'all' ? 'All goals' : goal === 'none' ? 'No goal' : ((opts.goals.items.filter(function g(x) { return x.id === goal; })[0] || {}).title || 'Goal');
    var scope = '<div class="pn-scope">' +
      V().tokHtml('orange', RANGE_SHORT[range], { open: opts.pop, title: 'Range', items: RANGES.map(function r(x) { return { label: x[1], action: 'out-range', id: x[0], on: range === x[0] }; }) }) +
      (goalItems ? V().tokHtml('ogoal', goalName, { open: opts.pop, on: goal !== 'all', lead: levelIcon('goal'), title: 'Goal', items: goalItems }) : '') +
      V().tokHtml('ofam', (FAMILIES.filter(function f(x) { return x[0] === family; })[0] || FAMILIES[0])[1], {
        open: opts.pop, on: family !== 'all', title: 'Type',
        items: FAMILIES.map(function f(x) { return { label: x[1], action: 'out-family', id: x[0], on: family === x[0], lead: x[0] === 'all' ? '' : outIcon(FAMILY_LEAD[x[0]], 14) }; }),
      }) + '</div>';
    var inits = {};
    list.forEach(function n(o) { if (o.initiative_id) inits[o.initiative_id] = true; });
    var nInits = Object.keys(inits).length;
    var sum = '<p class="pn-done-sum"><b>' + count(list.length, 'output', 'outputs') + '</b>' + (nInits ? ' · ' + count(nInits, 'initiative', 'initiatives') : '') + ' · latest first' +
      (toReview.length ? ' · <b>' + toReview.length + '</b> to review' : '') + (data.total > data.items.length ? ' · newest ' + data.items.length + ' of ' + data.total + ' read' : '') + '</p>';
    if (!list.length) {
      return open(scope + sum + '<div class="pn-empty is-small"><p class="pn-empty-p">Nothing in this range.</p>' +
        '<button type="button" class="pn-btn" data-action="out-clear">Show 30 days, all types</button></div>');
    }
    var ordered = toReview.concat(list.filter(function rest(o) { return toReview.indexOf(o) === -1; }));
    var sel = ordered.filter(function f(o) { return o.id === opts.sel; })[0] || null;
    var group = null;
    var rows = '';
    ordered.forEach(function each(o) {
      var g = toReview.indexOf(o) !== -1 ? 'To review' : 'Latest';
      if (g !== group) { rows += (group ? '</ul>' : '') + '<h3 class="pn-cap">' + g + '</h3><ul class="oc-rows" role="list">'; group = g; }
      rows += rowHtml(o, Boolean(sel && sel.id === o.id), idx);
    });
    rows += '</ul>';
    var overview = '<div class="md-card md-overview" role="region" aria-label="Outputs overview"><p class="md-kicker">' + esc(RANGE_SHORT[range]) + '</p>' +
      '<h3 class="md-title">' + count(list.length, 'output', 'outputs') + '</h3>' +
      '<ul class="oc-key" role="list">' + ['Made', 'Accepted', 'Landed', 'Moved'].map(function k(n, i) {
        var c = list.filter(function on(o) { return chainOf(o)[i].s === 'on'; }).length;
        return '<li><i data-s="on" aria-hidden="true"></i><b>' + c + '</b> ' + n.toLowerCase() + '</li>';
      }).join('') + '</ul>' +
      '<p class="md-text">Select an output to see what it is, how it checked out, and what it moved.</p></div>';
    return open(scope + sum + '<div class="pn-md is-push' + (sel ? ' has-sel' : '') + '"><div class="pn-md-list">' + rows + '</div>' +
      '<aside class="pn-md-detail">' + (sel ? detailHtml(sel, opts, idx) : overview) + '</aside></div>', phase === 'loading');
  }

  /** What still waits on a person's review, for the tab's count. */
  function toReviewCount(data) {
    if (!data || data.status !== 'ok') return null;
    return data.items.filter(function w(o) { return o.accepted && o.accepted.state === 'waiting'; }).length;
  }

  global.OrgXPanelOutputs = { html: html, chainOf: chainOf, toReviewCount: toReviewCount, filtered: filtered, goalIndex: goalIndex };
})(typeof window !== 'undefined' ? window : globalThis);
