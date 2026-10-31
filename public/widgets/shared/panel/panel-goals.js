/**
 * OrgX panel: Goals. What all the work is for: each goal's number, the
 * history OrgX recorded for it, the initiatives counting toward it, what
 * moved it, and how work is judged (the workspace's quality bars).
 *
 * Only recorded values are drawn. A goal with no history has no line, a
 * goal with no target has no ring, and pace is said only when a start, a
 * target and a due date are all known. Setting a goal or linking an
 * initiative goes through the chat as a sentence the person sends.
 */
(function attachPanelGoals(global) {
  'use strict';
  if (global.OrgXPanelGoals) return;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function V() { return global.OrgXPanelViews; }
  function levelIcon(kind, size) { var I = global.OrgXPanelIcons; return I ? I.level(kind, size || 12) : ''; }
  function ago(iso) { var t = global.OrgXTime; return iso && t && t.relative ? t.relative(iso) : ''; }
  function count(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  var PLUS = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

  /** A value with its unit: symbols always; a word unit only where asked (once per phrase). */
  function fmt(n, unit, bare) {
    if (!isNum(n)) return '';
    var shown = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100);
    var u = String(unit || '').trim();
    if (u === '%') return shown + '%';
    if (u === '$' || /^usd$/i.test(u)) return '$' + shown;
    return u && !bare ? shown + ' ' + u : shown;
  }
  function dueDate(due) {
    var t = Date.parse(due || '');
    return isFinite(t) ? t : null;
  }
  function dueText(due) {
    var t = dueDate(due);
    if (t === null) return due || '';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  }

  /**
   * On pace, behind or ahead: only from a recorded start (the baseline, else
   * the first recorded value), a target and a due date that parses.
   */
  function paceOf(g, now) {
    var start = isNum(g.baseline) ? g.baseline : g.history.length ? g.history[0].value : null;
    var startAt = g.history.length ? Date.parse(g.history[0].at) : NaN;
    var due = dueDate(g.due);
    if (!isNum(g.current) || !isNum(g.target) || !isNum(start) || !isFinite(startAt) || due === null || due <= startAt || g.target === start) return null;
    var toward = (g.current - start) / (g.target - start);
    if (toward >= 1) return { key: 'reached', text: 'Reached' };
    var t = Math.min(1, Math.max(0, ((now || Date.now()) - startAt) / (due - startAt)));
    var gap = toward - t;
    if (t >= 1) return { key: 'behind', text: 'Past due' };
    return gap >= 0.1 ? { key: 'ahead', text: 'Ahead of pace' } : gap >= -0.05 ? { key: 'on', text: 'On pace' } : { key: 'behind', text: 'Behind pace' };
  }
  /**
   * "Needs 2.6 a week": OrgX's own figure from the recorded baseline, target
   * and due date (the goal's `pace`); nothing when it did not compute one.
   */
  function needsText(g) {
    var p = g.pace;
    if (!p || !isNum(p.per_week) || p.per_week <= 0) return '';
    var amount = fmt(p.per_week, g.unit);
    return 'Needs ' + (p.direction === 'down' ? amount + ' less' : amount) + ' a week to land on time';
  }
  function shareOf(g) {
    if (!isNum(g.current) || !isNum(g.target) || g.target <= 0) return null;
    return Math.max(0, Math.min(1, g.current / g.target));
  }

  function ringHtml(p) {
    if (p === null) return '<span class="gl-tile">' + levelIcon('goal', 16) + '</span>';
    var c = 47.1;
    return '<svg class="gl-ring" viewBox="0 0 20 20" width="32" height="32" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" class="gl-ring-bg" stroke-width="3"/>' +
      '<circle cx="10" cy="10" r="7.5" fill="none" class="gl-ring-fg" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + (p * c).toFixed(1) + ' ' + c + '" transform="rotate(-90 10 10)"/></svg>';
  }

  /** The recorded values as a line, the target dashed. Two points at least, or nothing. */
  function sparkHtml(g) {
    var pts = g.history.slice();
    if (isNum(g.current) && pts.length && pts[pts.length - 1].value !== g.current) pts.push({ at: new Date().toISOString(), value: g.current });
    if (pts.length < 2) return '';
    var W = 460, H = 56;
    var vals = pts.map(function v(p) { return p.value; });
    var lo = Math.min.apply(null, vals.concat(isNum(g.target) ? [g.target] : []));
    var hi = Math.max.apply(null, vals.concat(isNum(g.target) ? [g.target] : []));
    if (hi === lo) hi = lo + 1;
    var pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    var x = function px(k) { return 3 + k * (W - 6) / (pts.length - 1); };
    var y = function py(v) { return H - 4 - ((v - lo) / (hi - lo)) * (H - 8); };
    var line = pts.map(function seg(p, k) { return (k ? 'L' : 'M') + x(k).toFixed(1) + ',' + y(p.value).toFixed(1); }).join('');
    var last = pts[pts.length - 1];
    return '<svg class="gl-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
      esc(fmt(pts[0].value, g.unit) + ' to ' + fmt(last.value, g.unit) + ' across ' + pts.length + ' recorded values' + (isNum(g.target) ? ', target ' + fmt(g.target, g.unit) : '')) + '">' +
      (isNum(g.target) ? '<line class="gl-spark-target" x1="0" x2="' + W + '" y1="' + y(g.target).toFixed(1) + '" y2="' + y(g.target).toFixed(1) + '"/>' : '') +
      '<path class="gl-spark-fill" d="' + line + ' L' + x(pts.length - 1).toFixed(1) + ',' + H + ' L' + x(0).toFixed(1) + ',' + H + 'Z"/>' +
      '<path class="gl-spark-line" d="' + line + '"/><circle class="gl-spark-dot" cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(last.value).toFixed(1) + '" r="3.5"/></svg>';
  }

  function goalMeta(g) {
    var bits = [];
    if (isNum(g.current) && isNum(g.target)) bits.push(fmt(g.current, g.unit, true) + ' of ' + fmt(g.target, g.unit));
    else if (isNum(g.current)) bits.push(fmt(g.current, g.unit) + ' · no target');
    else bits.push('No number recorded');
    if (g.due) bits.push(dueText(g.due));
    return bits.join(' · ');
  }

  var RISK = { at_risk: 'At risk', off_track: 'Off track', blocked: 'Blocked' };
  function initiativeRows(list, opts, linkable) {
    if (!list.length) return '<p class="oc-quiet">' + (linkable ? 'Every initiative counts toward a goal.' : 'No initiative counts toward this goal yet.') + '</p>';
    return '<ul class="gl-inits" role="list">' + list.map(function row(i) {
      var needs = opts.needs && opts.needs[i.id] ? opts.needs[i.id] : [];
      var ms = i.milestones_total ? i.milestones_done + ' of ' + i.milestones_total + ' milestones' : 'No milestones yet';
      var pct = i.milestones_total ? Math.round(i.milestones_done / i.milestones_total * 100) : null;
      var link = opts.links && opts.links[i.id];
      var trail = (needs.length ? '<button type="button" class="pn-chip is-warn" data-action="goal-needs" data-id="' + esc(needs[0]) + '">' + needs.length + ' needs you</button>' : '') +
        (RISK[i.risk] ? '<span class="gl-risk">' + RISK[i.risk] + '</span>' : '') +
        (linkable ? (link
          ? '<span class="gl-linked" role="status">' + esc(link === 'sent' ? 'Sent to the chat' : link === 'copied' ? 'Copied. Paste it in the chat' : 'Type it in the chat') + '</span>'
          : '<button type="button" class="pn-btn" data-action="goal-link" data-id="' + esc(i.id) + '" data-title="' + esc(i.title) + '">Link</button>') : '');
      return '<li class="gl-init"><span class="gl-init-i" aria-hidden="true">' + levelIcon('initiative', 14) + '</span>' +
        '<span class="gl-init-main"><button type="button" class="gl-init-t" data-action="open" data-url="' + esc(i.url) + '">' + esc(i.title) + '</button>' +
        '<span class="gl-init-m">' + levelIcon('milestone', 11) + esc(ms) + (pct !== null ? '<span class="gl-bar" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' : '') + '</span></span>' +
        '<span class="gl-init-r">' + trail + '</span></li>';
    }).join('') + '</ul>';
  }

  function movesHtml(g, reasons) {
    if (!g.moves.length) return '';
    var said = reasons && Array.isArray(reasons[g.id]) ? reasons[g.id] : [];
    return '<h4 class="oc-cap">What moved it</h4><ul class="gl-moves" role="list">' + g.moves.slice(0, 6).map(function m(x, k) {
      var up = x.delta > 0;
      var why = typeof said[k] === 'string' && said[k] ? said[k] : null;
      return '<li><span class="gl-delta" data-dir="' + (up ? 'up' : 'down') + '">' + (up ? '+' : '−') + esc(fmt(Math.abs(x.delta), g.unit, true)) + '</span>' +
        '<span class="gl-move-t">' + esc(why || 'No reason recorded') + '<span class="gl-move-m">' + esc(fmt(x.from, g.unit, true) + ' → ' + fmt(x.to, g.unit) + (x.at ? ' · ' + ago(x.at) : '')) + '</span></span>' +
        (x.decision_id && global.OrgXLinks ? '<button type="button" class="text-btn" data-action="open" data-url="' + esc(global.OrgXLinks.decision(x.decision_id)) + '">Decision ↗</button>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function barsHtml(bars, url) {
    var text = bars === null ? 'Quality bars could not be read right now.'
      : !bars.length ? 'No quality bars yet. Send-back notes can become one.'
      : count(bars.length, 'quality bar', 'quality bars') + ': ' + bars.slice(0, 4).map(function n(b) { return b.name + ' (' + count(b.criteria, 'check', 'checks') + ')'; }).join(', ') + (bars.length > 4 ? ', and ' + (bars.length - 4) + ' more' : '') + '.';
    return '<div class="gl-judge"><h3 class="pn-cap">How you judge work</h3><p class="gl-judge-t">' + esc(text) + '</p>' +
      (url ? '<button type="button" class="text-btn" data-action="open" data-url="' + esc(url) + '">Review in OrgX ↗</button>' : '') + '</div>';
  }

  function formHtml(form, first) {
    form = form || {};
    var status = form.status
      ? '<p class="st-status" role="status" data-outcome="' + esc(form.status) + '">' + esc(form.status === 'sent' ? 'Sent. The chat sets it up in OrgX; it shows here once it is saved.' : form.status === 'copied' ? 'Copied. Paste it into the chat to send it.' : 'Couldn’t send it from here. Type it in the chat.') + '</p>'
      : '';
    var text = form.text || '';
    return '<div class="gl-form' + (first ? ' is-first' : '') + '">' +
      (first ? '<span class="pn-empty-art" aria-hidden="true">' + levelIcon('goal', 28) + '</span>' : '') +
      '<h3 class="pn-empty-h" id="gl-form-h">What should all this work move?</h3>' +
      '<p class="pn-empty-p">One number and a date. Initiatives sit under it, and outputs that move it show up here.</p>' +
      '<div class="gl-form-row"><label class="sr-only" for="gl-goal">Goal</label><input id="gl-goal" type="text" data-action="goal-text" maxlength="200" autocomplete="off" placeholder="40 paid workspaces by Dec 31" value="' + esc(text) + '">' +
      '<button type="button" class="pn-btn is-primary" data-action="goal-send"' + (text.trim() ? '' : ' disabled') + '>Set goal</button></div>' +
      '<p class="steer-hint">Goes to the chat as “' + esc(sentence(text || '…')) + '”</p>' + status + '</div>';
  }
  function sentence(text) {
    var t = String(text || '').trim().replace(/\s+/g, ' ').replace(/[.。]+$/, '');
    return t ? 'Create a goal in OrgX: ' + t + '.' : '';
  }
  function linkSentence(title, goals) {
    var named = goals && goals.status === 'ok' && goals.items.length === 1 ? goals.items[0].title : null;
    return named
      ? 'In OrgX, link the initiative “' + title + '” to the goal “' + named + '”.'
      : 'In OrgX, link the initiative “' + title + '” to one of my goals. Ask me which one.';
  }

  /**
   * opts: { sel, needs: { initiativeId: [decisionId] }, links: { initiativeId: outcome }, form: { open, text, status }, now, qualityUrl }
   */
  function html(data, phase, opts) {
    opts = opts || {};
    var head = '<div class="pn-view-head"><h2 class="pn-view-h">Goals</h2></div>';
    var open = function section(body, busy) {
      return '<section class="pn-goals" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-goals"' + (busy ? ' aria-busy="true"' : '') + '>' + head + body + '</section>';
    };
    if (phase === 'loading' && !data) return open(V().skeletonRows(4) + '<p class="sr-only">Loading your goals.</p>', true);
    if (!data || data.status !== 'ok' || phase === 'failed') {
      return open('<div class="notice" data-tone="amber" role="status"><p>' + esc((data && data.reason) || 'Goals could not be read right now.') + '</p>' +
        '<button type="button" class="text-btn" data-action="goals-retry">Try again</button></div>');
    }
    if (!data.items.length && !data.unlinked_total) return open(formHtml(opts.form, true) + barsHtml(data.quality_bars, opts.qualityUrl));
    var entries = data.items.map(function g(x) { return { id: x.id, goal: x }; });
    if (data.unlinked_total) entries.push({ id: 'none', goal: null });
    var sel = entries.filter(function f(e) { return e.id === opts.sel; })[0] || entries[0];
    var rows = entries.map(function row(e) {
      var on = e.id === sel.id && !(opts.form && opts.form.open);
      var g = e.goal;
      return '<li><button type="button" class="gl-row" data-action="goal-open" data-id="' + esc(e.id) + '" aria-pressed="' + on + '">' +
        (g ? ringHtml(shareOf(g)) : '<span class="gl-tile">' + levelIcon('initiative', 16) + '</span>') +
        '<span class="oc-main"><span class="oc-t">' + esc(g ? g.title : 'No goal') + '</span><span class="oc-m">' + esc(g ? goalMeta(g) : count(data.unlinked_total, 'initiative', 'initiatives')) + '</span></span></button></li>';
    }).join('');
    var scope = '<div class="pn-scope"><span class="pn-tok is-static">' + count(data.total, 'goal', 'goals') + '</span><span class="pn-scope-sp"></span>' +
      '<button type="button" class="pn-tok is-icon" data-action="goal-new" aria-label="Add a goal" title="Add a goal">' + PLUS + '</button></div>';
    var sw = '<div class="goalswitch" role="group" aria-label="Goal">' + entries.map(function chip(e) {
      return '<button type="button" class="pn-chip" data-action="goal-open" data-id="' + esc(e.id) + '" aria-pressed="' + (e.id === sel.id && !(opts.form && opts.form.open)) + '">' +
        levelIcon(e.goal ? 'goal' : 'initiative') + esc(e.goal ? e.goal.title : 'No goal') + '</button>';
    }).join('') + '<button type="button" class="pn-chip" data-action="goal-new" aria-pressed="' + Boolean(opts.form && opts.form.open) + '">' + levelIcon('goal') + 'New goal</button></div>';
    var body;
    if (opts.form && opts.form.open) {
      body = '<div class="md-card">' + V().backHtml('goal-open', 'Back to Goals') + formHtml(opts.form, false) + '</div>';
    } else if (sel.goal) {
      var g = sel.goal;
      var pace = paceOf(g, opts.now);
      body = '<div class="md-card gl-detail" role="region" aria-label="Goal">' +
        '<p class="md-kicker oc-kind">' + levelIcon('goal') + '<span>Goal' + (g.due ? ' · due ' + esc(dueText(g.due)) : '') + '</span></p>' +
        '<h3 class="md-title">' + esc(g.title) + '</h3>' +
        (isNum(g.current)
          ? '<p class="gl-now"><span class="gl-big">' + esc(fmt(g.current, g.unit, true)) + '</span><span class="gl-of">' + (isNum(g.target) ? 'of ' + esc(fmt(g.target, g.unit)) : 'No target recorded') +
            (pace ? ' · <span class="gl-pace" data-pace="' + pace.key + '">' + esc(pace.text) + '</span>' : '') + '</span></p>' +
            (needsText(g) ? '<p class="gl-needs">' + esc(needsText(g)) + '</p>' : '')
          : '<p class="oc-quiet">No number has been recorded for this goal yet.</p>') +
        sparkHtml(g) +
        '<h4 class="oc-cap">Initiatives · ' + g.initiative_total + '</h4>' + initiativeRows(g.initiatives, opts, false) +
        (g.initiative_total > g.initiatives.length ? '<p class="oc-quiet">' + (g.initiative_total - g.initiatives.length) + ' more in OrgX.</p>' : '') +
        movesHtml(g, opts.reasons) +
        '<div class="md-acts"><button type="button" class="pn-btn ghost" data-action="open" data-url="' + esc(g.url) + '">Open goal in OrgX ↗</button></div></div>';
    } else {
      body = '<div class="md-card gl-detail" role="region" aria-label="Initiatives with no goal">' +
        '<p class="md-kicker oc-kind">' + levelIcon('initiative') + '<span>Not linked</span></p>' +
        '<h3 class="md-title">Initiatives with no goal</h3>' +
        '<p class="md-text">Their outputs can’t count toward anything until they’re linked.</p>' +
        '<h4 class="oc-cap">Initiatives · ' + data.unlinked_total + '</h4>' + initiativeRows(data.unlinked, opts, true) + '</div>';
    }
    return open(scope + '<div class="pn-md gl-md has-sel"><div class="pn-md-list"><ul class="gl-rows" role="list">' + rows + '</ul>' + barsHtml(data.quality_bars, opts.qualityUrl) + '</div>' +
      '<aside class="pn-md-detail">' + sw + body + '</aside></div>', phase === 'loading');
  }

  /** The goal an initiative counts toward, when the Goals read says. */
  function goalOfInitiative(data, initiativeId) {
    if (!data || data.status !== 'ok' || !initiativeId) return undefined;
    for (var i = 0; i < data.items.length; i += 1) {
      var g = data.items[i];
      for (var j = 0; j < g.initiatives.length; j += 1) if (g.initiatives[j].id === initiativeId) return { goal: g, initiative: g.initiatives[j] };
    }
    for (var k = 0; k < (data.unlinked || []).length; k += 1) if (data.unlinked[k].id === initiativeId) return { goal: null, initiative: data.unlinked[k] };
    return undefined;
  }

  global.OrgXPanelGoals = {
    html: html, paceOf: paceOf, needsText: needsText, sentence: sentence, linkSentence: linkSentence, goalOfInitiative: goalOfInitiative, fmt: fmt, goalMeta: goalMeta,
  };
})(typeof window !== 'undefined' ? window : globalThis);
