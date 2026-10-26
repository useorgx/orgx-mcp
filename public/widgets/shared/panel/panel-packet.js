/**
 * OrgX panel: the parts of a decision packet that place it and spell it out.
 *
 *   crumbsHtml  where the decision sits (goal / initiative / milestone), with
 *               every level OrgX named one press away;
 *   outsHtml    what happens if you go ahead, send it back, or nobody decides,
 *               and what the decision does not cover;
 *   bulk        the selection bar and the undo toast for deciding several
 *               plain approvals at once.
 *
 * Only levels and consequences the packet carries are drawn. Pure string
 * builders; the controller owns state, events and the undo window.
 */
(function attachPanelPacket(global) {
  'use strict';
  if (global.OrgXPanelPacket) return;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function levelIcon(kind, size) { var I = global.OrgXPanelIcons; return I ? I.level(kind, size || 12) : ''; }
  function links() { return global.OrgXLinks || null; }

  var LEVEL_NAME = { goal: 'Goal', initiative: 'Initiative', workstream: 'Workstream', milestone: 'Milestone', task: 'Task' };
  var ORDER = ['goal', 'initiative', 'workstream', 'milestone', 'task'];

  function urlFor(kind, id, initiativeId) {
    var l = links();
    if (!l || !id) return '';
    if (kind === 'goal') return l.goal(id);
    if (kind === 'initiative') return l.initiative(id);
    if (kind === 'workstream') return l.workstream(id, { initiativeId: initiativeId });
    if (kind === 'milestone') return l.milestone(id);
    return l.task(id, { initiativeId: initiativeId });
  }

  /**
   * The levels this decision names: the packet's own, its initiative from
   * the queue row, and its goal from the Goals read when the packet has none.
   * ctx: { goalOf(initiativeId) → { goal, initiative } | undefined }
   */
  function levelsOf(f, ctx) {
    var raw = f.levels || {};
    var out = {};
    ORDER.forEach(function k(kind) { if (raw[kind] && raw[kind].id) out[kind] = { id: raw[kind].id, title: raw[kind].title || null }; });
    if (!out.initiative && f.initiative_id) out.initiative = { id: f.initiative_id, title: f.initiative_title || null };
    if (out.initiative && !out.initiative.title && f.initiative_title) out.initiative.title = f.initiative_title;
    var joined = out.initiative && ctx && ctx.goalOf ? ctx.goalOf(out.initiative.id) : undefined;
    if (!out.goal && joined && joined.goal) out.goal = { id: joined.goal.id, title: joined.goal.title, joined: true };
    if (joined && joined.initiative) out.progress = joined.initiative;
    // Known to have no goal: only when the Goals read lists the initiative as unlinked.
    out.noGoal = Boolean(!out.goal && joined && joined.goal === null);
    return out;
  }

  function crumbsHtml(f, ctx) {
    ctx = ctx || {};
    var lv = levelsOf(f, ctx);
    var named = ORDER.filter(function has(k) { return lv[k]; });
    // The initiative alone is already on the meta line: crumbs only when they say more.
    if (!named.length || (named.length === 1 && named[0] === 'initiative' && !lv.progress && !lv.noGoal)) return '';
    var initId = lv.initiative ? lv.initiative.id : null;
    var shown = ['goal', 'initiative', 'milestone'].filter(function c(k) { return lv[k] && lv[k].title; });
    var crumbs = shown.map(function crumb(k, i) {
      return (i ? '<span class="crumb-sep" aria-hidden="true">/</span>' : '') +
        '<button type="button" class="crumb" data-action="' + (k === 'goal' ? 'goal-open' : 'open') + '"' + (k === 'goal' ? ' data-id="' + esc(lv.goal.id) + '"' : ' data-url="' + esc(urlFor(k, lv[k].id, initId)) + '"') +
        ' title="' + LEVEL_NAME[k] + '">' + levelIcon(k) + esc(lv[k].title) + '</button>';
    }).join('');
    var more = named.length > shown.length || lv.progress || lv.noGoal;
    var open = Boolean(ctx.open);
    var toggle = more
      ? '<button type="button" class="crumb-more" data-action="ladder" data-id="' + esc(f.id) + '" aria-expanded="' + open + '" aria-controls="ladder-' + esc(f.id) + '">' + (open ? 'Hide levels' : 'All levels') + '</button>'
      : '';
    if (!crumbs && !toggle) return '';
    return '<nav class="crumbs" aria-label="Where this sits">' + (crumbs || '<span class="crumb is-quiet">Where this sits</span>') + toggle + '</nav>' +
      (open && more ? ladderHtml(lv, initId, ctx) : '');
  }

  function ladderHtml(lv, initId, ctx) {
    var rungs = [];
    if (lv.goal) {
      rungs.push(rung('goal', lv.goal, initId, lv.goal.joined ? 'Goal · from the initiative' : 'Goal'));
    } else if (lv.noGoal && lv.initiative) {
      rungs.push('<li class="rung is-missing"><span class="rung-i" aria-hidden="true">' + levelIcon('goal', 14) + '</span><span class="rung-n"><b>No goal yet</b><span>Its work counts toward nothing until it is linked.</span></span>' +
        '<span class="rung-r">' + (ctx.linkStatus ? '<span class="gl-linked" role="status">' + esc(ctx.linkStatus === 'sent' ? 'Sent to the chat' : ctx.linkStatus === 'copied' ? 'Copied' : 'Type it in the chat') + '</span>'
          : '<button type="button" class="pn-btn" data-action="goal-link" data-id="' + esc(lv.initiative.id) + '" data-title="' + esc(lv.initiative.title || '') + '">Link</button>') + '</span></li>');
    }
    ['initiative', 'workstream', 'milestone', 'task'].forEach(function each(k) {
      if (!lv[k]) return;
      var right = '';
      if (k === 'initiative' && lv.progress && lv.progress.milestones_total) {
        var p = lv.progress;
        right = '<span class="gl-bar" aria-hidden="true"><i style="width:' + Math.round(p.milestones_done / p.milestones_total * 100) + '%"></i></span><span class="rung-c">' + p.milestones_done + '/' + p.milestones_total + '<span class="sr-only"> milestones done</span></span>';
      }
      rungs.push(rung(k, lv[k], initId, LEVEL_NAME[k], right));
    });
    var here = rungs.length - 1;
    return '<ol class="ladder" id="ladder-' + esc((lv.initiative && lv.initiative.id) || 'x') + '" aria-label="All levels">' + rungs.map(function mark(r, i) { return i === here ? r.replace('<li class="rung', '<li aria-current="true" class="rung is-here') : r; }).join('') + '</ol>';
  }
  function rung(kind, level, initId, sub, right) {
    var url = urlFor(kind, level.id, initId);
    return '<li class="rung"><span class="rung-i" aria-hidden="true">' + levelIcon(kind, 14) + '</span>' +
      '<span class="rung-n"><b>' + (level.title ? esc(level.title) : '<span class="rung-q">Not named in this view</span>') + '</b><span>' + esc(sub) + '</span></span>' +
      '<span class="rung-r">' + (right || '') + (url ? '<button type="button" class="rung-open" data-action="open" data-url="' + esc(url) + '" aria-label="Open this ' + LEVEL_NAME[kind].toLowerCase() + ' in OrgX">↗</button>' : '') + '</span></li>';
  }

  var OUT_ICON = {
    yes: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6-6.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4 2.5 7.5 6 11M3 7.5h6.5a4 4 0 0 1 0 8H8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    idle: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    not: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.8 13.5 4v4c0 3.2-2.3 5.4-5.5 6.4C4.8 13.4 2.5 11.2 2.5 8V4Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5.8 10.2 10.2 5.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  /**
   * Every way it can go, from the packet. Drawn as a list only when the
   * packet says more than what approving does; that alone stays a fact row.
   * opts: { approved (text), inline (text → html) }
   */
  function outsHtml(f, opts) {
    opts = opts || {};
    var rows = [
      ['yes', 'If you go ahead', opts.approved || f.consequence_if_approved],
      ['back', 'If you send back', f.consequence_if_rejected],
      ['idle', 'If nobody decides', f.consequence_if_deferred],
      ['not', 'Doesn’t cover', f.consequence_not_covered],
    ].filter(function has(r) { return r[2]; });
    if (!rows.length || (rows.length === 1 && rows[0][0] === 'yes')) return '';
    var inline = opts.inline || esc;
    return '<ul class="outs" role="list" aria-label="What happens">' + rows.map(function row(r) {
      return '<li data-k="' + r[0] + '"><span class="outs-i" aria-hidden="true">' + OUT_ICON[r[0]] + '</span><span class="outs-k">' + r[1] + '</span><span class="outs-v">' + inline(r[2]) + '</span></li>';
    }).join('') + '</ul>';
  }
  /** True when outsHtml draws the list, so the packet drops its single "If approved" row. */
  function hasOuts(f) {
    return Boolean(f.consequence_if_rejected || f.consequence_if_deferred || f.consequence_not_covered);
  }

  /** What one piece of evidence recorded beyond its title, as key and value. */
  function evidenceRawHtml(e) {
    // The evidence body stays in OrgX (the snapshot never carries it); these are what the packet recorded about it.
    var kv = [];
    if (e.pointer) kv.push(['Points to', e.pointer]);
    if (typeof e.confidence === 'number') kv.push(['Confidence', Math.round(e.confidence * 100) + '%']);
    if (e.freshness) {
      var T = global.OrgXTime;
      kv.push(['As of', T && T.relative && isFinite(Date.parse(e.freshness)) ? T.relative(e.freshness) : e.freshness]);
    }
    if (!kv.length) return '';
    return '<dl class="ev-kv">' + kv.map(function p(x) { return '<div><dt>' + esc(x[0]) + '</dt><dd' + (x[0] === 'Points to' ? ' class="ev-raw"' : '') + '>' + esc(x[1]) + '</dd></div>'; }).join('') + '</dl>';
  }
  function hasRaw(list) {
    return (list || []).some(function r(e) { return e.pointer || typeof e.confidence === 'number' || e.freshness; });
  }

  /** The bar under a selection of plain approvals. Nothing is sent from here without the undo window. */
  function bulkBarHtml(n, opts) {
    opts = opts || {};
    if (opts.note) {
      return '<div class="bulk is-note" role="region" aria-label="Send back ' + n + '"><label for="bulk-note" class="bulk-l">What should change? Goes to each of the ' + n + '.</label>' +
        '<textarea id="bulk-note" data-action="bulk-note" maxlength="2000" placeholder="Tell the agents what to fix or do instead.">' + esc(opts.text || '') + '</textarea>' +
        '<div class="bulk-row"><button type="button" class="pn-btn ghost" data-action="bulk-note-cancel">Cancel</button>' +
        '<button type="button" class="pn-btn" data-action="bulk-reject"' + (String(opts.text || '').trim() ? '' : ' disabled') + '>Send ' + n + ' back</button></div></div>';
    }
    return '<div class="bulk" role="region" aria-label="Selected decisions"><span class="bulk-n"><b>' + n + '</b> selected</span>' +
      '<button type="button" class="pn-btn ghost" data-action="bulk-clear">Clear</button>' +
      '<button type="button" class="pn-btn" data-action="bulk-sendback">Send back</button>' +
      '<button type="button" class="pn-btn is-primary" data-action="bulk-approve">Approve ' + n + '</button></div>';
  }

  /** The undo window: what will be sent, a way to stop it, and how long is left. */
  function toastHtml(pending) {
    if (!pending) return '';
    var n = pending.ids.length;
    var verb = pending.action === 'approve' ? 'Approving' : 'Sending back';
    var left = Math.max(0, pending.until - Date.now());
    if (pending.sending) return '<div class="pn-toast" role="status" aria-live="polite"><span class="pn-toast-t">Sending ' + n + (n === 1 ? ' decision' : ' decisions') + ' to OrgX…</span></div>';
    return '<div class="pn-toast" role="status" aria-live="polite"><span class="pn-toast-t">' + verb + ' ' + n + (n === 1 ? ' decision' : ' decisions') + '. Nothing is sent until the bar runs out.</span>' +
      '<button type="button" class="pn-toast-b" data-action="bulk-undo">Undo</button>' +
      '<span class="pn-toast-m" aria-hidden="true" style="--pn-undo:' + left + 'ms;--pn-undo-start:' + Math.min(1, left / (pending.window || 5000)).toFixed(3) + '"></span></div>';
  }

  global.OrgXPanelPacket = {
    levelsOf: levelsOf, crumbsHtml: crumbsHtml, outsHtml: outsHtml, hasOuts: hasOuts,
    evidenceRawHtml: evidenceRawHtml, hasRaw: hasRaw, bulkBarHtml: bulkBarHtml, toastHtml: toastHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
