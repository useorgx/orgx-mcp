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

  var TABS = [['needs', 'Needs you'], ['work', 'In progress'], ['done', 'Done']];

  /**
   * opts: { active, counts: { needs, work, done }, tones: { needs, work, done }, changed: { [tab]: true } }.
   * A count of null renders no badge (not loaded yet), never a fake zero.
   */
  function tabsHtml(opts) {
    var counts = opts.counts || {};
    var tones = opts.tones || {};
    return '<div class="pn-tabs" role="tablist" aria-label="Panel views">' + TABS.map(function tab(t) {
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

  /**
   * phase: 'loading' | 'failed' | 'ready'. work: { status, items, total } or null.
   * launch: html for the empty state (the controller passes the prompts).
   */
  function workHtml(work, phase, launch) {
    var head = '<div class="pn-view-head"><h2 class="pn-view-h">In progress</h2>' +
      '<button type="button" class="text-btn" data-action="open" data-url="' + esc(liveUrl()) + '">Live work in OrgX ↗</button></div>';
    if (phase === 'loading' && !work) {
      return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work" aria-busy="true">' + head + skeletonRows(4) + '<p class="sr-only">Loading what your agents are running.</p></section>';
    }
    if (!work || work.status === 'unavailable' || phase === 'failed') {
      return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work">' + head +
        '<div class="notice" data-tone="amber" role="status"><p>Agent status could not be read right now. Nothing is hidden: open live work in OrgX, or try again.</p>' +
        '<button type="button" class="text-btn" data-action="work-retry">Try again</button></div></section>';
    }
    if (!work.items.length) {
      return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work">' + head +
        '<p class="pn-empty-t">Nothing is running right now.</p><p class="sub">Agents pick up work you start or delegate; it shows here with its state.</p>' + (launch || '') + '</section>';
    }
    var groups = WORK_GROUPS.map(function group(g) {
      var items = work.items.filter(function inGroup(i) { return i.state === g[0]; });
      if (!items.length) return '';
      return '<h3 class="pn-group">' + g[1] + '<span>' + items.length + '</span></h3><ul class="pn-rows" role="list">' + items.map(function row(i) {
        return '<li><button type="button" class="pn-row" data-action="open" data-url="' + esc(i.url) + '">' +
          '<span class="pn-row-av">' + avatar(i.agent, 'row') + '</span>' +
          '<span class="pn-row-main"><span class="pn-row-t">' + esc(i.title) + '</span><span class="pn-row-m">' + esc(i.agent) + '</span></span>' +
          '<span class="pn-row-s"><ox-state-chip state="' + WORK_CHIP[i.state] + '"></ox-state-chip></span></button></li>';
      }).join('') + '</ul>';
    }).join('');
    var more = work.total > work.items.length
      ? '<p class="sub">Showing ' + work.items.length + ' of ' + work.total + '. <button type="button" class="text-btn" data-action="open" data-url="' + esc(liveUrl()) + '">See all in OrgX ↗</button></p>' : '';
    return '<section class="pn-work" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-work"' + (phase === 'loading' ? ' aria-busy="true"' : '') + '>' + head + groups + more + (launch || '') + '</section>';
  }

  /**
   * One settled decision from this panel session, as a receipt. Only what is
   * known is shown: recorded by you (with time), and whether OrgX confirmed
   * the outcome. The rest of the story lives behind "Open receipt in OrgX".
   */
  function receiptHtml(entry, open) {
    var confirmed = entry.phase === 'confirmed' || entry.phase === 'rejected';
    var elsewhere = entry.phase === 'elsewhere';
    var rows =
      '<ox-receipt-row status="met" label="' + esc(elsewhere ? 'Settled in OrgX' : entry.verb + ' by you') + '" value="' + esc(entry.at || '') + '"></ox-receipt-row>' +
      '<ox-receipt-row status="' + (confirmed || elsewhere ? 'met' : 'unverified') + '" label="' + esc(confirmed ? 'Confirmed by OrgX' : elsewhere ? 'Outcome recorded in OrgX' : 'Not confirmed yet') + '" detail="' + esc(entry.detail || '') + '"></ox-receipt-row>';
    return '<li class="pn-rc' + (open ? ' is-open' : '') + '">' +
      '<button type="button" class="pn-rc-head" data-action="receipt" data-id="' + esc(entry.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="rc-' + esc(entry.id) + '">' +
      '<span class="pn-rc-ic" data-tone="' + (entry.action === 'reject' ? 'mute' : 'teal') + '" aria-hidden="true">' + (entry.action === 'reject' ? '↩' : '✓') + '</span>' +
      '<span class="pn-row-main"><span class="pn-row-t">' + esc(entry.title) + '</span><span class="pn-row-m">' + esc((elsewhere ? 'Settled in OrgX' : entry.verb + ' by you') + (entry.at ? ' · ' + entry.at : '')) + '</span></span>' +
      '<span class="pn-rc-chev" aria-hidden="true">›</span></button>' +
      '<div class="pn-rc-body" id="rc-' + esc(entry.id) + '"' + (open ? '' : ' hidden') + '><div role="list">' + rows + '</div>' +
      '<button type="button" class="text-btn" data-action="open" data-url="' + esc(entry.url) + '">Open receipt in OrgX ↗</button></div></li>';
  }

  /** opts: { session, openId, proofHtml, launch } */
  function doneHtml(opts) {
    var session = opts.session || [];
    var l = links();
    var history = l ? l.decisions({ status: 'all' }) : 'https://useorgx.com/decisions?status=all';
    var ledger = l && l.workLedger ? l.workLedger() : 'https://useorgx.com/work-ledger';
    var approved = session.filter(function a(e) { return e.action === 'approve' && e.phase !== 'elsewhere'; }).length;
    var back = session.filter(function r(e) { return e.action === 'reject' && e.phase !== 'elsewhere'; }).length;
    var summary = session.length
      ? '<p class="pn-done-sum">You settled ' + session.length + (session.length === 1 ? ' decision' : ' decisions') + ' since opening the panel.</p>' +
        '<p class="pn-nums"><span><b>' + approved + '</b> approved</span><span><b>' + back + '</b> sent back</span></p>'
      : '<p class="pn-done-sum">Decisions you settle here collect as receipts.</p>';
    var list = session.length ? '<ul class="pn-rcs" role="list">' + session.map(function each(e) { return receiptHtml(e, e.id === opts.openId); }).join('') + '</ul>' : '';
    return '<section class="pn-done" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-done">' +
      '<div class="pn-view-head"><h2 class="pn-view-h">Done</h2></div>' + summary + list + (opts.proofHtml || '') +
      '<div class="pn-history"><span>Everything earlier lives in OrgX.</span>' +
      '<button type="button" class="text-btn" data-action="open" data-url="' + esc(history) + '">Decision history ↗</button>' +
      '<button type="button" class="text-btn" data-action="open" data-url="' + esc(ledger) + '">Work ledger ↗</button></div>' +
      (opts.launch || '') + '</section>';
  }

  global.OrgXPanelViews = { tabsHtml: tabsHtml, workHtml: workHtml, doneHtml: doneHtml, receiptHtml: receiptHtml, avatar: avatar };
})(typeof window !== 'undefined' ? window : globalThis);
