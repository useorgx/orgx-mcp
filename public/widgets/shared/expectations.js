/**
 * "Done means": the bar a person agrees to before work starts, shared by the
 * scaffold widget, the decisions widget and the OrgX panel.
 *
 * OrgX drafts the bar from named sources and every check says where it came
 * from, so a person can trust it or drop it: your rule, the kind of work,
 * learned from your past calls, suggested in chat, or drafted to fill a gap.
 * The server normalizes the same shapes (src/expectations.ts); this reads
 * them again because the decisions widget renders the app's payload as is.
 *
 *   OrgXExpectations.normalize(raw)          -> set | null
 *   OrgXExpectations.fromDecision(decision)  -> set | null (expectation_agreement only)
 *   OrgXExpectations.isAgreement(decision)   -> boolean
 *   OrgXExpectations.describe(set)           -> "7 checks across 3 owners: …"
 *   OrgXExpectations.groups(set, opts)       -> [{ key, label, checks }]
 *   OrgXExpectations.listHtml(set, opts)     -> grouped checklist
 *   OrgXExpectations.chipHtml(source, label) -> one source chip
 *   OrgXExpectations.editSentence(set, title)-> the chat sentence to change the bar
 */
(function attachExpectations(global) {
  'use strict';
  if (global.OrgXExpectations) return;

  var KIND = 'expectation_agreement';
  var PER_GROUP = 5;
  var SOURCES = ['rule', 'artifact_type', 'learned', 'suggested', 'drafted'];
  var SOURCE_ALIASES = {
    rule: 'rule', rules: 'rule', policy: 'rule', workspace_rule: 'rule', org_policy: 'rule',
    artifact_type: 'artifact_type', kind_of_work: 'artifact_type', work_type: 'artifact_type', layer_stack: 'artifact_type', type: 'artifact_type',
    learned: 'learned', promoted: 'learned', promotion: 'learned', outcome_call: 'learned',
    suggested: 'suggested', suggestion: 'suggested', chat: 'suggested', client: 'suggested',
    drafted: 'drafted', drafter: 'drafted', draft: 'drafted', generated: 'drafted',
  };
  /** The chip's words, as the person reads them. */
  var CHIP = { rule: 'your rule', artifact_type: 'kind of work', learned: 'learned', suggested: 'suggested', drafted: 'drafted' };
  var CHIP_TITLE = {
    rule: 'From your workspace rules. Always required.',
    artifact_type: 'What this kind of work needs to count as done.',
    learned: 'Learned from your calls on past work.',
    suggested: 'Suggested in chat. A suggestion, not a rule.',
    drafted: 'Drafted by OrgX where nothing else covered this work.',
  };
  var SOURCE_PHRASE = {
    rule: ['from your rules', 'from your rules'],
    artifact_type: ['from the kind of work', 'from the kind of work'],
    learned: ['learned from your past calls', 'learned from your past calls'],
    suggested: ['suggested in chat', 'suggested in chat'],
    drafted: ['drafted to fill a gap', 'drafted to fill gaps'],
  };
  var VERIFY = { command: 'runs a command', http: 'checks a URL', artifact: 'checks the output', manual: 'a person checks' };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function rec(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
  function idStr(v) { return typeof v === 'number' && isFinite(v) ? String(v) : str(v); }

  function sourceOf(v) {
    var key = str(v);
    return key ? SOURCE_ALIASES[key.toLowerCase().replace(/[\s-]+/g, '_')] || null : null;
  }
  function verifyOf(v) {
    var r = rec(v);
    var raw = str(r ? (r.kind || r.type) : v);
    raw = raw ? raw.toLowerCase() : '';
    if (raw === 'command' || raw === 'cmd' || raw === 'test' || raw === 'tests') return 'command';
    if (raw === 'http' || raw === 'url' || raw === 'probe') return 'http';
    if (raw === 'artifact' || raw === 'file' || raw === 'document') return 'artifact';
    return 'manual';
  }
  function statusOf(v) {
    var raw = (str(v) || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (raw === 'agreed' || raw === 'approved' || raw === 'accepted') return 'agreed';
    if (raw === 'sent_back' || raw === 'rejected' || raw === 'returned' || raw === 'declined') return 'sent_back';
    if (raw === 'superseded' || raw === 'replaced') return 'superseded';
    return 'drafted';
  }

  function normalizeCheck(raw) {
    var r = rec(raw);
    if (!r || r.enabled === false) return null;
    var statement = str(r.statement) || str(r.text) || str(r.check) || str(r.description) || str(r.title);
    var source = sourceOf(r.source || r.source_kind || r.origin);
    if (!statement || !source) return null;
    var from = rec(r.learned_from);
    var scope = str(r.scope);
    return {
      id: idStr(r.id),
      scope: scope === 'workstream' || scope === 'task' ? scope : 'initiative',
      scope_id: idStr(r.scope_id || r.scopeId),
      statement: statement.replace(/\s+/g, ' '),
      verify: verifyOf(r.verify || r.verify_kind || r.verification),
      required: typeof r.required === 'boolean' ? r.required : source === 'rule',
      source: source,
      source_ref: idStr(r.source_ref || r.sourceRef || (from && (from.id || from.receipt_id))),
      source_label: str(r.source_label) || str(r.source_name) || (from && (str(from.label) || str(from.title))) || null,
      owner_agent: str(r.owner_agent) || str(r.ownerAgent) || str(r.owner) || null,
      new_since_last: r.new_since_last === true || r.is_new === true || r.new === true,
    };
  }

  /** The set wherever it arrived: {checks}, a bare array, or {expectations} one level down. */
  function normalize(raw) {
    if (raw == null) return null;
    var r = Array.isArray(raw) ? { checks: raw } : rec(raw);
    if (!r) return null;
    if (!Array.isArray(r.checks)) {
      var nested = rec(r.expectations) || rec(r.expectation_set);
      if (nested) return normalize(nested);
      if (Array.isArray(r.expectations)) return normalize(Object.assign({}, r, { checks: r.expectations, expectations: null }));
      return null;
    }
    var checks = r.checks.map(normalizeCheck).filter(Boolean);
    if (!checks.length) return null;
    return {
      id: idStr(r.id || r.set_id),
      status: statusOf(r.status),
      version: idStr(r.version),
      initiative_id: str(r.initiative_id),
      decision_id: str(r.decision_id) || (rec(r.decision) && str(r.decision.id)) || null,
      agreed_at: str(r.agreed_at),
      agreed_by: str(r.agreed_by),
      checks: checks,
      omitted_count: typeof r.omitted_count === 'number' && r.omitted_count > 0 ? Math.floor(r.omitted_count) : 0,
      origin: r.origin === 'suggested' ? 'suggested' : 'app',
    };
  }

  function isAgreement(d) {
    var r = rec(d);
    if (!r) return false;
    var ctx = rec(r.context) || {};
    var packet = rec(r.review_packet) || {};
    return [r.decision_kind, r.decision_type, r.kind, r.type, r.category, ctx.decision_kind, ctx.kind, packet.kind]
      .some(function is(v) { return (str(v) || '').toLowerCase() === KIND; });
  }

  function fromDecision(d) {
    var r = rec(d);
    if (!r) return null;
    // The panel's focus already carries the normalized set (the server only
    // attaches one to an expectation_agreement decision).
    if (!isAgreement(r)) {
      var carried = rec(r.expectations) && Array.isArray(r.expectations.checks) ? normalize(r.expectations) : null;
      if (carried && !carried.decision_id) carried.decision_id = str(r.id);
      return carried;
    }
    var places = [r, rec(r.context), rec(r.review_packet), rec(r.metadata)];
    for (var i = 0; i < places.length; i += 1) {
      var p = places[i];
      if (!p) continue;
      var set = normalize(p.expectations) || normalize(p.expectation_set);
      if (set) {
        if (!set.decision_id) set.decision_id = str(r.id);
        return set;
      }
    }
    return null;
  }

  function total(set) { return set.checks.length + (set.omitted_count || 0); }

  /** "7 checks across 3 owners: 4 from your rules, 2 learned from your past calls, 1 new since last time." */
  function describe(set) {
    if (!set) return '';
    var n = total(set);
    var owners = {};
    var counts = {};
    var fresh = 0;
    set.checks.forEach(function each(c) {
      if (c.owner_agent) owners[c.owner_agent] = true;
      counts[c.source] = (counts[c.source] || 0) + 1;
      if (c.new_since_last) fresh += 1;
    });
    var parts = SOURCES.filter(function has(s) { return counts[s]; }).map(function phrase(s) {
      return counts[s] + ' ' + SOURCE_PHRASE[s][counts[s] === 1 ? 0 : 1];
    });
    if (fresh) parts.push(fresh + ' new since last time');
    var nOwners = Object.keys(owners).length;
    return n + ' check' + (n === 1 ? '' : 's') + (nOwners > 1 ? ' across ' + nOwners + ' owners' : '') + (parts.length ? ': ' + parts.join(', ') : '') + '.';
  }

  function ownerOf(id) {
    if (!id) return { key: '', name: 'Across the initiative', role: '' };
    var identity = global.OrgXAgentIdentity;
    var who = identity && identity.profile ? identity.profile(id, '', '') : null;
    if (who) return { key: who.key, name: who.name, role: who.role };
    var name = String(id).replace(/[-_]+agent$/i, '').replace(/[-_]+/g, ' ');
    return { key: id, name: name.charAt(0).toUpperCase() + name.slice(1), role: '' };
  }

  /**
   * Groups to render. by: 'owner' (default): new since last time first, then
   * one group per owner. by: 'workstream': opts.workstreamOf(check) -> { key, label }
   * names the group; checks it cannot place go under "Across the initiative".
   */
  function groups(set, opts) {
    opts = opts || {};
    var out = [];
    var byKey = {};
    function push(key, label, sub, check) {
      if (!byKey[key]) { byKey[key] = { key: key, label: label, sub: sub || '', checks: [] }; out.push(byKey[key]); }
      byKey[key].checks.push(check);
    }
    var rest = set.checks;
    if (opts.by !== 'workstream') {
      var fresh = set.checks.filter(function n(c) { return c.new_since_last; });
      if (fresh.length) fresh.forEach(function f(c) { push('new', 'New since last time', '', c); });
      rest = set.checks.filter(function o(c) { return !c.new_since_last; });
      rest.forEach(function o(c) {
        var who = ownerOf(c.owner_agent);
        push('owner:' + (c.owner_agent || ''), who.name, who.role, c);
      });
    } else {
      rest.forEach(function w(c) {
        var ws = opts.workstreamOf ? opts.workstreamOf(c) : null;
        if (ws) push('ws:' + ws.key, ws.label, ws.sub || '', c);
        else push('ws:', 'Across the initiative', '', c);
      });
      // The initiative-wide group reads last: it is what every workstream shares.
      out.sort(function last(a, b) { return (a.key === 'ws:') - (b.key === 'ws:'); });
    }
    return out;
  }

  function chipHtml(source, label) {
    if (!CHIP[source]) return '';
    var text = CHIP[source] + (label ? ' · ' + label : '');
    return '<span class="xp-src" data-src="' + source + '" title="' + esc(CHIP_TITLE[source]) + '">' + esc(text) + '</span>';
  }

  function rowHtml(c, newGroup) {
    var meta = [VERIFY[c.verify]];
    if (c.required && c.source !== 'rule') meta.push('required');
    if (c.new_since_last && !newGroup) meta.unshift('new');
    return '<li class="xp-c" data-src="' + c.source + '"><span class="xp-ct">' + esc(c.statement) + '</span>' +
      '<span class="xp-cm"><span class="xp-vk">' + esc(meta.join(' · ')) + '</span>' + chipHtml(c.source, c.source === 'learned' ? c.source_label : '') + '</span></li>';
  }

  /**
   * The grouped checklist. opts: { by, workstreamOf, perGroup, idPrefix, heading }
   * Each group shows perGroup checks (5) and folds the rest behind "N more".
   */
  function listHtml(set, opts) {
    if (!set) return '';
    opts = opts || {};
    var per = opts.perGroup || PER_GROUP;
    var html = groups(set, opts).map(function g(group) {
      var isNew = group.key === 'new';
      var row = function r(c) { return rowHtml(c, isNew); };
      var shown = group.checks.slice(0, per).map(row).join('');
      var more = group.checks.slice(per);
      return '<li class="xp-g" data-group="' + esc(group.key) + '"' + (group.key === 'new' ? ' data-new' : '') + '>' +
        '<p class="xp-gh"><span class="xp-gn">' + esc(group.label) + '</span>' + (group.sub ? '<span class="xp-gs">' + esc(group.sub) + '</span>' : '') +
        '<span class="xp-gc">' + group.checks.length + '</span></p>' +
        '<ul class="xp-cs" role="list">' + shown + '</ul>' +
        (more.length ? '<details class="xp-more"><summary>' + more.length + ' more</summary><ul class="xp-cs" role="list">' + more.map(row).join('') + '</ul></details>' : '') +
        '</li>';
    }).join('');
    var omitted = set.omitted_count ? '<p class="xp-omit">' + set.omitted_count + ' more in OrgX</p>' : '';
    return '<ul class="xp-list" role="list"' + (opts.idPrefix ? ' id="' + esc(opts.idPrefix) + '-list"' : '') + '>' + html + '</ul>' + omitted;
  }

  /** The sentence that takes the bar into chat to change it before agreeing. */
  function editSentence(set, title) {
    var name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return 'In OrgX, change what done means' + (name ? ' for “' + name + '”' : '') +
      ' before I agree: show me the ' + (set ? total(set) : '') + ' checks by owner and ask me what to add, drop or reword.';
  }

  /** "Oct 8" from an ISO date; '' when it cannot be read. */
  function shortDate(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (_) { return ''; }
  }

  global.OrgXExpectations = {
    KIND: KIND,
    SOURCES: SOURCES,
    CHIP: CHIP,
    VERIFY: VERIFY,
    normalize: normalize,
    normalizeCheck: normalizeCheck,
    isAgreement: isAgreement,
    fromDecision: fromDecision,
    describe: describe,
    groups: groups,
    listHtml: listHtml,
    chipHtml: chipHtml,
    editSentence: editSentence,
    shortDate: shortDate,
    sourceOf: sourceOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
