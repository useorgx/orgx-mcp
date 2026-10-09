/**
 * OrgX panel: Work receipts. The work agents did, as the Work Ledger records
 * it, with what "done" meant and whether each part was shown to be met.
 *
 * The verdicts are the ledger's, never the panel's: a criterion with no
 * evidence either way says so ("No evidence"), and the ledger's own list of
 * what is uncertain is shown as written. From a receipt the person can take
 * the work into ChatGPT to iterate on it, or open the ledger.
 *
 *   OrgXPanelReceipts.listHtml(receipts, opts)  -> rows for Done (Work)
 *   OrgXPanelReceipts.detailHtml(detail, row)   -> the receipt in the detail pane
 *   OrgXPanelReceipts.behindHtml(receipts)      -> "The work behind this" under a decision
 *   OrgXPanelReceipts.iterateSentence(row)      -> the chat sentence to iterate on it
 *   OrgXPanelReceipts.prOf(text)                -> the PR number a decision is about, if any
 */
(function attachPanelReceipts(global) {
  'use strict';
  if (global.OrgXPanelReceipts) return;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ago(iso) { var t = global.OrgXTime; return iso && t && t.relative ? t.relative(iso) : ''; }
  function links() { return global.OrgXLinks || null; }

  function rec(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function normalizeRow(value) {
    var row = rec(value), claims = rec(row.producer_claims), assessment = rec(row.receipt_assessment);
    var judgment = rec(row.human_judgment), counts = rec(row.criteria);
    var hasClaims = Boolean(row.producer_claims);
    var documentJudgment = judgment.scope === 'receipt_document';
    var sameDocument = documentJudgment && typeof judgment.reviewed_receipt_id === 'string' && judgment.reviewed_receipt_id === row.receipt_id &&
      (judgment.reviewed_receipt_revision || null) === (row.receipt_review_revision || null);
    var humanOutcome = sameDocument ? judgment.outcome_status : null;
    if (!humanOutcome && !documentJudgment && assessment.acceptance_status === 'human_reviewed') humanOutcome = assessment.outcome_status;
    return Object.assign({}, row, {
      id: row.external_receipt_id || row.externalId || row.receipt_id || row.id,
      outcome: humanOutcome || claims.outcome_status || row.outcome || null,
      outcome_source: humanOutcome ? 'human' : hasClaims ? 'producer' : row.outcome_source || null,
      verification: hasClaims ? (assessment.verification_status === 'producer_reported' ? null : assessment.verification_status || null) : row.verification || null,
      producer_verification: claims.verification_status || null,
      accepted: hasClaims ? (assessment.acceptance_status === 'accepted' ? 'accepted' : assessment.acceptance_status === 'rejected' ? 'rejected' : null) : row.accepted || null,
      criteria: { met: Number(counts.met) || 0, unmet: Number(counts.unmet) || 0, unknown: Number(counts.unknown) || 0 },
      actor: row.actor || null, at: row.at || null, prs: row.prs || [],
    });
  }
  function normalizeList(data, query) {
    if (data && data.receipts) return data.receipts;
    if (data && data.status && Array.isArray(data.items)) return data;
    if (!data || data.ok === false || !Array.isArray(data.results)) return { status: 'unavailable', query: query || '', total: 0, items: [], reason: null };
    return { status: 'ok', query: query || '', total: Number(data.total) || data.results.length, items: data.results.map(normalizeRow), reason: null };
  }
  function normalizeDetail(data, id, fallbackRow) {
    if (data && data.receipt && data.receipt.status) return data.receipt;
    if (data && data.status && data.id) return data;
    if (!data || data.ok === false || !data.receipt_id) return { status: 'unavailable', id: id, row: fallbackRow || null, reason: null, criteria: [], artifacts: [], uncertain: [] };
    var criteria = Array.isArray(data.criteria) ? data.criteria : [];
    var row = normalizeRow(Object.assign({}, fallbackRow || {}, data, { criteria: criteria.reduce(function count(all, c) { all[c.status === 'met' ? 'met' : c.status === 'unmet' ? 'unmet' : 'unknown'] += 1; return all; }, { met: 0, unmet: 0, unknown: 0 }) }));
    return { status: 'ok', id: id, row: row,
      criteria: criteria.map(function criterion(c) { return Object.assign({}, c, { status: ['met', 'unmet'].indexOf(c.status) === -1 ? 'unknown' : c.status }); }),
      artifacts: (Array.isArray(data.evidence) ? data.evidence : []).map(function evidence(e) { return { kind: e.kind || 'evidence', name: e.summary || e.id || 'Evidence', url: e.uri || null }; }),
      criteria_total: Math.max(criteria.length, Number(data.criteria_total) || 0),
      evidence_total: Math.max(Array.isArray(data.evidence) ? data.evidence.length : 0, Number(data.evidence_total) || 0),
      uncertain: Array.isArray(data.uncertain) ? data.uncertain : [],
      objective: typeof data.objective === 'string' ? data.objective : null,
      outcome_summary: typeof data.outcome_summary === 'string' ? data.outcome_summary : null,
      producer_reported: Boolean(data.producer_claims),
      reported_bar: data.reported_bar && data.reported_bar.basis === 'producer_reported' ? data.reported_bar : null,
    };
  }

  var OUTCOME = {
    succeeded: ['Done', 'ok'],
    partially_succeeded: ['Partly done', 'warn'],
    failed: ['Not done', 'bad'],
    blocked: ['Blocked', 'warn'],
  };
  function outcomeOf(row) {
    var o = OUTCOME[String(row.outcome || '').toLowerCase()];
    if (o && row.outcome_source === 'producer') return ['Agent reports ' + o[0].toLowerCase(), 'mute'];
    return o || [row.outcome ? String(row.outcome).replace(/_/g, ' ') : 'Recorded', 'mute'];
  }
  function verifiedOf(row) {
    var v = String(row.verification || '').toLowerCase();
    if (v === 'verified' || v === 'passed') return ['Checked after', 'ok'];
    if (v === 'failed') return ['Check failed', 'bad'];
    var reported = String(row.producer_verification || '').toLowerCase();
    if (reported === 'verified' || reported === 'passed') return ['Agent reports verified', 'mute'];
    if (reported === 'failed') return ['Agent reports failed check', 'warn'];
    return ['Not checked after', 'mute'];
  }
  function acceptedOf(row) {
    var a = String(row.accepted || '').toLowerCase();
    if (a === 'accepted') return ['Accepted', 'ok'];
    if (a === 'rejected') return ['Rejected', 'bad'];
    return null;
  }

  /** One pip per criterion, in the order met, unmet, no evidence. */
  function pips(c, max) {
    var total = c.met + c.unmet + c.unknown;
    if (!total) return '';
    var cap = max || 12;
    var parts = [];
    var push = function (n, s) { for (var i = 0; i < n && parts.length < cap; i += 1) parts.push('<i data-s="' + s + '"></i>'); };
    push(c.met, 'met'); push(c.unmet, 'unmet'); push(c.unknown, 'unknown');
    var label = c.met + ' of ' + total + ' checks met' + (c.unmet ? ', ' + c.unmet + ' not met' : '') + (c.unknown ? ', ' + c.unknown + ' with no evidence' : '');
    return '<span class="rc-pips" role="img" aria-label="' + esc(label) + '">' + parts.join('') + '</span>' +
      '<span class="rc-pn">' + c.met + '/' + total + '</span>';
  }

  function chip(pair) { return '<span class="rc-chip" data-tone="' + pair[1] + '">' + esc(pair[0]) + '</span>'; }

  /** receipts: { status, items, reason }, opts: { sel, page, pageSize } */
  function listHtml(receipts, opts) {
    opts = opts || {};
    var items = receipts.items || [];
    var size = opts.pageSize || 10;
    var shown = items.slice(0, Math.max(1, opts.page || 1) * size);
    var rows = shown.map(function row(r) {
      var on = opts.sel === r.id;
      var meta = [r.actor, ago(r.at), r.entity_title || r.area].filter(Boolean).join(' · ');
      return '<li><button type="button" class="rc-row" data-action="work-receipt" data-id="' + esc(r.id) + '" aria-pressed="' + on + '">' +
        '<span class="rc-main"><span class="rc-t">' + esc(r.summary) + '</span><span class="rc-m">' + esc(meta) + '</span></span>' +
        '<span class="rc-side">' + chip(outcomeOf(r)) + '<span class="rc-crit">' + pips(r.criteria, 8) + '</span></span></button></li>';
    }).join('');
    var more = items.length > shown.length
      ? '<button type="button" class="text-btn dn-more" data-action="done-more">Show ' + Math.min(size, items.length - shown.length) + ' more</button>'
      : '';
    return '<ul class="rc-rows" role="list">' + rows + '</ul>' + more;
  }

  /** The sentence that takes a receipt into the chat to keep working on it. */
  function iterateSentence(row) {
    var summary = String(row && row.summary || '').replace(/\s+/g, ' ').slice(0, 140);
    return 'Pull up OrgX Work Ledger receipt ' + row.id + (summary ? ' (“' + summary + '”)' : '') +
      ' and let’s iterate on it here: what was done, which checks are unmet or have no evidence, and what to change next.';
  }

  var MARK = {
    met: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>',
    unmet: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    unknown: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="5.5" stroke-dasharray="2.4 2.4"/></svg>',
  };
  var STATUS_WORD = { met: 'Met', unmet: 'Not met', unknown: 'No evidence' };

  /** Where a check came from, as a chip; a learned one names the call behind it when the ledger does. */
  function sourceChip(x) {
    if (x.basis === 'producer_reported' && x.source) {
      var reported = { rule: 'workspace rule', artifact_type: 'kind of work', learned: 'learned', suggested: 'suggested', drafted: 'drafted' };
      var source = reported[x.source] || String(x.source).replace(/_/g, ' ');
      return '<span class="xp-src" data-src="' + esc(x.source) + '" title="The agent reports this source. OrgX has not confirmed its provenance.">Agent reports: ' +
        esc(source + (x.source_label ? ' · ' + x.source_label : '')) + '</span>';
    }
    var X = global.OrgXExpectations;
    if (!X || !x.source) return '';
    var label = x.source === 'learned' && x.source_label ? 'from ' + x.source_label : '';
    return X.chipHtml(x.source, label);
  }
  /** "Judged against the bar you agreed on Oct 8", when the ledger names the agreement. */
  function barLine(detail) {
    var X = global.OrgXExpectations;
    var bar = detail && detail.bar;
    if (!bar || !bar.agreed_at) return '';
    var when = X && X.shortDate ? X.shortDate(bar.agreed_at) : '';
    return '<p class="rc-bar">Judged against the bar you agreed on' + (when ? ' ' + esc(when) : '') + '.</p>';
  }

  function reportedBarLine(detail) {
    var bar = detail && detail.reported_bar;
    if (!bar || bar.basis !== 'producer_reported') return '';
    if (!bar.agreed_at && !bar.agreed_by) return '<p class="rc-bar rc-reported-bar">The agent reports which expectations this receipt used. This report does not confirm a human agreement.</p>';
    var X = global.OrgXExpectations;
    var when = bar.agreed_at && X && X.shortDate ? X.shortDate(bar.agreed_at) : '';
    return '<p class="rc-bar rc-reported-bar">Agent reports an expectation agreement' + (when ? ' on ' + esc(when) : '') +
      '. OrgX has not confirmed this human agreement.</p>';
  }

  /**
   * detail: the receipt in full (or null while it loads); row: its list row,
   * so the pane can show the headline at once. opts: { workspaceId, phase }
   */
  function detailHtml(detail, row, opts) {
    opts = opts || {};
    var r = (detail && detail.row) || row;
    if (!r) return '';
    var close = '<button type="button" class="md-close" data-action="work-receipt" data-id="" aria-label="Close receipt">×</button>';
    var head = '<p class="md-kicker">Work receipt</p><h3 class="md-title">' + esc(r.summary) + '</h3>' +
      '<p class="rc-verdict">' + chip(outcomeOf(r)) + chip(verifiedOf(r)) + (acceptedOf(r) ? chip(acceptedOf(r)) : '') +
      '<span class="rc-by">' + esc([r.actor, ago(r.at)].filter(Boolean).join(' · ')) + '</span></p>';
    var body = '';
    if (!detail || opts.phase === 'loading') {
      body = '<div class="rc-loading" aria-busy="true"><span class="sk sk-line"></span><span class="sk sk-line sk-t2"></span><span class="sk sk-line sk-short"></span></div>';
    } else if (detail.status !== 'ok') {
      body = '<p class="rc-quiet">' + esc(detail.reason || 'This receipt could not be read right now.') + '</p>';
    } else {
      var crit = detail.criteria || [];
      if (detail.objective) body += '<section class="rc-sec"><h4 class="rc-h">Intended outcome</h4><p class="rc-p">' + esc(detail.objective) + '</p></section>';
      body += '<section class="rc-sec" aria-label="What done meant"><h4 class="rc-h">What done meant</h4>' + barLine(detail) + reportedBarLine(detail) +
        (detail.producer_reported ? '<p class="rc-quiet">The agent reports these check results and sources.</p>' : '') +
        (crit.length
          ? '<ul class="rc-crits" role="list">' + crit.map(function c(x) {
            var guess = typeof x.confidence === 'number' && x.confidence < 0.6;
            return '<li class="rc-c" data-s="' + x.status + '"><span class="rc-cm" aria-hidden="true">' + MARK[x.status] + '</span>' +
              '<span class="rc-ct">' + esc(x.text) + (x.source ? '<span class="rc-src">' + sourceChip(x) + '</span>' : '') + '</span><span class="rc-cs">' + STATUS_WORD[x.status] + (guess && x.status !== 'unknown' ? ' · a guess' : '') + '</span></li>';
          }).join('') + '</ul>'
          : '<p class="rc-quiet">No criteria were written down for this work, so nothing can be checked against them.</p>') +
        (detail.criteria_total > crit.length ? '<p class="rc-quiet">Showing ' + crit.length + ' of ' + esc(detail.criteria_total) + ' checks. Open the Work Ledger for the complete receipt.</p>' : '') + '</section>';
      if (detail.outcome_summary) body += '<section class="rc-sec"><h4 class="rc-h">' + (detail.producer_reported ? 'Agent-reported outcome' : 'What happened') + '</h4><p class="rc-p">' + esc(detail.outcome_summary) + '</p></section>';
      var arts = detail.artifacts || [];
      if (arts.length) {
        body += '<section class="rc-sec"><h4 class="rc-h">Evidence</h4><ul class="rc-arts" role="list">' + arts.slice(0, 8).map(function a(x) {
          var label = x.kind === 'pull_request' ? 'PR ' + x.name.replace(/^.*#/, '#') : x.name;
          return '<li>' + (x.url
            ? '<button type="button" class="rc-art" data-action="open" data-url="' + esc(x.url) + '">' + esc(label) + ' ↗</button>'
            : '<span class="rc-art is-plain">' + esc(label) + '</span>') + '<span class="rc-ak">' + esc(String(x.kind).replace(/_/g, ' ')) + '</span></li>';
        }).join('') + '</ul>' +
          (Math.max(arts.length, Number(detail.evidence_total) || 0) > Math.min(arts.length, 8) ? '<p class="rc-quiet">Showing ' + Math.min(arts.length, 8) + ' of ' + esc(Math.max(arts.length, Number(detail.evidence_total) || 0)) + ' evidence items. Open the Work Ledger for the complete receipt.</p>' : '') + '</section>';
      }
      var unsure = detail.uncertain || [];
      if (unsure.length) {
        body += '<section class="rc-sec rc-unsure"><h4 class="rc-h">Still uncertain</h4><ul role="list">' + unsure.map(function u(x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>';
      }
    }
    // The human in the loop: the person's call on the outcome. It overrides the
    // agent's own guess in the ledger and becomes the example OrgX learns from.
    if (detail && detail.status === 'ok') body += callHtml(r, opts.call);
    var l = links();
    var ledger = l && l.workLedger ? l.workLedger({ center: opts.workspaceId, range: '30d' }) : 'https://useorgx.com/work-ledger';
    var acts = '<div class="md-acts"><button type="button" class="pn-btn ghost" data-action="open" data-url="' + esc(ledger) + '">Work Ledger ↗</button>' +
      '<button type="button" class="pn-btn" data-action="receipt-iterate" data-id="' + esc(r.id) + '">Iterate in ChatGPT</button></div>';
    return '<div class="md-card rc-card" role="region" aria-label="Work receipt">' + close + head + body + acts + '</div>';
  }

  var CALLS = [['succeeded', 'Done'], ['partially_succeeded', 'Partly'], ['failed', 'Not done'], ['blocked', 'Blocked']];
  /** call: { status, phase: 'saving'|'saved'|'failed', reason } or undefined */
  function callHtml(r, call) {
    if (call && call.phase === 'unavailable') return '<section class="rc-sec rc-call" aria-label="Your call"><h4 class="rc-h">Your call</h4><p class="rc-cn">Review this receipt in the Work Ledger to record your call.</p></section>';
    var agentSays = outcomeOf(r)[0];
    var current = call && call.phase !== 'failed' ? call.status : null;
    var note = !call ? 'The agent says “' + agentSays + '”. Your call overrides it and teaches OrgX what done means here.'
      : call.phase === 'saving' ? 'Recording your call…'
        : call.phase === 'saved' ? 'Recorded in the Work Ledger. OrgX learns from your call.'
          : (call.reason || 'Your call could not be recorded. Try again.');
    return '<section class="rc-sec rc-call" aria-label="Your call"><h4 class="rc-h">Your call</h4>' +
      '<div class="seg rc-calls" role="group" aria-label="Was this done?">' + CALLS.map(function c(x) {
        return '<button type="button" class="seg-b" data-action="receipt-call" data-id="' + esc(r.id) + '" data-status="' + x[0] + '" aria-pressed="' + (current === x[0]) + '"' +
          (call && (call.phase === 'saving' || call.phase === 'saved') ? ' disabled' : '') + '>' + x[1] + '</button>';
      }).join('') + '</div><p class="rc-cn" role="status" data-phase="' + esc(call ? call.phase : 'idle') + '">' + esc(note) + '</p></section>';
  }

  /** Under a decision: the receipt of the work it would let through, if the ledger has one. */
  function behindHtml(receipts) {
    if (!receipts || receipts.status !== 'ok' || !receipts.items || !receipts.items.length) return '';
    var r = receipts.items[0];
    return '<div class="rc-behind" role="region" aria-label="The work behind this">' +
      '<p class="rc-bk">The work behind this</p>' +
      '<button type="button" class="rc-row is-behind" data-action="behind-open" data-id="' + esc(r.id) + '">' +
      '<span class="rc-main"><span class="rc-t">' + esc(r.summary) + '</span><span class="rc-m">' + esc([r.actor, ago(r.at)].filter(Boolean).join(' · ')) + '</span></span>' +
      '<span class="rc-side">' + chip(verifiedOf(r)) + '<span class="rc-crit">' + pips(r.criteria, 8) + '</span></span></button>' +
      (receipts.items.length > 1 ? '<p class="rc-bm">' + (receipts.items.length - 1) + ' more receipt' + (receipts.items.length === 2 ? '' : 's') + ' mention this.</p>' : '') + '</div>';
  }

  /** The pull request a decision is about: "PR #3236", "gh pr merge 3236" or a GitHub pull URL. */
  function prOf(text) {
    var s = String(text || '');
    var m = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/i.exec(s) || /\bgh pr (?:merge|review|checkout|view)\s+#?(\d+)/i.exec(s) || /\bPR\s*#(\d+)/i.exec(s);
    return m ? m[1] : null;
  }

  global.OrgXPanelReceipts = { normalizeList: normalizeList, normalizeDetail: normalizeDetail, listHtml: listHtml, detailHtml: detailHtml, behindHtml: behindHtml, iterateSentence: iterateSentence, prOf: prOf, pips: pips };
})(typeof window !== 'undefined' ? window : globalThis);
