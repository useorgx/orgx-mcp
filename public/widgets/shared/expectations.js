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
 *   OrgXExpectations.groups(set, opts)       -> [{ key, label, sub, agent, checks }]
 *   OrgXExpectations.barHtml(set, opts)      -> the bar, compressed: makeup strip,
 *                                               "worth a look", one drill-down per workstream
 *   OrgXExpectations.bind(root)              -> wires drill-down and the legend filter (once per root)
 *   OrgXExpectations.chipHtml(source, label) -> one source chip
 *   OrgXExpectations.editSentence(set, title)-> the chat sentence to change the bar
 */
(function attachExpectations(global) {
  'use strict';
  if (global.OrgXExpectations) return;

  var KIND = 'expectation_agreement';
  /** Checks shown in "Worth a look" before the rest wait in the rows below. */
  var LOOK_LIMIT = 4;
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
      scope_label: str(r.scope_label) || str(r.scope_title) || str(r.workstream_title) || null,
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

  /* Glyphs (16px grid, stroke): where a check came from, and how it is verified. */
  function glyph(paths, label) {
    return '<svg class="xp-ic" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"' +
      (label ? ' role="img" aria-label="' + esc(label) + '"><title>' + esc(label) + '</title>' : ' aria-hidden="true">') + paths + '</svg>';
  }
  var SOURCE_GLYPH = {
    rule: '<path d="M8 1.8l5 1.8v4c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6v-4z"/>',
    artifact_type: '<path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8.2l6 3 6-3"/><path d="M2 11.2l6 3 6-3"/>',
    learned: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.4v2.8h-2.8"/>',
    suggested: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
    drafted: '<path d="M8 2.2v3M8 10.8v3M2.2 8h3M10.8 8h3M4 4l1.9 1.9M10.1 10.1 12 12M12 4l-1.9 1.9M5.9 10.1 4 12"/>',
  };
  var VERIFY_GLYPH = {
    command: '<path d="M3 4.5l3.2 3.5L3 11.5"/><path d="M8.5 11.5h4.5"/>',
    http: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c2.2 2.2 2.2 9 0 11.2M8 2.4c-2.2 2.2-2.2 9 0 11.2"/>',
    artifact: '<path d="M4 1.8h5.2L12.4 5v9.2H4z"/><path d="M9 1.8V5h3.4"/>',
    manual: '<circle cx="8" cy="5.4" r="2.6"/><path d="M2.8 14c.8-2.8 2.8-4.3 5.2-4.3s4.4 1.5 5.2 4.3"/>',
  };
  /** Short legend words; the chip words (CHIP) are the long form. */
  var LEGEND = { rule: ['rule', 'rules'], artifact_type: ['kind of work', 'kind of work'], learned: ['learned', 'learned'], suggested: ['suggested', 'suggested'], drafted: ['drafted', 'drafted'] };
  /** decorative: the glyph sits next to its own words (legend, filter heading), so it is not named twice. */
  function sourceGlyph(source, decorative) { return '<span class="xp-g" data-src="' + source + '">' + glyph(SOURCE_GLYPH[source], decorative ? '' : CHIP[source]) + '</span>'; }
  function verifyGlyph(verify) { return '<span class="xp-v">' + glyph(VERIFY_GLYPH[verify] || VERIFY_GLYPH.manual, VERIFY[verify] || VERIFY.manual) + '</span>'; }

  /**
   * What needs the person's judgment: anything new since the last bar, and
   * what OrgX drafted or chat suggested. Rules and learned checks came from
   * them; kind-of-work checks are the standard for that work.
   */
  function worthALook(c) { return c.new_since_last || c.source === 'drafted' || c.source === 'suggested'; }
  function lookRank(c) { return c.new_since_last ? 0 : c.source === 'drafted' ? 1 : 2; }

  function ownerOf(id) {
    if (!id) return { key: '', name: 'Across the initiative', role: '' };
    var identity = global.OrgXAgentIdentity;
    var who = identity && identity.profile ? identity.profile(id, '', '') : null;
    if (who) return { key: who.key, name: who.name, role: who.role };
    var name = String(id).replace(/[-_]+agent$/i, '').replace(/[-_]+/g, ' ');
    return { key: id, name: name.charAt(0).toUpperCase() + name.slice(1), role: '' };
  }

  /**
   * Groups to drill into: one per workstream when the caller can place a
   * check (opts.workstreamOf(check) -> { key, label, sub, agent }), else one
   * per owner. The initiative-wide group reads last.
   */
  function groups(set, opts) {
    opts = opts || {};
    var out = [];
    var byKey = {};
    set.checks.forEach(function place(c) {
      var ws = (opts.workstreamOf ? opts.workstreamOf(c) : null) ||
        (c.scope_label && c.scope !== 'initiative' ? { key: c.scope_label, label: c.scope_label, agent: c.owner_agent } : null);
      var who = ownerOf(c.owner_agent);
      var key = ws ? 'ws:' + ws.key : c.owner_agent ? 'owner:' + c.owner_agent : 'all';
      if (!byKey[key]) {
        byKey[key] = ws
          ? { key: key, label: ws.label, sub: ws.sub || '', agent: ws.agent || c.owner_agent || '', checks: [] }
          : c.owner_agent ? { key: key, label: who.name, sub: who.role, agent: c.owner_agent, checks: [] }
            : { key: key, label: 'Across the initiative', sub: '', agent: '', checks: [] };
        out.push(byKey[key]);
      }
      byKey[key].checks.push(c);
    });
    out.sort(function last(a, b) { return (a.key === 'all') - (b.key === 'all'); });
    return out;
  }

  function chipHtml(source, label) {
    if (!CHIP[source]) return '';
    var text = CHIP[source] + (label ? ' · ' + label : '');
    return '<span class="xp-src" data-src="' + source + '" title="' + esc(CHIP_TITLE[source]) + '">' + esc(text) + '</span>';
  }

  /** One check: source glyph, the statement (and the call behind a learned one), how it is verified. */
  /**
   * One check. In a short list (opts.owner) it is one line: glyph, statement,
   * whose it is. In a drill-down it adds where it came from (the call behind a
   * learned check) and whether it is required.
   */
  function rowHtml(c, opts) {
    var short = Boolean(opts && opts.owner);
    var sub = [];
    if (!short && c.source === 'learned' && c.source_label) sub.push('from ' + c.source_label);
    if (!short && c.required && c.source !== 'rule') sub.push('required');
    var who = short ? (c.owner_agent ? ownerOf(c.owner_agent).name : c.scope === 'initiative' ? 'All' : '') : '';
    var title = c.new_since_last ? ' title="New since the last bar for this kind of work"' : '';
    return '<li class="xp-r' + (short ? ' is-short' : '') + '" data-src="' + c.source + '"' + (c.new_since_last ? ' data-new' : '') + title + '>' + sourceGlyph(c.source) +
      '<span class="xp-rt">' + esc(c.statement) + (c.new_since_last ? '<span class="sr-only xp-sr"> (new)</span>' : '') +
      (sub.length ? '<span class="xp-rs">' + esc(sub.join(' · ')) + '</span>' : '') + '</span>' +
      (short ? '<span class="xp-who">' + esc(who) + '</span>' : '') + verifyGlyph(c.verify) + '</li>';
  }

  function counts(set) {
    var n = {};
    set.checks.forEach(function each(c) { n[c.source] = (n[c.source] || 0) + 1; });
    return n;
  }

  /** The bar's makeup at a glance: one segment per source, sized by its share. */
  function stripHtml(set) {
    var n = counts(set);
    var parts = SOURCES.filter(function has(s) { return n[s]; });
    var label = total(set) + ' checks: ' + parts.map(function p(s) { return n[s] + ' ' + SOURCE_PHRASE[s][n[s] === 1 ? 0 : 1]; }).join(', ');
    return '<div class="xp-strip" role="img" aria-label="' + esc(label) + '">' +
      parts.map(function seg(s) { return '<span data-src="' + s + '" style="flex:' + n[s] + ' 1 0"></span>'; }).join('') + '</div>';
  }

  /** A workstream's checks where the host already lists the workstream (the scaffold tree). */
  function rowsHtml(checks, group) {
    if (!checks || !checks.length) return '';
    return '<div class="xp xp-inline"><ul class="xp-rows" role="list">' + checks.map(function r(c) { return rowHtml(c); }).join('') +
      (group ? '<li class="xp-edit"><button type="button" class="xp-clear" data-xp-edit="' + esc(group) + '">Change this workstream in chat</button></li>' : '') + '</ul></div>';
  }
  /** The makeup of a few checks as pips: familiar ones quiet, the ones worth a look in full colour. */
  function pipsHtml(checks) {
    if (!checks || !checks.length) return '';
    return '<span class="xp-pips" aria-hidden="true">' + checks.slice(0, 14).map(function pip(c) { return '<i data-src="' + c.source + '"' + (worthALook(c) ? ' data-look' : '') + '></i>'; }).join('') +
      (checks.length > 14 ? '<b>+' + (checks.length - 14) + '</b>' : '') + '</span>';
  }

  /* Per-viewer open state, so a re-render (live refresh) keeps what the person opened. */
  var OPEN = {};
  var FILTER = {};

  /** One drill-down row per workstream (or owner): who, how many, the makeup in pips, then its checks. */
  function groupHtml(key, g, editable) {
    var id = 'xp-' + key + '-' + g.key.replace(/[^\w-]/g, '_');
    var open = Boolean(OPEN[key + '|' + g.key]);
    var identity = global.OrgXAgentIdentity;
    var face = g.agent && identity && identity.avatar
      ? identity.avatar({ agent: g.agent, name: ownerOf(g.agent).name, size: 'inline' })
      : '<span class="xp-all" aria-hidden="true">' + glyph('<circle cx="8" cy="8" r="5.6"/><path d="M8 5v6M5 8h6"/>') + '</span>';
    var look = g.checks.filter(worthALook).length;
    var pips = g.checks.slice(0, 14).map(function pip(c) { return '<i data-src="' + c.source + '"' + (worthALook(c) ? ' data-look' : '') + '></i>'; }).join('') +
      (g.checks.length > 14 ? '<b>+' + (g.checks.length - 14) + '</b>' : '');
    return '<li class="xp-grp">' +
      '<button type="button" class="xp-gh" data-xp-toggle="' + esc(key + '|' + g.key) + '" aria-expanded="' + open + '" aria-controls="' + esc(id) + '">' +
      '<span class="xp-face">' + face + '</span>' +
      '<span class="xp-gt"><span class="xp-gn">' + esc(g.label) + '</span>' + (g.sub ? '<span class="xp-gs">' + esc(g.sub) + '</span>' : '') + '</span>' +
      '<span class="xp-pips" aria-hidden="true">' + pips + '</span>' +
      '<span class="xp-gc">' + g.checks.length + (look ? '<span class="xp-gl" title="' + look + ' worth a look"> · ' + look + ' new</span>' : '') + '</span>' +
      '<span class="xp-chev" aria-hidden="true">' + glyph('<path d="M5 6.5l3 3 3-3"/>') + '</span></button>' +
      '<ul class="xp-rows" role="list" id="' + esc(id) + '"' + (open ? '' : ' hidden') + '>' + g.checks.map(function r(c) { return rowHtml(c); }).join('') +
      (editable ? '<li class="xp-edit"><button type="button" class="xp-clear" data-xp-edit="' + esc(g.label) + '">Change ' + esc(g.key === 'all' ? 'these' : 'this workstream') + ' in chat</button></li>' : '') + '</ul></li>';
  }

  /**
   * The bar, compressed: its makeup (a strip and a legend that filters), the
   * few checks worth a look, then one drill-down row per workstream.
   * opts: { key, workstreamOf, look: false to skip the short list }
   */
  function barHtml(set, opts) {
    if (!set) return '';
    opts = opts || {};
    var key = String(opts.key || set.id || set.decision_id || 'bar').replace(/[^\w-]/g, '_');
    var n = counts(set);
    var filter = FILTER[key] && n[FILTER[key]] ? FILTER[key] : '';
    var legend = SOURCES.filter(function has(s) { return n[s]; }).map(function item(s) {
      return '<button type="button" class="xp-lg" data-src="' + s + '" data-xp-filter="' + esc(key + '|' + s) + '" aria-pressed="' + (filter === s) + '" title="' + esc(CHIP_TITLE[s]) + '">' +
        sourceGlyph(s, true) + '<b>' + n[s] + '</b><span>' + esc(LEGEND[s][n[s] === 1 ? 0 : 1]) + '</span></button>';
    }).join('');
    // One view per source, plus "Worth a look"; the legend shows one at a time.
    var views = SOURCES.filter(function has(src) { return n[src]; }).map(function view(src) {
      var only = set.checks.filter(function f(c) { return c.source === src; });
      return '<section class="xp-look" data-xp-view="' + src + '" aria-label="' + esc(CHIP[src]) + '"' + (filter === src ? '' : ' hidden') + '>' +
        '<p class="xp-h is-filter">' + sourceGlyph(src, true) + '<span>' + esc(CHIP_TITLE[src]) + '</span><button type="button" class="xp-clear" data-xp-filter="' + esc(key + '|' + src) + '">Show all</button></p>' +
        '<ul class="xp-rows" role="list">' + only.map(function r(c) { return rowHtml(c, { owner: true }); }).join('') + '</ul></section>';
    }).join('');
    var look = opts.look === false ? [] : set.checks.filter(worthALook).sort(function by(x, y) { return lookRank(x) - lookRank(y); });
    var shown = look.slice(0, LOOK_LIMIT);
    var lookView = look.length
      ? '<section class="xp-look" data-xp-view="" aria-label="Worth a look"' + (filter ? ' hidden' : '') + '><p class="xp-h">Worth a look<span class="xp-hn">' + look.length + ' of ' + total(set) + ' are new to you</span></p>' +
        '<ul class="xp-rows" role="list">' + shown.map(function r(c) { return rowHtml(c, { owner: true }); }).join('') + '</ul>' +
        (look.length > shown.length ? '<p class="xp-more">' + (look.length - shown.length) + ' more ' + esc(opts.moreWhere || 'in the rows below') + '</p>' : '') + '</section>'
      : '<section class="xp-look is-calm" data-xp-view=""' + (filter ? ' hidden' : '') + '><p class="xp-h">Nothing new<span class="xp-hn">every check comes from your rules, your past calls or this kind of work</span></p></section>';
    var focus = lookView + views;
    var omitted = set.omitted_count ? '<p class="xp-more">' + set.omitted_count + ' more in OrgX</p>' : '';
    return '<div class="xp" data-xp="' + esc(key) + '">' +
      '<div class="xp-mix">' + stripHtml(set) + '<div class="xp-legend" role="group" aria-label="Show checks by where they came from">' + legend + '</div></div>' +
      focus +
      '<ul class="xp-groups" role="list">' + groups(set, opts).filter(function keep(x) { return !opts.groupFilter || opts.groupFilter(x); }).map(function g(x) { return groupHtml(key, x, opts.editable !== false); }).join('') + '</ul>' + omitted + '</div>';
  }

  /**
   * Wire drill-down and the legend filter inside root (once per root). The
   * bar re-renders itself in place; the host widget hears 'ox-xp-change' to
   * resize. Clicks on the bar never reach the host's own handlers.
   */
  function bind(root) {
    if (!root || root.__oxXp) return;
    root.__oxXp = true;
    root.addEventListener('click', function onClick(event) {
      var t = event.target && event.target.closest ? event.target.closest('[data-xp-toggle],[data-xp-filter],[data-xp-edit]') : null;
      if (!t || !root.contains(t)) return;
      var toggle = t.getAttribute('data-xp-toggle');
      if (t.hasAttribute('data-xp-edit')) {
        // The host posts the chat sentence (editSentence with the workstream); the bar only asks.
        var bar0 = t.closest('.xp');
        t.dispatchEvent(new (global.CustomEvent)('ox-xp-edit', { bubbles: true, detail: { key: bar0 ? bar0.getAttribute('data-xp') : '', group: t.getAttribute('data-xp-edit'), button: t } }));
        event.stopPropagation();
        return;
      }
      if (toggle) {
        var next = t.getAttribute('aria-expanded') !== 'true';
        OPEN[toggle] = next;
        var body = root.ownerDocument.getElementById(t.getAttribute('aria-controls'));
        var motion = global.OrgXWidgetRuntime && global.OrgXWidgetRuntime.motion;
        if (body && motion && motion.setExpanded) motion.setExpanded(body, next, t);
        else { if (body) body.hidden = !next; t.setAttribute('aria-expanded', String(next)); }
      } else {
        var parts = t.getAttribute('data-xp-filter').split('|');
        var on = FILTER[parts[0]] === parts[1] ? '' : parts[1];
        FILTER[parts[0]] = on;
        var bar = t.closest('.xp');
        if (bar) {
          Array.prototype.forEach.call(bar.querySelectorAll('[data-xp-view]'), function show(v) { v.hidden = v.getAttribute('data-xp-view') !== on; });
          Array.prototype.forEach.call(bar.querySelectorAll('.xp-lg'), function press(b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-src') === on)); });
          if (t.classList.contains('xp-clear')) {
            var back = bar.querySelector('.xp-lg[data-src="' + parts[1] + '"]');
            if (back) back.focus();
          }
        }
      }
      event.stopPropagation();
      root.dispatchEvent(new (global.CustomEvent)('ox-xp-change', { bubbles: true }));
    });
  }
  /** The sentence that takes the bar into chat to change it before agreeing. */
  function editSentence(set, title, group) {
    var name = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    var part = String(group || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (part) {
      var n = set ? set.checks.filter(function inGroup(c) { return c.scope_label === part || ownerOf(c.owner_agent).name === part; }).length : 0;
      return 'In OrgX, change what done means for the “' + part + '” workstream' + (name ? ' of “' + name + '”' : '') +
        ' before I agree: show me its ' + (n || '') + (n === 1 ? ' check' : ' checks') + ' and ask me what to add, drop or reword. Leave the other workstreams as they are.';
    }
    return 'In OrgX, change what done means' + (name ? ' for “' + name + '”' : '') +
      ' before I agree: show me the ' + (set ? total(set) : '') + ' checks by workstream and ask me what to add, drop or reword.';
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
    barHtml: barHtml,
    bind: bind,
    rowsHtml: rowsHtml,
    pipsHtml: pipsHtml,
    worthALook: worthALook,
    chipHtml: chipHtml,
    editSentence: editSentence,
    shortDate: shortDate,
    sourceOf: sourceOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
