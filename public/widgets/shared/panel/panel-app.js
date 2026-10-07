/* OrgX panel controller: snapshot reads, rulings, rendering. */
    (function orgxPanel() {
    'use strict';

    var R = window.OrgXWidgetRuntime;
    var X = window.OrgXOpenAIExtensions;
    var Brand = window.OrgXPanelBrand || null;
    var Launch = window.OrgXPanelLaunch || null;
    var Views = window.OrgXPanelViews || null;
    var Tour = window.OrgXPanelTour || null;
    var root = document.getElementById('panel');
    var params = new URLSearchParams(window.location.search);
    var isGallery = params.get('gallery') === 'true';
    var APPROVAL_META_KEY = 'orgx/widgetApproval';
    var ORGX_HOME = window.OrgXLinks.command();
    var EVIDENCE_VISIBLE = 2;

    var ui = {
      snapshot: null,
      readState: { phase: 'idle' },
      auth: null,
      syncedAt: null,
      tokens: {},
      mode: params.get('mode') === 'thread' ? 'thread' : 'global',
      listOpen: false,
      evidenceOpen: false,
      composer: null,
      selections: {},
      rejectPicks: {},
      answers: {},
      notes: {},
      fieldErrors: {},
      rulings: {},
      lastRuling: null,
      actionError: null,
      changedSince: null,
      limited: false,
      caps: { modelContext: false, deepLink: false },
      generation: 0,
      chatCannotDecide: false,
      // Panel v2: tabs, the lazily read In progress view, and what this
      // panel session settled (the Done tab's receipts).
      tab: 'needs',
      work: null,
      workPhase: 'idle',
      session: [],
      openReceipt: null,
      launchNoted: false,
      tourChecked: false,
    };
    var tour = null;
    var ext = { deepLink: undefined, modelContext: undefined };
    var share = X.createShareController({ modelContext: undefined });
    var inflight = null;
    var pendingFocus = undefined;
    var timers = [];
    var lastFocusRequest = null;
    var handledHint = { deepLink: null, context: null };

    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function ago(iso) {
      var t = iso ? Date.parse(iso) : NaN;
      if (!isFinite(t)) return '';
      var s = Math.max(0, (Date.now() - t) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      if (s < 86400) return Math.floor(s / 3600) + 'h';
      return Math.floor(s / 86400) + 'd';
    }
    function agoLong(iso) {
      var a = ago(iso);
      return !a || a === 'just now' ? a : a + ' ago';
    }
    function clock(date) {
      return window.OrgXTime.clock(date);
    }
    function urgencyLabel(u) {
      return u === 'critical' ? 'Critical' : u === 'high' ? 'High' : u === 'low' ? 'Low' : 'Normal';
    }
    function announce(text) {
      var kit = window.OrgXInteractionKit;
      if (kit && typeof kit.announce === 'function') {
        try { kit.announce(text); return; } catch (_) { /* fall through */ }
      }
      var live = document.getElementById('pn-live');
      if (live) { live.textContent = ''; live.textContent = text; }
    }
    function later(fn, ms) {
      var id = window.setTimeout(fn, ms);
      timers.push(id);
      return id;
    }
    var DECIDE_IN_ORGX_COPY = {
      credential_required: 'It needs a credential, and credentials are entered only in OrgX.',
      integration_connection_required: 'It settles when you connect the integration in OrgX.',
      form_input_required: 'It asks for several answers. Fill them in OrgX.',
      options_unavailable: 'Its options could not be read here. Choose in OrgX.',
      artifact_reference_invalid: 'The artifact under review could not be opened here. Review it in OrgX.',
      specialized_lifecycle: 'This type runs its own review in OrgX.',
      requester_cannot_approve: 'You requested this action, so another approver decides it.',
      widget_approvals_disabled: 'Deciding from chat is off for this workspace.',
      action_authority_denied: 'Your role can’t approve this from chat. OrgX shows who can.',
      token_mismatch: 'This view belongs to another account or workspace. Open it in OrgX.',
      lifecycle_required: 'This one finishes in OrgX.',
      chat_unavailable: 'This chat can’t settle it right now, so nothing was sent.',
      // Older servers.
      critical: 'Critical decisions are made in OrgX.',
      choice_required: 'Choose between the options in OrgX.',
      agent_run_approval: 'Agent run approvals are made in OrgX.',
      protected_decision_type: 'This one needs the full review in OrgX.',
      artifact_review_lifecycle: 'This one needs the full review in OrgX.',
    };
    function decideInOrgxDetail(reason) {
      return DECIDE_IN_ORGX_COPY[reason] || (ui.chatCannotDecide ? DECIDE_IN_ORGX_COPY.chat_unavailable : 'Approval uses your signed-in OrgX session.');
    }

    var ICON = {
      ext: '<svg class="pn-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14"/><path d="M14 4h6v6M20 4l-9 9"/></svg>',
      doc: '<svg class="pn-ic ev-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" fill="currentColor" fill-opacity=".12" stroke="none"/><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 15.5h4"/></svg>',
    };
    var HEADLINE_MAX = 96;
    var NOT_A_SENTENCE_END = /(?:\b(?:e\.g|i\.e|vs|etc|approx|incl|No|Mr|Ms|Dr|St|Inc|Ltd)|\b[A-Z])$/;
    function splitHeadline(text) {
      var full = String(text || '').replace(/\s+/g, ' ').trim();
      var head = full;
      var rest = '';
      var re = /[.!?](?=\s+["“(]?[A-Z0-9])/g;
      var match;
      while ((match = re.exec(full))) {
        var end = match.index + 1;
        if (end < 12 || NOT_A_SENTENCE_END.test(full.slice(0, match.index))) continue;
        head = full.slice(0, end).trim();
        rest = full.slice(end).trim();
        break;
      }
      var colon = head.indexOf(': ');
      if (head.length > 110 && colon >= 16 && colon <= HEADLINE_MAX) {
        rest = head.slice(colon + 2).replace(/^[a-z]/, function up(c) { return c.toUpperCase(); }) + (rest ? ' ' + rest : '');
        head = head.slice(0, colon);
      }
      return { headline: head, body: rest };
    }
    var CLI = /^(?:gh|git|pnpm|npm|npx|yarn|curl|kubectl|docker|terraform|make|psql|node|bash|orgx)\s+\S/;
    function sentences(text) {
      var out = [];
      var rest = String(text || '');
      while (rest) {
        var s = splitHeadline(rest);
        out.push(s.headline);
        if (!s.body || s.body === rest) break;
        rest = s.body;
      }
      return out;
    }
    function inline(text) {
      return esc(text)
        .replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, function link(url) {
          var raw = url.replace(/&amp;/g, '&');
          return '<a href="' + url + '" data-action="open" data-url="' + url + '">' + esc(raw.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)) + '</a>';
        })
        .replace(/`([^`]{1,200})`/g, '<code>$1</code>')
        .replace(/\b([0-9a-f]{12,64})\b/g, function hash(m, h) { return '<code title="' + h + '">' + h.slice(0, 10) + '</code>'; });
    }
    function structureBody(text) {
      var parts = { lede: [], facts: [], commands: [], ifApproved: '' };
      sentences(text).forEach(function sort(line) {
        var bare = line.replace(/[.!]$/, '');
        var m = /^([A-Z][\w’' -]{2,28}?)\s*:\s+(.+)$/.exec(line);
        var label = m ? m[1].trim() : '';
        if (m && /^(?:command|run|cmd|shell)$/i.test(label)) { parts.commands.push(m[2].replace(/\.$/, '')); return; }
        if (CLI.test(bare) && !/\s(?:the|to|and|because)\s/i.test(bare)) { parts.commands.push(bare); return; }
        if (!parts.ifApproved && /^(?:approve|approving)\b.{0,40}\b(?:to|lets?|will|runs?)\b/i.test(line)) {
          parts.ifApproved = line.replace(/^(?:approve|approving)\s+(?:to\s+)?/i, '').replace(/^\w/, function up(c) { return c.toUpperCase(); });
          return;
        }
        if (m && label.length <= 24) { parts.facts.push({ k: label, v: m[2].replace(/^[a-z]/, function up(c) { return c.toUpperCase(); }) }); return; }
        parts.lede.push(line);
      });
      return parts;
    }

    function looksRaw(text) {
      return /^[\s{[<"]/.test(text) || /^[\s{}[\]"',:]*$/.test(text) || /"\s*:/.test(text) || /\b(?:undefined|null|NaN)\b/.test(text);
    }
    function safeErrorText(error, fallback, max) {
      var message = error && typeof error.message === 'string' ? error.message.trim() : '';
      if (!message || looksRaw(message) || message.length > (max || 160) || /tool (?:request|execution) failed/i.test(message)) return fallback;
      return message;
    }
    function errorKind(error) {
      var code = String((error && error.code) || '').toLowerCase();
      if (code === 'tool_unavailable' || code === 'network') return code;
      if (code === 'host_unavailable') return 'tool_unavailable';
      if (code && code !== 'tool_failed') return code;
      var raw = [error && error.message, error && error.details && error.details.raw].filter(function str(v) { return typeof v === 'string'; }).join(' ');
      if (/resource not found|tool not found|unknown tool|method not found|no such tool/i.test(raw)) return 'tool_unavailable';
      if (/failed to fetch|networkerror|network error|load failed|timed? ?out|offline/i.test(raw)) return 'network';
      return code;
    }
    var PAST = {
      approve: 'Approved', 'approve and continue': 'Approved', 'approve selected': 'Approved', 'grant access': 'Access granted',
      'allow once': 'Allowed once', 'allow and continue': 'Allowed', 'send answer': 'Answer sent', 'send guidance and retry': 'Guidance sent',
      'confirm and continue': 'Confirmed', 'confirm selection': 'Confirmed', confirm: 'Confirmed', 'accept plan': 'Plan accepted',
      'apply edit': 'Edit applied', retry: 'Retry approved', 'retry and continue': 'Retry approved', acknowledge: 'Acknowledged',
      'send back': 'Sent back', deny: 'Denied', decline: 'Declined', reject: 'Rejected', 'request changes': 'Changes requested', 'stop here': 'Stopped',
    };
    function pastTense(label, action) {
      return PAST[String(label || '').toLowerCase()] || (action === 'approve' ? 'Approved' : 'Sent back');
    }
    var KINDS = ['decision', 'approval', 'action'];
    var TEXT_MAX = 2000;
    function has(list, value) { return Array.isArray(list) && list.indexOf(value) !== -1; }
    function kindOf(f) {
      var actions = f && f.widget_actions && !Array.isArray(f.widget_actions) ? f.widget_actions : null;
      var kind = (actions && actions.kind) || (f && f.kind);
      return KINDS.indexOf(kind) !== -1 ? kind : 'decision';
    }
    function toOption(o) {
      return {
        id: o.id, label: o.label, description: o.description || '',
        implied: o.implied_action === 'approve' || o.implied_action === 'reject' ? o.implied_action : null,
        requiresReason: o.requires_reason === true,
      };
    }
    function choicesFor(f) {
      var raw = f.widget_actions;
      var kind = kindOf(f);
      if (raw && !Array.isArray(raw) && Array.isArray(raw.actions)) {
        var labels = raw.labels || {};
        var rs = raw.selection && Array.isArray(raw.selection.options) && raw.selection.options.length ? raw.selection : null;
        var options = rs ? rs.options.filter(function valid(o) { return o && o.id && o.label; }).map(toOption) : [];
        var spec = {
          kind: kind,
          approve: has(raw.actions, 'approve') ? { label: labels.approve || 'Approve', optionId: '' } : null,
          reject: has(raw.actions, 'reject') ? { label: labels.reject || 'Send back' } : null,
          rejectRequiresReason: raw.reject_requires_reason === true,
          answer: raw.answer && (has(raw.answer.required_for, 'approve') || has(raw.answer.required_for, 'reject'))
            ? { approve: has(raw.answer.required_for, 'approve'), reject: has(raw.answer.required_for, 'reject'), max: Math.min(TEXT_MAX, Number(raw.answer.max_length) || TEXT_MAX) }
            : null,
          selection: null,
        };
        if (options.length) {
          var multiple = rs.mode === 'multiple';
          var min = multiple ? Math.min(options.length, Math.max(0, Number(rs.min) || 0) || 1) : 1;
          spec.selection = {
            mode: multiple ? 'multiple' : 'single', options: options, min: min,
            max: multiple ? Math.max(min, Math.min(options.length, Number(rs.max) || options.length)) : 1,
            requiredFor: { approve: has(rs.required_for, 'approve'), reject: has(rs.required_for, 'reject') },
          };
        }
        var only = spec.selection && spec.selection.mode === 'single' && options.length === 1 ? options[0] : null;
        if (only && spec.approve && spec.selection.requiredFor.approve && !only.implied && !only.requiresReason && spec.approve.label === only.label) {
          spec.approve.optionId = only.id;
          spec.selection = null;
        }
        return spec;
      }
      if (Array.isArray(raw) && raw.length) {
        var legacyOptions = raw.filter(function isOption(a) { return a && a.kind === 'option' && a.option_id; })
          .map(function opt(a) { return { id: a.option_id, label: a.label, description: '', implied: null, requiresReason: false }; });
        var approveAction = raw.filter(function isApprove(a) { return a && a.kind === 'approve'; })[0];
        var rejectAction = raw.filter(function isReject(a) { return a && a.kind === 'reject'; })[0];
        var legacy = { kind: kind, approve: null, reject: rejectAction ? { label: rejectAction.label } : null, rejectRequiresReason: true, answer: null, selection: null };
        if (legacyOptions.length === 1 && !approveAction) legacy.approve = { label: legacyOptions[0].label, optionId: legacyOptions[0].id };
        else {
          legacy.approve = { label: approveAction ? approveAction.label : 'Approve', optionId: '' };
          if (legacyOptions.length >= 2) legacy.selection = { mode: 'single', options: legacyOptions, min: 1, max: 1, requiredFor: { approve: true, reject: false } };
        }
        return legacy;
      }
      var fallback = (Array.isArray(f.options) ? f.options : []).map(function opt(o) { return { id: o.id, label: o.label, description: '', implied: null, requiresReason: false }; });
      var multi = f.multiselect === true && fallback.length >= 2;
      return {
        kind: kind,
        approve: { label: multi ? 'Confirm' : 'Approve', optionId: '' },
        reject: { label: 'Send back' },
        rejectRequiresReason: true,
        answer: null,
        selection: fallback.length >= 2
          ? { mode: multi ? 'multiple' : 'single', options: fallback, min: 1, max: multi ? fallback.length : 1, requiredFor: { approve: true, reject: false } }
          : null,
      };
    }
    function selectedFor(id) {
      return Array.isArray(ui.selections[id]) ? ui.selections[id] : [];
    }
    function optionById(f, optionId) {
      var sel = choicesFor(f).selection;
      return sel ? sel.options.filter(function byId(o) { return o.id === optionId; })[0] || null : null;
    }
    function optionLabel(f, optionId) {
      var o = optionById(f, optionId);
      if (o) return o.label;
      var c = choicesFor(f);
      return c.approve && c.approve.optionId === optionId ? c.approve.label : '';
    }
    function optionsFor(c, action) {
      return c.selection ? c.selection.options.filter(function fits(o) { return !o.implied || o.implied === action; }) : [];
    }
    function rangeCopy(sel) {
      if (sel.min === sel.max) return String(sel.min);
      return sel.max >= sel.options.length ? (sel.min > 1 ? 'at least ' + sel.min : 'one or more') : sel.min + '–' + sel.max;
    }
    function draftFor(f, action) {
      var c = choicesFor(f);
      var sel = c.selection;
      var id = f.id;
      var args = { kind: c.kind };
      var missing = [];
      var picked = [];
      if (action === 'approve' && c.approve && c.approve.optionId) {
        picked = [c.approve.optionId];
      } else if (sel) {
        var allowed = optionsFor(c, action).map(function ids(o) { return o.id; });
        var pool = action === 'reject' && sel.mode === 'single' ? (ui.rejectPicks[id] ? [ui.rejectPicks[id]] : []) : selectedFor(id);
        picked = action === 'reject' && sel.mode === 'multiple' && !sel.requiredFor.reject
          ? []
          : pool.filter(function ok(oid) { return allowed.indexOf(oid) !== -1; });
      }
      if (picked.length) {
        if (sel && sel.mode === 'multiple') args.option_ids = picked.slice();
        else args.option_id = picked[0];
      }
      if (sel && (sel.requiredFor[action] || (sel.mode === 'multiple' && picked.length)) &&
          (!picked.length || (sel.mode === 'multiple' && (picked.length < sel.min || picked.length > sel.max)))) {
        missing.push('options');
      }
      var err = ui.fieldErrors[id];
      var reasonNeeded = picked.some(function asks(oid) { var o = optionById(f, oid); return Boolean(o && o.requiresReason); }) ||
        (action === 'reject' && c.rejectRequiresReason) || Boolean(err && err.action === action && err.field === 'reason');
      var reason = String((action === 'reject' ? (ui.composer && ui.composer.id === id ? ui.composer.draft : '') : ui.notes[id]) || '').trim();
      if (reason) args.reason = reason.slice(0, TEXT_MAX);
      else if (reasonNeeded) missing.push('reason');
      var answerNeeded = Boolean(c.answer && c.answer[action]);
      if (answerNeeded) {
        var answer = String(ui.answers[id] || '').trim();
        if (answer) args.answer = answer.slice(0, c.answer.max);
        else missing.push('answer');
      }
      return { action: action, args: args, missing: missing, picked: picked, reasonNeeded: reasonNeeded, answerNeeded: answerNeeded };
    }
    function missingCopy(draft, sel) {
      if (draft.missing.indexOf('options') !== -1) return sel && sel.mode === 'multiple' ? 'choose ' + rangeCopy(sel) + ' first' : 'choose an option first';
      if (draft.missing.indexOf('answer') !== -1) return 'type your answer first';
      if (draft.missing.indexOf('reason') !== -1) return draft.action === 'reject' ? 'write a note first' : 'say why first';
      return '';
    }
    function quickDecide(item) {
      var c = choicesFor(item);
      return Boolean(c.approve && !c.selection && !(c.answer && c.answer.approve));
    }
    function tokenFor(id) {
      if (ui.chatCannotDecide) return null;
      var t = ui.tokens[id];
      return typeof t === 'string' && t ? t : null;
    }
    function adoptTokens(meta) {
      var approval = meta && meta[APPROVAL_META_KEY];
      var tokens = approval && approval.approval_tokens;
      ui.tokens = tokens && typeof tokens === 'object' ? Object.assign({}, tokens) : {};
    }
    function isSnapshot(data) {
      // Check the fields this renderer consumes. The server's output schema remains canonical.
      return Boolean(data && data.schema === 'orgx.panel.v1' && isFinite(Date.parse(data.generated_at)) &&
        ['ok', 'no_workspace', 'degraded'].indexOf(data.state) !== -1 &&
        (data.workspace === null || (data.workspace && typeof data.workspace.id === 'string')) &&
        data.attention && typeof data.attention.pending === 'number' &&
        Array.isArray(data.queue) && data.queue.every(function validItem(item) { return item && typeof item.id === 'string'; }) &&
        data.selection && data.proof && Array.isArray(data.degraded) &&
        (!data.focus || (typeof data.focus.id === 'string' && Array.isArray(data.focus.evidence))));
    }
    function workspaceId() {
      return ui.snapshot && ui.snapshot.workspace ? ui.snapshot.workspace.id : null;
    }
    function findItem(id) {
      var s = ui.snapshot;
      if (!s || !id) return null;
      if (s.focus && s.focus.id === id) return s.focus;
      for (var i = 0; i < s.queue.length; i += 1) if (s.queue[i].id === id) return s.queue[i];
      return null;
    }

    function header() {
      var s = ui.snapshot;
      var name = s && s.workspace && s.workspace.name ? s.workspace.name : (s && s.workspace ? 'Workspace' : '');
      var synced = ui.syncedAt ? window.OrgXTime.synced(ui.syncedAt).replace(/^s/, 'S') : '';
      var refresh = ui.auth || ui.readState.phase === 'failed' ? '' : '<button type="button" class="quiet-btn" data-action="refresh">Refresh</button>';
      var nameHtml = name
        ? (ui.mode === 'global' ? '<h1 class="ws" title="' + esc(name) + '">' + esc(name) + '</h1>' : '<span class="ws">' + esc(name) + '</span>')
        : (ui.mode === 'global' ? '<h1 class="sr-only">OrgX</h1>' : '');
      var mark = Brand ? '<span class="pn-mark-slot">' + Brand.mark(22) + '</span>' : '';
      var tabs = tabsHtml();
      var help = tabs ? '<button type="button" class="quiet-btn pn-help" data-action="tour" aria-label="How the OrgX panel works">?</button>' : '';
      return '<header class="top' + (tabs ? ' has-tabs' : '') + '">' + mark + '<div class="top-id"><span class="brand" aria-hidden="' + (name ? 'false' : 'true') + '">OrgX</span>' +
        (name ? '<span aria-hidden="true">·</span>' : '') + nameHtml + '</div>' + tabs +
        (synced ? '<span class="sync">' + esc(synced) + '</span>' : '') + refresh + help + '</header>';
    }

    function tabsHtml() {
      var s = ui.snapshot;
      if (!Views || ui.mode !== 'global' || ui.auth || !s || s.state !== 'ok' || ui.limited || s.selection.status === 'unavailable') return '';
      var blocked = ui.work && ui.work.status === 'ok' && ui.work.items.some(function b(i) { return i.state === 'blocked'; });
      return Views.tabsHtml({
        active: ui.tab,
        counts: { needs: s.attention.pending, work: ui.work && ui.work.status === 'ok' ? ui.work.total : null, done: ui.session.length },
        tones: { needs: s.attention.pending ? (s.attention.blocking ? 'red' : 'amber') : '', work: blocked ? 'red' : '', done: ui.session.length ? 'teal' : '' },
      });
    }

    function attentionLine(s) {
      var pending = s.attention.pending;
      if (!pending) return '<ox-attention-line tone="calm" count="0"></ox-attention-line>';
      var oldest = ago(s.attention.oldest_at);
      return '<ox-attention-line tone="' + (s.attention.blocking ? 'blocking' : 'needs-you') + '" count="' + pending + '"' +
        (oldest && oldest !== 'just now' ? ' oldest="' + esc(oldest) + '"' : '') + '></ox-attention-line>';
    }

    function noticeHtml() {
      var parts = [];
      if (ui.readState.phase === 'failed' && ui.snapshot) {
        parts.push('<div class="notice" data-tone="amber" role="status"><p>Showing the snapshot from ' + esc(clock(ui.syncedAt)) +
          '. The latest snapshot could not be loaded.</p><button type="button" class="text-btn" data-action="refresh">Refresh</button></div>');
      }
      if (ui.lastRuling) {
        var receiptTitle = splitHeadline(ui.lastRuling.title);
        var receiptCommand = structureBody(receiptTitle.body).commands[0];
        parts.push('<div class="notice" data-tone="teal" role="status"><p>' +
          (ui.lastRuling.elsewhere ? 'Settled in OrgX: ' : ui.lastRuling.verb ? ui.lastRuling.verb + ' by you: ' : ui.lastRuling.action === 'approve' ? 'Approved by you: ' : 'Sent back by you: ') +
          (receiptCommand ? '<code>' + esc(receiptCommand) + '</code>' : esc(receiptTitle.headline)) + '</p>' +
          (receiptTitle.body ? '<details class="receipt-details"><summary>Decision details</summary><p>' + inline(receiptTitle.body) + '</p></details>' : '') + '</div>');
      }
      return parts.join('');
    }

    function evidenceHtml(f) {
      if (!f.evidence.length) return '';
      var clampable = f.evidence.length > EVIDENCE_VISIBLE;
      var shown = clampable && !ui.evidenceOpen ? f.evidence.slice(0, EVIDENCE_VISIBLE) : f.evidence;
      var more = clampable
        ? '<button type="button" class="text-btn" data-action="evidence" data-total="' + esc(f.evidence_total) + '" aria-expanded="' + (ui.evidenceOpen ? 'true' : 'false') + '" aria-controls="ev-list">' +
          evidenceToggleLabel(ui.evidenceOpen, f.evidence_total) + '</button>'
        : (f.evidence_total > f.evidence.length
          ? '<button type="button" class="text-btn" data-action="open" data-url="' + esc(f.url) + '">All evidence (' + f.evidence_total + ') ↗</button>'
          : '');
      var items = f.evidence.map(function evidenceItem(e) {
        return '<li class="ev-item">' + ICON.doc + '<span class="ev-title">' + esc(e.title) + '</span>' +
          (e.source_url ? '<button type="button" class="ev-open" data-action="open" data-url="' + esc(e.source_url) + '" aria-label="Open ' + esc(e.title) + ' (opens in a new tab)">' + ICON.ext + '</button>' : '') + '</li>';
      }).join('');
      var count = evidenceCountLabel(shown.length, f.evidence_total);
      return '<div class="evidence"><p class="evidence-head"><span data-evidence-count>' + count + '</span>' + more + '</p><ul class="ev-list" id="ev-list">' + items + '</ul></div>';
    }

    function evidenceToggleLabel(open, total) {
      return open ? 'Show fewer' : 'All evidence (' + total + ')';
    }
    function evidenceCountLabel(shown, total) {
      return shown >= total ? 'Evidence (' + total + ')' : 'Evidence (' + shown + ' of ' + total + ')';
    }
    function applyEvidenceClamp(animate) {
      var list = root.querySelector('#ev-list');
      var toggle = root.querySelector('[data-action="evidence"]');
      if (!list || !toggle) return;
      var items = Array.prototype.slice.call(list.querySelectorAll('.ev-item'));
      var clamped = !ui.evidenceOpen;
      var total = Number(toggle.getAttribute('data-total')) || items.length;
      var last = items[EVIDENCE_VISIBLE - 1];
      var max = last ? Math.ceil(last.getBoundingClientRect().bottom - list.getBoundingClientRect().top) : 0;
      toggle.textContent = evidenceToggleLabel(!clamped, total);
      var count = root.querySelector('[data-evidence-count]');
      if (count) count.textContent = evidenceCountLabel(clamped ? Math.min(EVIDENCE_VISIBLE, items.length) : items.length, total);
      var options = { max: max, beyond: items.slice(EVIDENCE_VISIBLE), instant: !animate };
      if (R && R.motion && R.motion.setClamped) R.motion.setClamped(list, clamped, toggle, options);
    }
    function fitRowActions() {
      Array.prototype.forEach.call(root.querySelectorAll('.row'), function fit(row) {
        var acts = row.querySelector('.row-acts');
        if (acts && acts.offsetWidth) row.style.setProperty('--acts-w', (acts.offsetWidth + 10) + 'px');
      });
    }
    window.addEventListener('resize', function onResizeRows() { window.requestAnimationFrame(fitRowActions); });
    function toggleEvidence(open) {
      ui.evidenceOpen = open;
      applyEvidenceClamp(true);
    }

    function fieldErrorHtml(id, field, action) {
      var err = ui.fieldErrors[id];
      if (!err || !err.message || err.field !== field || (action && err.action !== action)) return '';
      return '<p class="error-line" role="alert" data-error-for="' + esc(id) + '">' + esc(err.message) + '</p>';
    }
    function textFieldHtml(id, field, label, value, max, placeholder) {
      var err = ui.fieldErrors[id];
      var invalid = err && err.message && (err.field === field || (field === 'note' && err.field === 'reason'));
      return '<div class="composer field">' +
        '<label for="' + field + '-' + esc(id) + '">' + esc(label) + '</label>' +
        '<textarea id="' + field + '-' + esc(id) + '" data-field="' + field + '" data-id="' + esc(id) + '" maxlength="' + (max || TEXT_MAX) + '"' +
        (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + (invalid ? ' aria-invalid="true"' : '') + '>' + esc(value || '') + '</textarea></div>';
    }
    function optionButtonsHtml(f, c, forAction) {
      var sel = c.selection;
      var list = forAction === 'approve' && sel.mode === 'single' ? sel.options : optionsFor(c, forAction);
      var picked = selectedFor(f.id);
      var label = forAction === 'reject'
        ? (sel.mode === 'multiple' ? 'Choose ' + rangeCopy(sel) : 'Which option is this about?') + (sel.requiredFor.reject ? ' · required' : '')
        : sel.mode === 'multiple' ? 'Choose ' + rangeCopy(sel) : sel.requiredFor.approve ? 'Choose one' : 'Or choose an option';
      return '<div class="opts" role="group" aria-labelledby="opts-' + forAction + '-' + esc(f.id) + '"><p class="opts-label" id="opts-' + forAction + '-' + esc(f.id) + '">' + esc(label) + '</p>' +
        list.map(function optionButton(o) {
          var toggle = sel.mode === 'multiple' || forAction === 'reject';
          var on = forAction === 'reject' && sel.mode === 'single' ? ui.rejectPicks[f.id] === o.id : picked.indexOf(o.id) !== -1;
          var tag = forAction === 'approve' && o.implied === 'reject' && c.reject ? c.reject.label : o.requiresReason ? 'Asks why' : '';
          var action = forAction === 'reject' ? 'reject-option' : sel.mode === 'multiple' ? 'toggle-option' : 'option';
          var atMax = sel.mode === 'multiple' && !on && picked.length >= sel.max;
          return '<button type="button" class="opt" data-action="' + action + '" data-id="' + esc(f.id) + '" data-option="' + esc(o.id) + '"' +
            (toggle || on ? ' aria-pressed="' + (on ? 'true' : 'false') + '"' : '') + (atMax ? ' data-at-max' : '') + '>' +
            (toggle ? '<span class="opt-box" aria-hidden="true">✓</span>' : '') +
            '<span class="opt-text">' + esc(o.label) + (o.description ? '<span class="opt-desc">' + esc(o.description) + '</span>' : '') + '</span>' +
            (tag ? '<span class="opt-tag">' + esc(tag) + '</span>' : '') +
            (toggle ? '' : '<span class="opt-go" aria-hidden="true">›</span>') + '</button>';
        }).join('') + fieldErrorHtml(f.id, 'options', forAction) + '</div>';
    }

    function composerHtml(f) {
      var id = f.id;
      var c = choicesFor(f);
      var sel = c.selection;
      var draft = draftFor(f, 'reject');
      var value = ui.composer && ui.composer.id === id ? ui.composer.draft : '';
      var label = c.reject ? c.reject.label : 'Send back';
      var options = sel && (sel.requiredFor.reject || optionsFor(c, 'reject').some(function implied(o) { return o.implied === 'reject'; }))
        ? optionButtonsHtml(f, c, 'reject') : '';
      var answer = draft.answerNeeded ? textFieldHtml(id, 'answer', 'Your answer · required', ui.answers[id], c.answer.max) + fieldErrorHtml(id, 'answer', 'reject') : '';
      return '<div class="composer" data-composer="' + esc(id) + '">' + options + answer +
        '<label for="reason-' + esc(id) + '">What should change?' + (draft.reasonNeeded ? ' · required' : ' · optional') + '</label>' +
        '<textarea id="reason-' + esc(id) + '" data-reason="' + esc(id) + '" maxlength="' + TEXT_MAX + '" placeholder="Tell the agent what to fix or do instead."' +
        (ui.fieldErrors[id] && ui.fieldErrors[id].field === 'reason' && ui.fieldErrors[id].message ? ' aria-invalid="true"' : '') + '>' + esc(value) + '</textarea>' +
        fieldErrorHtml(id, 'reason', 'reject') +
        '<div class="composer-row"><button type="button" class="secondary-btn" data-action="cancel-sendback" data-id="' + esc(id) + '">Cancel</button>' +
        '<button type="button" class="secondary-btn" data-action="submit-sendback" data-id="' + esc(id) + '"' + (draft.missing.length ? ' disabled' : '') + '>' + esc(label) + '</button></div></div>';
    }

    function footerSpec(f) {
      var c = choicesFor(f);
      var sel = c.selection;
      if (!c.approve) return { heading: 'Decide here', detail: 'recorded in OrgX', primary: '', disabled: false };
      var draft = draftFor(f, 'approve');
      var ready = !draft.missing.length;
      var detail = ready ? 'recorded in OrgX' : missingCopy(draft, sel);
      if (sel && sel.mode === 'multiple') {
        var n = draft.picked.length;
        return { heading: n ? n + ' chosen' : 'Choose ' + rangeCopy(sel), detail: n || ready ? detail : 'recorded in OrgX', primary: c.approve.label === 'Confirm' && n ? 'Confirm ' + n : c.approve.label, disabled: !ready };
      }
      if (sel && !draft.picked.length && sel.requiredFor.approve) return { heading: 'Choose one', detail: 'recorded in OrgX', primary: '', disabled: false };
      if (sel && draft.picked.length) return { heading: 'You picked ' + optionLabel(f, draft.picked[0]), detail: detail, primary: c.approve.label, disabled: !ready };
      return { heading: 'Decide here', detail: detail, primary: c.approve.label, disabled: !ready };
    }
    function syncFooter(id) {
      var item = findItem(id);
      var footer = root.querySelector('ox-footer[data-id="' + id + '"]');
      if (item && footer && footer.getAttribute('state') === 'needs-you') {
        var spec = footerSpec(item);
        footer.setAttribute('heading', spec.heading);
        footer.setAttribute('detail', spec.detail);
        footer.setAttribute('primary-label', spec.primary);
        footer.toggleAttribute('disabled', spec.disabled);
      }
      var submit = root.querySelector('[data-action="submit-sendback"][data-id="' + id + '"]');
      if (submit && item) submit.disabled = draftFor(item, 'reject').missing.length > 0;
    }

    function footerFor(f) {
      var ruling = ui.rulings[f.id];
      if (ui.readState.phase !== 'idle' && (!ruling || ui.readState.focusId !== null)) {
        var failed = ui.readState.phase === 'failed';
        var opening = ui.readState.focusId !== null;
        return '<ox-footer variant="reads" state="' + (failed ? 'failed' : 'refreshing') + '" heading="' +
          (failed ? (opening ? 'Could not open decision' : 'Could not refresh decisions') : (opening ? 'Opening decision' : 'Refreshing decisions')) +
          '" detail="Showing the previous decision' + (failed ? '. Try again.' : ' while loading.') + '" data-read="' + ui.readState.phase + '" data-id="' + esc(f.id) + '"></ox-footer>';
      }
      if (ruling) {
        var approvedLabel = pastTense(ruling.approveLabel, 'approve');
        var rejectedLabel = pastTense(ruling.rejectLabel, 'reject');
        var settledApproved = /approv|accept|confirm|grant|allow/.test(ruling.status || '');
        var settledDeclined = /declin|reject|deni|denied|sent_back|cancel/.test(ruling.status || '');
        var frames = {
          saving: { state: 'saving', heading: ruling.action === 'approve' ? 'Recording your approval' : 'Recording it', detail: 'nothing else changes yet' },
          waiting: { state: 'waiting', heading: 'Recorded', detail: 'checking status in OrgX', action: 'Check now' },
          recorded: { state: 'stale', heading: 'Decision recorded', detail: 'Status is unconfirmed. Check the receipt before continuing.', action: 'Receipt ↗' },
          failed: { state: 'failed', heading: 'Could not continue', detail: 'OrgX reports the next step failed or was cancelled. Check the receipt.', action: 'Receipt ↗' },
          confirmed: { state: 'confirmed', heading: ruling.choice ? 'You chose ' + ruling.choice : approvedLabel + ' by you', detail: ruling.detail || 'the agent can continue', action: 'Receipt ↗' },
          rejected: { state: 'rejected', heading: rejectedLabel + ' by you', detail: ruling.detail || 'the agent reworks it', action: 'Receipt ↗' },
          elsewhere: settledApproved
            ? { state: 'confirmed', heading: 'Already approved in OrgX', detail: 'Check the recorded outcome in OrgX.', action: 'Receipt ↗' }
            : { state: 'rejected', heading: settledDeclined ? 'Already declined in OrgX' : 'Already settled in OrgX', detail: 'Check the recorded outcome in OrgX.', action: 'Receipt ↗' },
        };
        var fr = frames[ruling.phase] || frames.saving;
        return '<ox-footer variant="confirms-in-orgx" state="' + fr.state + '" heading="' + esc(fr.heading) + '" detail="' + esc(fr.detail) + '"' +
          (fr.action ? ' action-label="' + esc(fr.action) + '"' : '') + ' data-id="' + esc(f.id) + '"></ox-footer>';
      }
      if (ui.composer && ui.composer.id === f.id) return composerHtml(f);
      if (tokenFor(f.id)) {
        var c = choicesFor(f);
        var sendBack = c.reject
          ? '<button type="button" slot="action" class="ft-action" data-action="sendback" data-id="' + esc(f.id) + '">' + esc(c.reject.label) + '</button>'
          : '';
        var body = '';
        if (c.selection && c.approve) body += optionButtonsHtml(f, c, 'approve');
        var draft = c.approve ? draftFor(f, 'approve') : null;
        if (draft && draft.answerNeeded) {
          body += textFieldHtml(f.id, 'answer', 'Your answer · required', ui.answers[f.id], c.answer.max, 'Type the answer the agent needs to continue.') + fieldErrorHtml(f.id, 'answer', 'approve');
        }
        if (draft && draft.reasonNeeded) {
          var pickedLabel = draft.picked.length ? optionLabel(f, draft.picked[0]) : '';
          body += textFieldHtml(f.id, 'note', pickedLabel ? 'Why ' + pickedLabel + '? · required' : 'Why? · required', ui.notes[f.id], TEXT_MAX, 'One line on why this one.') + fieldErrorHtml(f.id, 'reason', 'approve');
        }
        body += fieldErrorHtml(f.id, 'form');
        var spec = footerSpec(f);
        return body + '<ox-footer variant="confirms-in-orgx" state="needs-you" heading="' + esc(spec.heading) + '" detail="' + esc(spec.detail) +
          '" primary-label="' + esc(spec.primary) + '"' + (spec.disabled ? ' disabled' : '') + ' data-id="' + esc(f.id) + '">' + sendBack + '</ox-footer>';
      }
      var reason = f.decide_in_orgx_reason;
      return '<button type="button" class="primary-btn" data-action="open" data-url="' + esc(f.url) + '">' +
        (reason === 'requester_cannot_approve' ? 'Open in OrgX' : 'Decide in OrgX') + ' <span aria-hidden="true">↗</span><span class="sr-only">(opens OrgX)</span></button>' +
        '<p class="handoff-detail">' + esc(decideInOrgxDetail(reason)) + '</p>';
    }

    function shareHtml(f) {
      if (!ui.caps.modelContext || ui.rulings[f.id]) return '';
      var current = share.shared;
      if (current && current.id === f.id) {
        if (current.version && current.version !== f.version) {
          return '<div class="share-row"><span>Chat has an older version</span><span aria-hidden="true">·</span>' +
            '<button type="button" class="text-btn" data-action="share" data-id="' + esc(f.id) + '">Update chat</button>' +
            '<button type="button" class="text-btn" data-action="stop-share">Stop sharing</button></div>';
        }
        return '<div class="share-row"><span>Shared with chat</span><span aria-hidden="true">·</span>' +
          '<button type="button" class="text-btn" data-action="stop-share">Stop sharing</button></div>';
      }
      return '<div class="share-row"><button type="button" class="text-btn" data-action="share" data-id="' + esc(f.id) + '">Share with chat</button></div>';
    }

    function actionErrorHtml(style) {
      var e = ui.actionError;
      return '<p class="error-line" role="alert"' + (style ? ' style="' + style + '"' : '') + '>' + esc(e.message) +
        (e.refresh ? ' <button type="button" class="text-btn" data-action="refresh">Refresh</button>' : '') + '</p>';
    }

    function packetHtml(f, headingTag) {
      var metaBits = [f.asker ? f.asker + ' asks' : '', f.kind === 'action' ? 'Action approval' : f.kind === 'approval' ? 'Agent run approval' : '', ago(f.waiting_since), f.initiative_title].filter(Boolean);
      var askerAvatar = Views ? '<span class="pn-asker" aria-hidden="true">' + Views.avatar(f.asker || '', 'inline') + '</span>' : '';
      var error = ui.actionError && ui.actionError.id === f.id ? actionErrorHtml() : '';
      var changed = ui.changedSince
        ? '<div class="notice" role="status"><p>Changed since ' + esc(ui.changedSince) + '</p></div>' : '';
      var facts = [];
      var head = splitHeadline(f.question);
      var body = structureBody(head.body);
      body.facts.forEach(function fact(x) {
        facts.push('<div class="fact"><dt>' + esc(x.k) + '</dt><dd>' + inline(x.v) + '</dd></div>');
      });
      if (f.recommendation && f.recommendation.action) {
        facts.push('<div class="fact"><dt>Recommendation</dt><dd>' + esc(f.recommendation.action) +
          (f.recommendation.status === 'unverified' ? ' <span class="sub">(unverified)</span>' : '') + '</dd></div>');
      } else if (f.recommendation && kindOf(f) === 'decision') {
        facts.push('<div class="fact"><dt>Recommendation</dt><dd class="quiet">No recommendation yet</dd></div>');
      }
      if (f.consequence_if_approved || body.ifApproved) {
        facts.push('<div class="fact"><dt>If approved</dt><dd>' + inline(f.consequence_if_approved || body.ifApproved) + '</dd></div>');
      }
      return '<section class="packet enter" aria-labelledby="pk-q">' + changed +
        '<p class="meta">' + askerAvatar + '<span class="urgency" data-u="' + esc(f.urgency) + '">' + esc(urgencyLabel(f.urgency)) + '</span>' +
        (f.blocked ? '<span aria-hidden="true">·</span><span class="blocked-tag">Blocking work</span>' : '') +
        (metaBits.length ? '<span aria-hidden="true">·</span><span class="meta-text" title="' + esc(metaBits.join(' · ')) + '">' + esc(metaBits.join(' · ')) + '</span>' : '<span class="meta-text"></span>') +
        (tokenFor(f.id) || ui.rulings[f.id] ? '<button type="button" class="ox-open" data-action="open" data-url="' + esc(f.url) + '" aria-label="Open this decision in OrgX">Open in OrgX</button>' : '') + '</p>' +
        '<' + headingTag + ' id="pk-q" tabindex="-1" class="q' + (ui.wholeQ === f.id ? ' is-whole' : '') + '">' + esc(head.headline) + '</' + headingTag + '>' +
        '<button type="button" class="q-more" data-action="whole-q" data-id="' + esc(f.id) + '" hidden>Show the whole question</button>' +
        (body.lede.length ? '<p class="q-body">' + inline(body.lede.join(' ')) + '</p>' : '') +
        body.commands.map(function cmd(c) { return '<div class="q-cmd"><span>Command</span><pre><code>' + esc(c) + '</code></pre></div>'; }).join('') +
        (facts.length ? '<dl class="facts">' + facts.join('') + '</dl>' : '') +
        evidenceHtml(f) +
        '<div class="actions">' + footerFor(f) + error + '</div>' +
        shareHtml(f) + (Launch && !ui.rulings[f.id] ? Launch.chipsHtml('packet', { title: head.headline }) : '') + '</section>';
    }

    function rowHtml(item) {
      var ruling = ui.rulings[item.id];
      var repeatedTitle = ui.snapshot.queue.some(function repeated(other) {
        return other.id !== item.id && splitHeadline(other.title).headline === splitHeadline(item.title).headline;
      });
      var meta = [urgencyLabel(item.urgency), ago(item.waiting_since), item.initiative_title].filter(Boolean).join(' · ');
      var acts = '';
      var opening = ui.readState.phase === 'loading' && ui.readState.focusId === item.id;
      if (ui.readState.phase !== 'idle') {
        acts = '<div class="row-acts"><button type="button" class="mini" data-action="select" data-id="' + esc(item.id) + '"' +
          (opening ? ' aria-disabled="true"' : '') + '>' + (opening ? 'Opening…' : 'Review') + '</button></div>';
      } else if (ruling) {
        var chip = ruling.phase === 'confirmed' ? 'confirmed' : ruling.phase === 'rejected' ? 'rejected' : ruling.phase === 'elsewhere' ? 'superseded' : ruling.phase === 'recorded' ? 'stale' : ruling.phase === 'failed' ? 'failed' : 'sending';
        var label = ruling.phase === 'confirmed' ? pastTense(ruling.approveLabel, 'approve')
          : ruling.phase === 'rejected' ? pastTense(ruling.rejectLabel, 'reject')
          : ruling.phase === 'elsewhere' ? 'Settled in OrgX' : ruling.phase === 'recorded' ? 'Check receipt' : ruling.phase === 'failed' ? 'Could not continue' : 'Recording';
        acts = '<div class="row-acts"><ox-state-chip state="' + chip + '" label="' + esc(label) + '"></ox-state-chip></div>';
      } else if (tokenFor(item.id) && (!quickDecide(item) || repeatedTitle)) {
        var c0 = choicesFor(item);
        var open = repeatedTitle ? 'Review' : c0.selection ? 'Choose' : c0.answer ? 'Answer' : 'Open';
        acts = '<div class="row-acts"><button type="button" class="mini approve" data-action="select" data-id="' + esc(item.id) + '" aria-label="' + esc(open + ': ' + item.title) + '">' + open + '</button></div>';
      } else if (tokenFor(item.id) && !(ui.composer && ui.composer.id === item.id)) {
        var c = choicesFor(item);
        acts = '<div class="row-acts">' +
          (c.reject ? '<button type="button" class="mini" data-action="sendback" data-id="' + esc(item.id) + '" aria-label="' + esc(c.reject.label + ': ' + item.title) + '">' + esc(c.reject.label) + '</button>' : '') +
          '<button type="button" class="mini approve" data-action="approve" data-id="' + esc(item.id) + '" aria-label="' + esc(c.approve.label + ': ' + item.title) + '">' + esc(c.approve.label) + '</button></div>';
      }
      var error = ui.actionError && ui.actionError.id === item.id ? actionErrorHtml('flex:1 1 100%') : '';
      var kindTag = item.kind === 'action' ? 'Action · ' : item.kind === 'approval' ? 'Run approval · ' : '';
      return '<li class="row" data-row="' + esc(item.id) + '"><button type="button" class="row-main" data-action="select" data-id="' + esc(item.id) + '"' + (opening ? ' aria-disabled="true"' : '') + ' aria-label="' + esc(item.title + '. ' + meta) + '">' +
        (Views ? '<span class="row-av" aria-hidden="true">' + Views.avatar(item.asker || '', 'row') + '</span>' : '') +
        '<span class="row-title">' + esc(splitHeadline(item.title).headline) + '</span><span class="row-meta"><span>' + esc(kindTag + meta) + '</span></span></button>' + acts +
        (ui.composer && ui.composer.id === item.id ? composerHtml(item) : '') + error + '</li>';
    }

    function proofHtml(s, calm) {
      var p = s.proof;
      var degradedProof = s.degraded.indexOf('proof_unavailable') !== -1;
      var html = '';
      if (p.last_accepted) {
        var who = p.last_accepted.accepted_by === 'you' ? 'accepted by you' : 'accepted by a workspace member';
        var when = agoLong(p.last_accepted.accepted_at);
        var acceptedAt = Date.parse(p.last_accepted.accepted_at || '');
        // A two-week-old acceptance is a signal to look, not a reason to relax.
        var stale = isFinite(acceptedAt) && Date.now() - acceptedAt > 14 * 86400 * 1000;
        html += '<ox-receipt-row status="' + (stale ? 'unverified' : 'met') + '" label="Last accepted: ' + esc(p.last_accepted.title) + '" detail="' + esc([who, when, stale ? 'nothing accepted since' : ''].filter(Boolean).join(' · ')) + '" href="' + esc(p.last_accepted.url) + '"></ox-receipt-row>';
      } else if (degradedProof) {
        html += '<p class="proof-quiet">Accepted work could not be read right now.</p>';
      } else if (calm) {
        html += '<p class="proof-quiet">No output has been accepted yet.</p>';
      }
      if (p.completed_unaccepted > 0) {
        html += '<p class="proof-sub">' + p.completed_unaccepted.toLocaleString() + (p.completed_unaccepted === 1 ? ' finished output waits' : ' finished outputs wait') + ' for acceptance' +
          ' <button type="button" class="text-btn" data-action="open" data-url="' + esc(window.OrgXLinks.workLedger()) + '">Review in OrgX ↗</button></p>';
      }
      return html ? '<div class="proof">' + html + '</div>' : '';
    }

    function skeletonHtml() {
      // Cold start: the header frame and the real OrgX mark revealing in the
      // space the content will take, so nothing shifts when data lands.
      var frame = ui.mode === 'global' ? '<header class="top"><span class="pn-mark-slot"></span><div class="top-id"><span class="brand">OrgX</span></div></header>' : '';
      var reveal = Brand ? Brand.bootHtml() : '<div aria-hidden="true"><span class="sk sk-line" style="width:56%;margin-top:16px"></span><span class="sk sk-title"></span><span class="sk sk-btn"></span></div>';
      return frame + reveal + '<p class="sr-only">Loading your decisions.</p>';
    }

    function signedOutHtml() {
      return header() + '<p class="lede">Sign in to OrgX to see your workspace.</p>' +
        '<p class="sub">' + esc(ui.auth && ui.auth.code === 'insufficient_scope'
          ? 'Reconnect OrgX and allow it to read your initiatives.'
          : 'Connect OrgX in ChatGPT, then open this panel again.') + '</p>' +
        '<button type="button" class="secondary-btn" data-action="open" data-url="' + ORGX_HOME + '">Open OrgX ↗</button>';
    }

    function loadErrorHtml() {
      return header() + '<div class="notice" data-tone="amber" role="status"><p>OrgX could not load your decisions. Try refreshing.</p>' +
        '<button type="button" class="text-btn" data-action="refresh">Refresh</button></div>';
    }

    function limitedHtml(tag) {
      return '<' + tag + ' class="lede">This item isn’t available here.</' + tag + '>' +
        '<p class="sub">It may be settled already, or it belongs to a workspace this account can’t open.</p>' +
        '<button type="button" class="secondary-btn" data-action="back">Back to decisions</button>';
    }

    function isFirstUse(s) {
      return s.attention.pending === 0 && !s.proof.last_accepted && !s.proof.completed_unaccepted &&
        s.degraded.indexOf('proof_unavailable') === -1;
    }

    function globalHtml(s) {
      var html = header() + noticeHtml();
      if (s.state === 'no_workspace') {
        return html + '<p class="lede">Choose a workspace in OrgX to see its decisions.</p>' +
          '<button type="button" class="secondary-btn" data-action="open" data-url="' + ORGX_HOME + '">Open OrgX ↗</button>';
      }
      if (s.state === 'degraded' && !s.queue.length) {
        return html + '<div class="notice" data-tone="amber" role="status"><p>The decision queue could not be loaded.</p>' +
          '<button type="button" class="text-btn" data-action="refresh">Refresh</button></div>' + proofHtml(s, false);
      }
      if (ui.limited || s.selection.status === 'unavailable') {
        return html + limitedHtml('p');
      }
      var calm = s.attention.pending === 0;
      var ctx = launchContext(s);
      if (ui.tab === 'work' && Views) {
        return html + Views.workHtml(ui.work, ui.workPhase, Launch ? Launch.sectionHtml(ui.work && ui.work.items.length ? 'work' : 'work-empty', ctx, { heading: 'Start or delegate work' }) : '');
      }
      if (ui.tab === 'done' && Views) {
        return html + Views.doneHtml({
          session: ui.session,
          openId: ui.openReceipt,
          proofHtml: proofHtml(s, false),
          launch: Launch ? Launch.sectionHtml('done', Object.assign({}, ctx, { title: ui.session[0] ? ui.session[0].title : '' }), { heading: 'Keep it moving', limit: 3 }) : '',
        }) + tipHtml(ctx, ['done']);
      }
      if (isFirstUse(s)) {
        return html + '<p class="lede">This workspace has no decisions or accepted work yet.</p>' +
          '<p class="sub">Start something: ask ChatGPT in plain words, and OrgX plans it, runs it and brings decisions back here.</p>' +
          (Launch ? Launch.sectionHtml('calm', ctx, { heading: 'Start your first initiative' }) : '') +
          '<button type="button" class="secondary-btn" data-action="open" data-url="' + ORGX_HOME + '">Open OrgX ↗</button>';
      }
      if (calm) return html + attentionLine(s) + proofHtml(s, true) + (Launch ? Launch.sectionHtml('calm', ctx) : '') + tipHtml(ctx, ['calm']);
      var others = s.queue.filter(function notFocus(item) { return !s.focus || item.id !== s.focus.id; });
      var hidden = Math.max(0, s.attention.pending - s.queue.length);
      html += '<div class="pn-split">' +
        '<div class="pn-att">' + attentionLine(s) + '</div>' +
        '<div class="pn-detail">' + (s.focus ? packetHtml(s.focus, 'h2') : '') + proofHtml(s, false) + '</div>' +
        (others.length ? '<div class="pn-list"><h2 class="queue-head">' + (s.focus ? 'Also waiting' : 'Waiting on you') + ' <span class="queue-n">' + others.length + '</span></h2><ul class="queue">' + others.map(rowHtml).join('') + '</ul>' +
          (hidden ? '<p class="sub">' + hidden + ' more in OrgX. <button type="button" class="text-btn" data-action="open" data-url="' + esc(window.OrgXLinks.decisions({ status: 'pending' })) + '">All decisions ↗</button></p>' : '') + '</div>' : '') +
        '</div>';
      return html;
    }

    function launchContext(s) {
      var initiative = null;
      (s && s.queue || []).some(function pick(item) { initiative = item.initiative_title || null; return Boolean(initiative); });
      return { initiative: initiative };
    }
    function tipHtml(ctx, shownKinds) {
      if (!Launch) return '';
      if (!ui.launchNoted) { ui.launchNoted = true; Launch.noteOpen(); }
      return Launch.tipHtml(ctx, shownKinds);
    }

    function threadHtml(s) {
      var html = noticeHtml();
      var syncLabel = esc(ui.syncedAt ? 'OrgX · synced ' + clock(ui.syncedAt) : 'OrgX');
      var foot = '<div class="thread-foot"><span class="sync">' + syncLabel + '</span>' +
        '<button type="button" class="quiet-btn" data-action="refresh">Refresh</button></div>';
      if (s.state === 'no_workspace') {
        return html + '<h1 class="lede">Choose a workspace in OrgX to see its decisions.</h1>' + foot;
      }
      if (s.state === 'degraded' && !s.queue.length) {
        return html + '<h1 class="lede">OrgX did not respond.</h1><p class="sub">Nothing was changed.</p>' + foot;
      }
      if (ui.limited || s.selection.status === 'unavailable') {
        return html + limitedHtml('h1') + foot;
      }
      if (ui.listOpen) {
        var rows = s.queue.length
          ? '<ul class="queue">' + s.queue.map(rowHtml).join('') + '</ul>'
          : '<p class="sub">Nothing needs your decision.</p>';
        return '<h1 class="lede">Choose an item</h1>' + html + rows +
          '<div class="thread-foot"><button type="button" class="quiet-btn" data-action="back">Back</button></div>';
      }
      if (!s.focus && isFirstUse(s)) {
        return '<h1 class="lede">This workspace has no decisions or accepted work yet.</h1>' + html +
          (Launch ? Launch.sectionHtml('calm', launchContext(s), { heading: 'Start your first initiative', limit: 3 }) : '') +
          '<button type="button" class="secondary-btn" data-action="open" data-url="' + ORGX_HOME + '">Open OrgX ↗</button>' + foot;
      }
      if (!s.focus) {
        return '<h1 class="lede">Nothing needs your decision.</h1>' + html + proofHtml(s, true) +
          (Launch ? Launch.sectionHtml('calm', launchContext(s), { limit: 3 }) : '') + foot;
      }
      html += packetHtml(s.focus, 'h1');
      if (s.queue.length > 1) {
        html += '<div class="thread-foot"><button type="button" class="text-btn choose" data-action="choose">Choose another item ›</button>' +
          '<span class="foot-sync"><span class="sync">' + syncLabel + '</span><button type="button" class="quiet-btn" data-action="refresh">Refresh</button></span></div>';
      } else {
        html += foot;
      }
      return html;
    }

    function toneFor(s) {
      if (!s || ui.auth || ui.limited || (s.selection && s.selection.status === 'unavailable')) return 'none';
      if (s.attention && s.attention.pending) return s.attention.blocking ? 'red' : 'amber';
      return s.state === 'ok' ? 'teal' : 'none';
    }

    function render() {
      var focusKey = document.activeElement && document.activeElement.getAttribute
        ? document.activeElement.getAttribute('data-action') + '|' + (document.activeElement.getAttribute('data-id') || '') +
          '|' + (document.activeElement.getAttribute('data-option') || '')
        : null;
      root.setAttribute('data-mode', ui.mode);
      if (ui.auth) {
        root.setAttribute('data-tone', 'none');
        root.innerHTML = signedOutHtml();
      } else if (!ui.snapshot) {
        root.setAttribute('data-tone', 'none');
        root.innerHTML = ui.readState.phase === 'failed' ? loadErrorHtml() : skeletonHtml();
      } else {
        root.setAttribute('data-tone', toneFor(ui.snapshot));
        root.innerHTML = ui.mode === 'thread' ? threadHtml(ui.snapshot) : globalHtml(ui.snapshot);
      }
      root.setAttribute('aria-busy', ui.readState.phase === 'loading' || (!ui.snapshot && !ui.auth && ui.readState.phase !== 'failed') ? 'true' : 'false');
      applyEvidenceClamp(false);
      fitRowActions();
      if (focusKey && focusKey !== 'null||') {
        var parts = focusKey.split('|');
        var selector = '[data-action="' + parts[0] + '"]' + (parts[1] ? '[data-id="' + parts[1] + '"]' : '') +
          (parts[2] ? '[data-option="' + (window.CSS && CSS.escape ? CSS.escape(parts[2]) : parts[2]) + '"]' : '');
        var again = root.querySelector(selector);
        if (again && again.focus) again.focus();
      }
      if (ui.composer) {
        var area = root.querySelector('textarea[data-reason="' + ui.composer.id + '"]');
        if (area && document.activeElement !== area && ui.composer.focus) {
          area.focus();
          ui.composer.focus = false;
        }
      }
      window.requestAnimationFrame(fitQuestion);
      if (R && R.reportSize) R.reportSize();
      if (tour) tour.refresh();
      maybeStartTour();
    }

    function ensureTour() {
      if (tour || !Tour) return tour;
      tour = Tour.create({
        root: root,
        go: function go(tab) { setTab(tab, true); },
        onEnd: function ended(reason) { setTab('needs', true); announce(reason === 'finished' ? 'Tour finished.' : 'Tour closed.'); },
        announce: announce,
      });
      return tour;
    }
    function startTour() {
      var t = ensureTour();
      if (t && !t.active()) t.start();
    }
    /**
     * First open only, on a real snapshot in the sidebar panel, with layout
     * (a hidden or headless frame has no width, so the tour never starts there).
     */
    function maybeStartTour() {
      if (ui.tourChecked || !Tour || ui.mode !== 'global' || ui.auth || !ui.snapshot || ui.snapshot.state !== 'ok') return;
      if (isGallery && params.get('tour') !== '1') return;
      if (!root.getBoundingClientRect().width) return;
      ui.tourChecked = true;
      if (Tour.seen() && !(isGallery && params.get('tour') === '1')) return;
      later(startTour, 600);
    }

    function setTab(tab, quiet) {
      if (['needs', 'work', 'done'].indexOf(tab) === -1) return;
      var changed = ui.tab !== tab;
      ui.tab = tab;
      ui.composer = changed ? null : ui.composer;
      if (tab === 'work' && (!ui.work || ui.workPhase === 'failed')) { fetchWork(); return; }
      render();
      if (changed && !quiet) {
        var t = root.querySelector('#pn-tab-' + tab);
        if (t) t.focus();
        announce(tab === 'needs' ? 'Needs you.' : tab === 'work' ? 'In progress.' : 'Done.');
      }
    }

    /** In progress is read only when opened: the same snapshot with view "work". */
    function fetchWork() {
      if (isGallery) {
        ui.work = galleryWork();
        ui.workPhase = 'ready';
        render();
        return;
      }
      if (ui.workPhase === 'loading') return;
      ui.workPhase = 'loading';
      render();
      var gen = ui.generation;
      var args = { view: 'work' };
      var s = ui.snapshot;
      if (s && s.selection.status === 'selected' && s.focus) args.focus = { type: 'decision', id: s.focus.id };
      R.callToolResult('orgx_panel_snapshot', args).then(function onWork(result) {
        if (gen !== ui.generation) return;
        var data = result && result.data;
        if (isSnapshot(data)) accept(data, result.meta || null, 'refresh');
        ui.work = data && data.work ? data.work : { status: 'unavailable', items: [], total: 0 };
        ui.workPhase = 'ready';
        render();
      }, function onWorkError() {
        if (gen !== ui.generation) return;
        ui.workPhase = 'failed';
        render();
      });
    }

    /** One receipt per settled decision this panel session (newest first). */
    function remember(id) {
      var r = ui.rulings[id];
      if (!r) return;
      var item = findItem(id);
      var entry = {
        id: id,
        title: splitHeadline(r.title || '').headline || 'Decision',
        action: r.action,
        verb: r.action === 'approve' ? pastTense(r.approveLabel, 'approve') : pastTense(r.rejectLabel, 'reject'),
        phase: r.phase,
        detail: r.detail || '',
        at: clock(new Date()),
        url: item && item.url ? item.url : window.OrgXLinks.decision(id),
      };
      var existing = ui.session.filter(function same(e) { return e.id === id; })[0];
      if (existing) { existing.phase = entry.phase; existing.detail = entry.detail; existing.verb = entry.verb; }
      else ui.session.unshift(entry);
    }

    function launchPrompt(button) {
      if (!Launch) return;
      var text = button.getAttribute('data-prompt');
      if (!text) return;
      var status = button.querySelector('.pn-prompt-s');
      button.setAttribute('aria-busy', 'true');
      Launch.send(text).then(function sent(outcome) {
        button.removeAttribute('aria-busy');
        var copy = outcome === 'sent' ? 'Sent to chat' : outcome === 'copied' ? 'Copied. Paste it into the chat.' : 'Couldn’t send. Type it in the chat.';
        button.setAttribute('data-sent', outcome);
        if (status) status.textContent = copy;
        announce(copy);
        later(function clear() { if (button.isConnected) { button.removeAttribute('data-sent'); if (status) status.textContent = ''; } }, 2600);
      });
    }

    function galleryWork() {
      return {
        status: 'ok',
        total: 4,
        items: [
          { id: 'w1', agent: 'Dana', title: 'Design plan for OrgX Live', state: 'blocked', url: window.OrgXLinks.live() },
          { id: 'w2', agent: 'Eli', title: 'Reconcile launch telemetry fields', state: 'running', url: window.OrgXLinks.live() },
          { id: 'w3', agent: 'Mark', title: 'Pricing page copy, variant B', state: 'running', url: window.OrgXLinks.live() },
          { id: 'w4', agent: 'Sage', title: 'ICP list for founder-led SaaS', state: 'queued', url: window.OrgXLinks.live() },
        ],
      };
    }
    function fitQuestion() {
      var q = root.querySelector('#pk-q');
      var more = root.querySelector('.q-more');
      if (!q || !more || q.classList.contains('is-whole') || !q.clientHeight) return;
      var over = q.scrollHeight - q.clientHeight;
      var line = parseFloat(getComputedStyle(q).lineHeight) || 22;
      if (over > 2 && over <= line * 1.25) q.classList.add('is-whole');
      more.hidden = !(over > line * 1.25);
    }
    window.addEventListener('resize', function onResize() { window.requestAnimationFrame(fitQuestion); });

    function accept(snapshot, meta, source) {
      if (!isSnapshot(snapshot)) return false;
      var prev = ui.snapshot;
      var scopeChanged = prev && (prev.workspace && prev.workspace.id) !== (snapshot.workspace && snapshot.workspace.id);
      if (scopeChanged) { resetScope(); prev = null; }
      if (prev && Date.parse(snapshot.generated_at) < Date.parse(prev.generated_at)) return false;
      if (prev && prev.focus && snapshot.focus && prev.focus.id === snapshot.focus.id &&
          prev.focus.version !== snapshot.focus.version && source === 'refresh') {
        ui.changedSince = clock(ui.syncedAt);
      } else if (source === 'refresh') {
        ui.changedSince = null;
      }
      ui.snapshot = snapshot;
      ui.syncedAt = new Date(snapshot.generated_at);
      ui.auth = null;
      if (ui.readState.phase === 'failed') ui.readState = { phase: 'idle' };
      ui.limited = false;
      if (meta !== undefined) adoptTokens(meta);
      Object.keys(ui.rulings).forEach(function prune(id) {
        var r = ui.rulings[id];
        if (!findItem(id) && (r.phase === 'confirmed' || r.phase === 'rejected' || r.phase === 'elsewhere')) {
          ui.lastRuling = {
            action: r.action, title: r.title, elsewhere: r.phase === 'elsewhere',
            verb: r.phase === 'confirmed' ? pastTense(r.approveLabel, 'approve') : r.phase === 'rejected' ? pastTense(r.rejectLabel, 'reject') : '',
          };
          delete ui.rulings[id];
        }
      });
      evaluateHints();
      return true;
    }

    function authFailure(error) {
      var code = error && (error.code || (error.error && error.error.code));
      return code === 'authentication_required' || code === 'insufficient_scope' ? code : null;
    }

    function fetchSnapshot(focusId, reason) {
      focusId = focusId || null;
      ui.readState = window.OrgXPanelState.readTransition(ui.readState, { type: 'requested', focusId: focusId });
      render();
      announce(focusId ? 'Opening decision.' : 'Refreshing decisions.');
      if (inflight) {
        pendingFocus = focusId;
        return inflight;
      }
      var gen = ui.generation;
      var args = focusId ? { focus: { type: 'decision', id: focusId } } : {};
      lastFocusRequest = focusId || null;
      var request = R.callToolResult('orgx_panel_snapshot', args).then(function onResult(result) {
        if (gen !== ui.generation || (pendingFocus !== undefined && pendingFocus !== focusId)) return;
        ui.readState = window.OrgXPanelState.readTransition(ui.readState, { type: 'completed', focusId: focusId });
        if (accept(result.data, result.meta || null, 'refresh')) {
          if (reason === 'refresh') announce('Refreshed. ' + summaryText());
        } else {
          ui.readState = window.OrgXPanelState.readTransition(ui.readState, { type: 'failed', focusId: focusId });
          announce('The latest snapshot could not be loaded. Try refreshing.');
        }
        render();
      }, function onError(error) {
        if (gen !== ui.generation || (pendingFocus !== undefined && pendingFocus !== focusId)) return;
        var auth = authFailure(error && error.result ? error.result : error);
        if (auth) {
          resetScope();
          ui.snapshot = null;
          ui.auth = { code: auth };
        } else {
          ui.readState = window.OrgXPanelState.readTransition(ui.readState, { type: 'failed', focusId: focusId });
          announce('OrgX did not respond. Showing the last snapshot.');
        }
        render();
      }).then(function release() {
        if (inflight === request) inflight = null;
        if (gen !== ui.generation) return;
        if (pendingFocus !== undefined) {
          var next = pendingFocus;
          pendingFocus = undefined;
          if (next !== lastFocusRequest) fetchSnapshot(next, 'select');
        }
      });
      inflight = request;
      return request;
    }

    function summaryText() {
      var s = ui.snapshot;
      if (!s) return '';
      var n = s.attention.pending;
      return n ? n + (n === 1 ? ' needs' : ' need') + ' your decision.' : 'Nothing needs your decision.';
    }

    function selectDecision(id) {
      if (ui.readState.phase === 'loading' && ui.readState.focusId === id) return;
      ui.listOpen = false;
      ui.evidenceOpen = false;
      ui.composer = null;
      ui.actionError = null;
      ui.limited = false;
      var s = ui.snapshot;
      if (s && s.focus && s.focus.id === id && ui.readState.phase === 'idle') { render(); return; }
      if (isGallery) {
        var item = findItem(id);
        if (item) s.focus = Object.assign({}, s.focus || {}, galleryFocus(item));
        render();
        return;
      }
      fetchSnapshot(id, 'select');
    }

    function evaluateHints() {
      var s = ui.snapshot;
      if (!s || !s.workspace || isGallery) return;
      if (ext.deepLink) {
        var link = ext.deepLink.getCurrent();
        var url = link && link.url;
        if (url && url !== handledHint.deepLink) {
          handledHint.deepLink = url;
          var target = X.parsePanelDeepLink(url);
          if (target && target.type === 'decision') {
            ui.mode = 'thread';
            if (!(s.focus && s.focus.id === target.id)) fetchSnapshot(target.id, 'deeplink');
          }
        }
      }
      if (ext.modelContext) {
        var current = ext.modelContext.getCurrent();
        var key = current && current.updateId ? current.updateId : null;
        if (key && key !== handledHint.context) {
          handledHint.context = key;
          var restored = X.readSharedSelection(current, s.workspace.id);
          share.restore(restored, s.workspace.id);
          if (restored && restored.status === 'mismatch') {
            ui.mode = 'thread';
            ui.limited = true;
          } else if (restored && restored.status === 'match') {
            ui.mode = 'thread';
            if (!(s.focus && s.focus.id === restored.entity.id)) fetchSnapshot(restored.entity.id, 'restore');
          }
        }
      }
    }

    function onHostContext(context, app) {
      if (!app) return;
      ext = X.createExtensions(app);
      ui.caps = { modelContext: Boolean(ext.modelContext), deepLink: Boolean(ext.deepLink) };
      var keep = share.shared;
      share = X.createShareController({ modelContext: ext.modelContext });
      if (keep) share.restore({ status: 'match', entity: { id: keep.id, version: keep.version } }, keep.workspaceId);
      evaluateHints();
      render();
    }

    function wait(ms) {
      return new Promise(function resolveLater(resolve) { later(resolve, ms); });
    }

    function pollStatus(id, gen) {
      var attempts = 0;
      function once() {
        var ruling = ui.rulings[id];
        if (gen !== ui.generation || !ruling || window.OrgXPanelState.isFinalRuling(ruling.phase)) return Promise.resolve(null);
        return R.callTool('orgx_command_status', { kind: 'decision', id: id }).then(function onStatus(status) {
          if (gen !== ui.generation || !ui.rulings[id] || window.OrgXPanelState.isFinalRuling(ui.rulings[id].phase)) return null;
          status = R.extractStructuredWidgetData(status, true);
          var transition = window.OrgXPanelState.statusTransition(status, id, ui.rulings[id].action);
          if (transition.phase === 'waiting' && attempts < 12) {
            attempts += 1;
            return wait(transition.next).then(once);
          }
          return status;
        });
      }
      return once();
    }

    var VALIDATION_CODES = ['reason_required', 'answer_required', 'answer_not_accepted', 'option_required', 'options_not_accepted',
      'option_unavailable', 'option_action_mismatch', 'selection_out_of_range', 'invalid_decision_option_material'];
    var VALIDATION_COPY = {
      reason_required: 'Say what should change.',
      answer_required: 'Type an answer to send.',
      answer_not_accepted: 'This one no longer takes an answer. Decide with the buttons.',
      option_required: 'Choose an option first.',
      options_not_accepted: 'The options changed. Choose again.',
      option_unavailable: 'That option is no longer available. Choose again.',
      option_action_mismatch: 'That option goes with the other button.',
      selection_out_of_range: 'Choose a number of options the decision allows.',
      invalid_decision_option_material: 'That choice is not valid for this decision. Choose again.',
    };
    var STALE_COPY = {
      widget_approval_token_expired: 'This view is out of date. Refresh to decide.',
      widget_approval_token_invalid: 'This view is out of date. Refresh to decide.',
      widget_view_out_of_date: 'This view is out of date. Refresh to decide.',
      widget_decision_conflict: 'Changed since you opened it',
      widget_decision_not_found: 'No longer open here. It may be settled or moved.',
    };
    var IN_ORGX_CODES = {
      widget_approval_ineligible: '',
      widget_approval_disabled: 'widget_approvals_disabled',
      action_authority_denied: 'action_authority_denied',
      widget_approval_token_mismatch: 'token_mismatch',
      widget_decision_lifecycle_required: 'lifecycle_required',
    };
    function refusalCopy(error, fallback) {
      var message = error && typeof error.message === 'string' ? error.message.trim() : '';
      return message && !/tool request failed|tool execution failed/i.test(message) && message.length <= 160 ? message : fallback;
    }
    function eachCopy(id, fn) {
      var s = ui.snapshot;
      if (!s) return;
      if (s.focus && s.focus.id === id) fn(s.focus);
      s.queue.forEach(function each(item) { if (item.id === id) fn(item); });
    }
    function pruneDrafts(id) {
      var item = findItem(id);
      if (!item) return;
      var c = choicesFor(item);
      var ids = c.selection ? c.selection.options.map(function oid(o) { return o.id; }) : [];
      ui.selections[id] = selectedFor(id).filter(function keep(oid) { return ids.indexOf(oid) !== -1; });
      if (ui.rejectPicks[id] && ids.indexOf(ui.rejectPicks[id]) === -1) delete ui.rejectPicks[id];
      if (!c.answer) delete ui.answers[id];
    }

    function rule(id, action) {
      if (tour && tour.active()) {
        // The tour's practice press never reaches OrgX.
        if (tour.isPractice()) tour.practice(root.querySelector('ox-footer[data-id="' + id + '"]'));
        return;
      }
      if (ui.rulings[id] || ui.readState.phase !== 'idle') return;
      var token = tokenFor(id);
      var item = findItem(id);
      if (!token || !item) {
        ui.actionError = { id: id, message: 'This one has to be decided in OrgX.' };
        render();
        return;
      }
      var c = choicesFor(item);
      var draft = draftFor(item, action);
      if (draft.missing.length) { syncFooter(id); return; }
      var gen = ui.generation;
      var title = item.title || item.question || 'Decision';
      var note = action === 'reject' && ui.composer && ui.composer.id === id ? ui.composer.draft : '';
      var choice = action === 'approve' && draft.picked.length
        ? draft.picked.map(function label(oid) { return optionLabel(item, oid); }).filter(Boolean).join(', ')
        : null;
      ui.actionError = null;
      delete ui.fieldErrors[id];
      ui.composer = null;
      ui.rulings[id] = {
        action: action, phase: 'saving', title: title, choice: choice || null, kind: c.kind,
        approveLabel: c.approve ? c.approve.label : '', rejectLabel: c.reject ? c.reject.label : '',
      };
      delete ui.tokens[id]; // spent here; a refusal that leaves the item open hands it back
      render();
      var args = Object.assign({ decision_id: id, action: action, approval_token: token }, draft.args);
      function doneDetail(status) {
        if (!status) return 'recorded; status not available yet';
        if (c.kind === 'action') return action === 'approve' ? 'the action can run' : 'the action does not run';
        if (c.kind === 'approval') return action === 'approve' ? 'the run continues' : 'the run stops at this step';
        return action === 'approve' ? 'the agent can continue' : 'the agent reworks it';
      }
      function settle(status) {
        if (gen !== ui.generation || !ui.rulings[id]) return;
        if (window.OrgXPanelState.isFinalRuling(ui.rulings[id].phase)) return;
        var transition = c.kind === 'decision' ? window.OrgXPanelState.statusTransition(status, id, action)
          : { phase: action === 'approve' ? 'confirmed' : 'rejected' };
        ui.rulings[id].phase = transition.phase === 'waiting' ? 'recorded' : transition.phase;
        if (transition.status) ui.rulings[id].status = transition.status;
        ui.rulings[id].detail = doneDetail(status);
        remember(id);
        if (['recorded', 'failed', 'elsewhere'].indexOf(ui.rulings[id].phase) !== -1) {
          announce(ui.rulings[id].phase === 'recorded' ? 'Decision recorded. Status is unconfirmed.' : 'Check the recorded outcome in OrgX.');
          render();
          return;
        }
        delete ui.answers[id];
        delete ui.notes[id];
        announce(pastTense(action === 'approve' ? ui.rulings[id].approveLabel : ui.rulings[id].rejectLabel, action) + ': ' + title);
        render();
        later(function refreshAfterRuling() { fetchSnapshot(null, 'ruling'); }, 900);
      }
      R.callTool('orgx_widget_decide', args).then(function onDecided(result) {
        if (gen !== ui.generation) return;
        if (c.kind !== 'decision') {
          // Agent-run approvals and actions settle in the call itself; there is no decision status to read.
          var data = R.extractStructuredWidgetData ? R.extractStructuredWidgetData(result, true) : null;
          settle({ state: 'succeeded', status: data && data.status });
          return;
        }
        ui.rulings[id].phase = 'waiting';
        render();
        // The ruling is recorded. A status read that fails does not undo it.
        pollStatus(id, gen).then(settle, function statusUnavailable() { settle(null); });
      }, function onFailed(error) {
        if (gen !== ui.generation) return;
        var code = errorKind(error);
        var details = error && error.details && typeof error.details === 'object' ? error.details : {};
        delete ui.rulings[id];
        if (VALIDATION_CODES.indexOf(code) !== -1) {
          // Still open, same token: put the message on the field and render the item's current contract.
          ui.tokens[id] = token;
          if (details.widget_actions && typeof details.widget_actions === 'object') {
            eachCopy(id, function adopt(copy) { copy.widget_actions = details.widget_actions; });
            pruneDrafts(id);
          }
          var field = code === 'reason_required' ? 'reason' : code === 'answer_required' ? 'answer' : code === 'answer_not_accepted' ? 'form' : 'options';
          ui.fieldErrors[id] = { action: action, field: field, message: refusalCopy(error, VALIDATION_COPY[code]) };
          if (action === 'reject') ui.composer = { id: id, draft: note, focus: field === 'reason', opener: id };
          render();
          return;
        }
        if (STALE_COPY[code]) {
          ui.actionError = { id: id, message: STALE_COPY[code], refresh: true };
          render();
          return;
        }
        if (code === 'decision_already_resolved') {
          ui.rulings[id] = { action: action, phase: 'elsewhere', title: title, status: String(details.status || '').toLowerCase() };
          remember(id);
          announce('Already settled in OrgX: ' + title);
          render();
          if (!isGallery) fetchSnapshot(null, 'refresh');
          return;
        }
        if (Object.prototype.hasOwnProperty.call(IN_ORGX_CODES, code)) {
          var reason = code === 'widget_approval_ineligible' ? String(details.reason || '') : IN_ORGX_CODES[code];
          eachCopy(id, function mark(copy) { copy.decide_in_orgx_reason = reason || copy.decide_in_orgx_reason || 'lifecycle_required'; });
          render();
          return;
        }
        if (code === 'tool_unavailable') {
          ui.chatCannotDecide = true;
          ui.tokens = {};
          eachCopy(id, function mark(copy) { copy.decide_in_orgx_reason = copy.decide_in_orgx_reason || 'chat_unavailable'; });
          announce('Not sent. This chat can’t settle it right now; decide it in OrgX.');
          render();
          return;
        }
        ui.actionError = {
          id: id,
          message: code === 'network'
            ? 'The response was lost. Refresh to check whether OrgX recorded this decision.'
            : safeErrorText(error, 'OrgX could not confirm this decision. Refresh to check the recorded outcome.'),
          refresh: true,
        };
        render();
        // The token was spent; a fresh snapshot brings a new one.
        if (!isGallery) fetchSnapshot(ui.snapshot && ui.snapshot.selection.status === 'selected' && ui.snapshot.focus ? ui.snapshot.focus.id : null, 'refresh');
      });
    }

    function chooseOption(id, optionId) {
      var item = findItem(id);
      if (!item || ui.rulings[id]) return;
      var c = choicesFor(item);
      var option = optionById(item, optionId);
      if (!option) return;
      if (option.implied === 'reject') {
        ui.rejectPicks[id] = optionId;
        if (!c.reject) return;
        if (!draftFor(item, 'reject').missing.length) { rule(id, 'reject'); return; }
        ui.composer = { id: id, draft: '', focus: true, opener: id };
        render();
        return;
      }
      if (!c.approve) return;
      var already = selectedFor(id)[0] === optionId;
      ui.selections[id] = already ? [] : [optionId];
      if (!already && !draftFor(item, 'approve').missing.length) { rule(id, 'approve'); return; }
      render();
      if (!already) focusFirst('textarea[data-field][data-id="' + id + '"]');
    }

    function checkNow(id) {
      if (!ui.rulings[id] || window.OrgXPanelState.isFinalRuling(ui.rulings[id].phase)) return;
      var gen = ui.generation;
      R.callTool('orgx_command_status', { kind: 'decision', id: id }).then(function onStatus(status) {
        if (gen !== ui.generation || !ui.rulings[id] || window.OrgXPanelState.isFinalRuling(ui.rulings[id].phase)) return;
        status = R.extractStructuredWidgetData(status, true);
        var transition = window.OrgXPanelState.statusTransition(status, id, ui.rulings[id].action);
        ui.rulings[id].phase = transition.phase;
        if (transition.status) ui.rulings[id].status = transition.status;
        remember(id);
        render();
      }, function ignore() { /* the poll keeps running */ });
    }

    function doShare(id) {
      var item = findItem(id);
      var ws = workspaceId();
      if (!item || !ws) return;
      var gen = ui.generation;
      share.share({ id: item.id, version: item.version, title: item.title || item.question, urgency: item.urgency, url: item.url }, ws)
        .then(function shared() { if (gen === ui.generation) { announce('Shared with chat.'); render(); } },
          function failed() { if (gen === ui.generation) { ui.actionError = { id: id, message: 'Could not share with chat.' }; render(); } });
    }
    function stopShare() {
      share.stop(workspaceId()).then(function stopped() { announce('Stopped sharing.'); render(); },
        function failed() { render(); });
    }

    function openUrl(url, event) {
      url = window.OrgXLinks.normalize(url);
      if (!url) return;
      if (isGallery) return;
      R.openWidgetLink(url, event);
    }

    root.addEventListener('click', function onClick(event) {
      var el = event.target.closest('[data-action]');
      if (!el || !root.contains(el) || el.disabled) return;
      var action = el.getAttribute('data-action');
      var id = el.getAttribute('data-id');
      // During the tour only the practice press is live; picks and send-back wait.
      if (tour && tour.active() && ['approve', 'option', 'toggle-option', 'reject-option', 'sendback', 'submit-sendback'].indexOf(action) !== -1) return;
      switch (action) {
        case 'refresh': fetchSnapshot(ui.snapshot && ui.snapshot.selection.status === 'selected' && ui.snapshot.focus ? ui.snapshot.focus.id : null, 'refresh'); break;
        case 'open': event.preventDefault(); openUrl(el.getAttribute('data-url'), event); break;
        case 'select': selectDecision(id); break;
        case 'approve': approve(id); break;
        case 'option': chooseOption(id, el.getAttribute('data-option')); break;
        case 'toggle-option': toggleOption(id, el.getAttribute('data-option')); break;
        case 'reject-option': pickRejectOption(id, el.getAttribute('data-option')); break;
        case 'sendback': ui.composer = { id: id, draft: '', focus: true, opener: id }; ui.actionError = null; render(); break;
        case 'cancel-sendback': closeComposer(); break;
        case 'submit-sendback': {
          var area = root.querySelector('textarea[data-reason="' + id + '"]');
          if (ui.composer && ui.composer.id === id && area) ui.composer.draft = area.value;
          rule(id, 'reject');
          break;
        }
        case 'evidence': toggleEvidence(!ui.evidenceOpen); break;
        case 'whole-q': ui.wholeQ = id; render(); focusFirst('#pk-q'); break;
        case 'choose': ui.listOpen = true; render(); focusFirst('.row-main'); break;
        case 'back':
          ui.listOpen = false;
          if (ui.limited || (ui.snapshot && ui.snapshot.selection.status === 'unavailable')) {
            ui.limited = false;
            if (!isGallery) fetchSnapshot(null, 'back');
            else if (ui.snapshot) { ui.snapshot.selection = { requested_id: null, status: 'default' }; render(); }
          } else {
            render();
          }
          break;
        case 'share': doShare(id); break;
        case 'stop-share': stopShare(); break;
        case 'tab': setTab(el.getAttribute('data-tab')); break;
        case 'launch': launchPrompt(el); break;
        case 'tip-dismiss': if (Launch) Launch.noteDismiss(); render(); focusFirst('[data-action="tab"][aria-selected="true"]'); break;
        case 'tour': startTour(); break;
        case 'work-retry': ui.workPhase = 'failed'; fetchWork(); break;
        case 'receipt': ui.openReceipt = ui.openReceipt === id ? null : id; render(); focusFirst('[data-action="receipt"][data-id="' + id + '"]'); break;
        default: break;
      }
    });

    root.addEventListener('input', function onInput(event) {
      var area = event.target;
      if (!area || !area.matches) return;
      var id = null;
      if (area.matches('textarea[data-reason]')) {
        id = area.getAttribute('data-reason');
        if (ui.composer && ui.composer.id === id) ui.composer.draft = area.value;
        if (ui.fieldErrors[id] && ui.fieldErrors[id].field === 'reason') clearFieldError(id);
      } else if (area.matches('textarea[data-field]')) {
        id = area.getAttribute('data-id');
        var field = area.getAttribute('data-field');
        if (field === 'answer') ui.answers[id] = area.value;
        if (field === 'note') ui.notes[id] = area.value;
        var err = ui.fieldErrors[id];
        if (err && (err.field === field || (field === 'note' && err.field === 'reason'))) clearFieldError(id);
      }
      if (id) syncFooter(id);
    });
    function clearFieldError(id) {
      if (ui.fieldErrors[id]) ui.fieldErrors[id].message = '';
      Array.prototype.forEach.call(root.querySelectorAll('[data-error-for="' + id + '"]'), function drop(node) { node.remove(); });
      Array.prototype.forEach.call(root.querySelectorAll('textarea[aria-invalid][data-id="' + id + '"], textarea[aria-invalid][data-reason="' + id + '"]'), function valid(node) { node.removeAttribute('aria-invalid'); });
    }

    root.addEventListener('ox-primary', function onPrimary(event) {
      var footer = event.target.closest('ox-footer');
      var id = footer && footer.getAttribute('data-id');
      if (!id || footer.getAttribute('state') !== 'needs-you') return;
      rule(id, 'approve');
    });

    function approve(id) {
      rule(id, 'approve');
    }
    function toggleOption(id, optionId) {
      var item = findItem(id);
      if (!item || ui.rulings[id]) return;
      var sel = choicesFor(item).selection;
      if (!sel) return;
      var current = selectedFor(id);
      var next = current.indexOf(optionId) === -1 ? current.concat(optionId) : current.filter(function keep(x) { return x !== optionId; });
      if (next.length > sel.max) return;
      ui.selections[id] = sel.options.map(function ids(o) { return o.id; })
        .filter(function picked(oid) { return next.indexOf(oid) !== -1; });
      if (ui.fieldErrors[id] && ui.fieldErrors[id].field === 'options') delete ui.fieldErrors[id];
      render();
    }
    function pickRejectOption(id, optionId) {
      var item = findItem(id);
      if (!item || ui.rulings[id]) return;
      var sel = choicesFor(item).selection;
      if (sel && sel.mode === 'multiple') { toggleOption(id, optionId); return; }
      ui.rejectPicks[id] = ui.rejectPicks[id] === optionId ? '' : optionId;
      if (ui.fieldErrors[id] && ui.fieldErrors[id].field === 'options') delete ui.fieldErrors[id];
      render();
    }
    root.addEventListener('ox-action', function onFooterAction(event) {
      var footer = event.target.closest('ox-footer');
      var id = footer && footer.getAttribute('data-id');
      if (!id) return;
      var detail = event.detail || {};
      if (footer.hasAttribute('data-read')) { if (detail.action === 'retry') fetchSnapshot(ui.readState.focusId, 'select'); return; }
      if (detail.action === 'check_now') checkNow(id);
      else if (detail.action === 'receipt') { var item = findItem(id); openUrl(item ? item.url : window.OrgXLinks.decision(id)); }
    });
    root.addEventListener('ox-open', function onReceiptOpen(event) {
      event.preventDefault();
      openUrl(event.detail && event.detail.href);
    });

    function closeComposer() {
      var opener = ui.composer && ui.composer.opener;
      ui.composer = null;
      render();
      var back = opener ? root.querySelector('[data-action="sendback"][data-id="' + opener + '"]') : null;
      if (back) back.focus();
    }
    function focusFirst(selector) {
      var el = root.querySelector(selector);
      if (el) el.focus();
    }

    document.addEventListener('keydown', function onKey(event) {
      var tabEl = event.target && event.target.closest ? event.target.closest('.pn-tab') : null;
      if (tabEl && (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End')) {
        var order = ['needs', 'work', 'done'];
        var at = order.indexOf(tabEl.getAttribute('data-tab'));
        var next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
        event.preventDefault();
        setTab(order[next]);
        return;
      }
      if (event.key !== 'Escape') return;
      if (ui.composer) { event.preventDefault(); closeComposer(); return; }
      if (ui.evidenceOpen) {
        event.preventDefault();
        toggleEvidence(false);
        focusFirst('[data-action="evidence"]');
        return;
      }
      if (ui.listOpen) {
        event.preventDefault();
        ui.listOpen = false;
        render();
        focusFirst('[data-action="choose"]');
      }
    });

    function dispose() {
      ui.generation += 1;
      timers.forEach(function clear(id) { window.clearTimeout(id); });
      timers = [];
    }
    function resetScope() {
      dispose();
      inflight = null; pendingFocus = undefined; lastFocusRequest = null;
      ui.readState = { phase: 'idle' };
      ui.tokens = {}; ui.rulings = {}; ui.lastRuling = null; ui.composer = null;
      ui.selections = {}; ui.rejectPicks = {}; ui.answers = {}; ui.notes = {}; ui.fieldErrors = {};
      ui.actionError = null; ui.changedSince = null; ui.chatCannotDecide = false;
      ui.listOpen = false; ui.evidenceOpen = false; ui.wholeQ = null;
      ui.tab = 'needs'; ui.work = null; ui.workPhase = 'idle'; ui.session = []; ui.openReceipt = null;
      share = X.createShareController({ modelContext: ext.modelContext });
      handledHint = { deepLink: null, context: null };
    }
    window.addEventListener('pagehide', dispose);
    window.addEventListener('pageshow', function resume(event) {
      if (!event.persisted || isGallery) return;
      // A restored page must read current state; it must never replay a ruling.
      Object.keys(ui.rulings).forEach(function uncertain(id) {
        if (ui.rulings[id].phase === 'saving' || ui.rulings[id].phase === 'waiting') ui.rulings[id].phase = 'recorded';
      });
      inflight = null; pendingFocus = undefined;
      ui.readState = { phase: 'idle' };
      // A work read dropped by the page cache must not leave In progress loading forever.
      if (ui.workPhase === 'loading') ui.workPhase = ui.work ? 'ready' : 'idle';
      render();
      fetchSnapshot(null, 'resume');
      if (ui.tab === 'work' && !ui.work) fetchWork();
    });

    var NOW = Date.now();
    function isoAgo(ms) { return new Date(NOW - ms).toISOString(); }
    var H = 3600 * 1000;
    var D = 24 * H;
    var IDS = {
      ws: '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
      init: 'c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f',
      d1: '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c',
      d2: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
      d3: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
      art: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
    };
    function decisionUrl(id) { return window.OrgXLinks.decision(id); }
    var FIXTURE_QUEUE = [
      { id: IDS.d1, version: isoAgo(2 * D), title: 'Ship release 4.2 to production?', urgency: 'critical', waiting_since: isoAgo(2 * D), initiative_title: 'Release initiative', blocked: false, decide_in_orgx_reason: null, option_count: 0, kind: 'decision', widget_actions: null, asker: 'Eli - Engineering', url: decisionUrl(IDS.d1) },
      { id: IDS.d2, version: isoAgo(5 * H), title: 'Rotate billing API keys?', urgency: 'high', waiting_since: isoAgo(5 * H), initiative_title: 'Billing hardening', blocked: false, decide_in_orgx_reason: null, option_count: 0, kind: 'decision', widget_actions: null, asker: 'Orion - Operations', url: decisionUrl(IDS.d2) },
      { id: IDS.d3, version: isoAgo(26 * H), title: 'Publish the onboarding checklist v2?', urgency: 'medium', waiting_since: isoAgo(26 * H), initiative_title: 'Activation', blocked: false, decide_in_orgx_reason: null, option_count: 0, kind: 'decision', widget_actions: null, asker: 'Pace - Product', url: decisionUrl(IDS.d3) },
    ];
    function galleryFocus(item) {
      var packets = {};
      packets[IDS.d1] = {
        question: 'Ship release 4.2 to production?',
        recommendation: { status: 'ready', action: 'Approve' },
        evidence: [
          { title: 'CI run 1182 · passed', source_url: window.OrgXLinks.artifact(IDS.art) },
          { title: 'Rollback plan · v3', source_url: null },
          { title: 'Load test · p95 212 ms', source_url: null },
          { title: 'Security review · no findings', source_url: null },
          { title: 'Changelog draft', source_url: null },
        ],
        evidence_total: 5,
        consequence_if_approved: 'The deploy job starts and release 4.2 reaches production within 15 minutes.',
      };
      packets[IDS.d2] = {
        question: 'Rotate billing API keys?',
        recommendation: { status: 'ready', action: 'Approve' },
        evidence: [{ title: 'Key age report · 212 days', source_url: null }],
        evidence_total: 1,
        consequence_if_approved: 'New keys are issued and the old ones stop working in 24 hours.',
      };
      packets[IDS.d3] = {
        question: 'Publish the onboarding checklist v2?',
        recommendation: { status: 'unverified', action: 'Approve with edits' },
        evidence: [],
        evidence_total: 0,
        consequence_if_approved: 'The checklist replaces v1 for new workspaces.',
      };
      var p = packets[item.id] || packets[IDS.d1];
      return {
        type: 'decision', id: item.id, version: item.version, question: p.question, urgency: item.urgency,
        waiting_since: item.waiting_since, initiative_title: item.initiative_title, recommendation: p.recommendation,
        evidence: p.evidence, evidence_total: p.evidence_total, consequence_if_approved: p.consequence_if_approved,
        consequence_if_rejected: null, blocked: item.blocked, decide_in_orgx_reason: item.decide_in_orgx_reason,
        options: [], multiselect: false, widget_actions: null, asker: item.asker || null, url: item.url,
      };
    }
    function baseSnapshot() {
      return {
        schema: 'orgx.panel.v1',
        generated_at: new Date(NOW - 4 * 60 * 1000).toISOString(),
        state: 'ok',
        workspace: { id: IDS.ws, name: 'Acme workspace' },
        attention: { pending: 3, oldest_at: FIXTURE_QUEUE[0].waiting_since, blocking: false },
        queue: FIXTURE_QUEUE.map(function copy(item) { return Object.assign({}, item); }),
        focus: galleryFocus(FIXTURE_QUEUE[0]),
        selection: { requested_id: null, status: 'default' },
        proof: {
          last_accepted: { artifact_id: IDS.art, title: 'Release checklist v3', accepted_at: isoAgo(2 * D), accepted_by: 'you', url: window.OrgXLinks.artifact(IDS.art) },
          completed_unaccepted: 2,
        },
        degraded: [],
      };
    }
    function calmSnapshot() {
      var s = baseSnapshot();
      s.attention = { pending: 0, oldest_at: null, blocking: false };
      s.queue = [];
      s.focus = null;
      return s;
    }
    function allTokens(s) {
      var t = {};
      s.queue.forEach(function add(item) { t[item.id] = 'gallery-token'; });
      return t;
    }
    function galleryActions(extra) {
      return Object.assign({ kind: 'decision', actions: ['approve', 'reject'], labels: { approve: 'Approve', reject: 'Send back' }, reject_requires_reason: true, answer: null, selection: null }, extra);
    }
    function runGallery() {
      var name = params.get('state') || 'needs-you';
      var s = baseSnapshot();
      var tokens = allTokens(s);
      var failed = false;
      switch (name) {
        case 'loading':
          render();
          return;
        case 'signed-out':
          ui.auth = { code: 'authentication_required' };
          render();
          return;
        case 'first-use':
          s = calmSnapshot();
          s.proof = { last_accepted: null, completed_unaccepted: 0 };
          tokens = {};
          break;
        case 'calm':
          s = calmSnapshot();
          s.proof.completed_unaccepted = 0;
          tokens = {};
          break;
        case 'completed-not-accepted':
          s = calmSnapshot();
          s.proof = { last_accepted: null, completed_unaccepted: 2 };
          tokens = {};
          break;
        case 'blocking':
          s.attention.blocking = true;
          s.queue[0].blocked = true;
          s.focus.blocked = true;
          break;
        case 'decide-in-orgx':
          s.queue[0].decide_in_orgx_reason = 'critical';
          s.focus.decide_in_orgx_reason = 'critical';
          tokens = {};
          break;
        case 'long': {
          var longTitle = 'Approve moving the entire EU customer base to the new billing provider before the quarter closes, including the 41 enterprise accounts on custom contracts and the legacy invoicing exports that finance still depends on?';
          s.workspace.name = 'Acme Holdings International · Operations and Finance Shared Workspace';
          s.queue[0].title = longTitle.slice(0, 159) + '…';
          s.queue[0].initiative_title = 'European billing consolidation and provider migration program';
          s.focus = galleryFocus(s.queue[0]);
          s.focus.question = longTitle;
          s.focus.initiative_title = s.queue[0].initiative_title;
          s.focus.consequence_if_approved = 'Migration jobs start for all 1,284 EU accounts tonight; enterprise contracts move after finance signs off on the export mapping, and the old provider is retired at the end of next month.';
          s.focus.evidence[0].title = 'Reconciliation dry run across 1,284 accounts · 3 mismatches, all explained and…';
          s.queue[1].title = 'Rotate the billing API keys for every regional integration, including the partner sandbox keys that are still shared with the reseller';
          break;
        }
        case 'degraded':
          failed = true;
          break;
        case 'stale':
          ui.changedSince = clock(new Date(NOW - 12 * 60 * 1000));
          break;
        case 'permission-limited':
          s.selection = { requested_id: '9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0', status: 'unavailable' };
          s.focus = null;
          break;
        case 'approved':
          ui.rulings[IDS.d1] = { action: 'approve', phase: 'confirmed', title: s.focus.question, detail: 'the agent can continue' };
          break;
        case 'done':
          ui.session = [
            { id: IDS.d2, title: 'Rotate billing API keys?', action: 'approve', verb: 'Approved', phase: 'confirmed', detail: 'the agent can continue', at: clock(new Date(NOW - 6 * 60 * 1000)), url: decisionUrl(IDS.d2) },
            { id: IDS.d3, title: 'Publish the onboarding checklist v2?', action: 'reject', verb: 'Sent back', phase: 'recorded', detail: '', at: clock(new Date(NOW - 15 * 60 * 1000)), url: decisionUrl(IDS.d3) },
          ];
          ui.openReceipt = IDS.d2;
          ui.tab = 'done';
          break;
        case 'work':
          ui.tab = 'work';
          ui.work = galleryWork();
          ui.workPhase = 'ready';
          break;
        case 'options':
          s.queue[0].title = s.focus.question = 'When does release 4.2 go to production?';
          s.queue[0].option_count = 3;
          s.focus.recommendation = { status: 'ready', action: 'Tonight after the freeze' };
          s.focus.options = [
            { id: 'opt-tonight', label: 'Tonight, 22:00 UTC' },
            { id: 'opt-tomorrow', label: 'Tomorrow, 09:00 UTC' },
            { id: 'opt-monday', label: 'Monday, after the change review' },
          ];
          s.queue[1].option_count = 2;
          break;
        case 'multiselect':
          s.queue[0].title = s.focus.question = 'Which regions get release 4.2 first?';
          s.queue[0].option_count = 3;
          s.focus.recommendation = { status: 'ready', action: 'EU and US' };
          s.focus.multiselect = true;
          s.focus.options = [
            { id: 'eu', label: 'EU (Frankfurt)' },
            { id: 'us', label: 'US (Virginia)' },
            { id: 'apac', label: 'APAC (Singapore)' },
          ];
          ui.selections[IDS.d1] = ['eu', 'us'];
          break;
        case 'external-question':
        case 'validation-error':
          s.queue[0].title = s.focus.question = 'Which staging database should the 4.2 migration run against?';
          s.focus.recommendation = { status: 'ready', action: 'staging-eu-2 (last night’s snapshot)' };
          s.focus.consequence_if_approved = 'Eli runs the migration against your answer and resumes the release.';
          s.focus.evidence = [];
          s.focus.evidence_total = 0;
          s.focus.widget_actions = s.queue[0].widget_actions = galleryActions({
            labels: { approve: 'Send answer', reject: 'Decline' }, reject_requires_reason: false,
            answer: { required_for: ['approve'], max_length: 2000 },
          });
          if (name === 'validation-error') ui.fieldErrors[IDS.d1] = { action: 'approve', field: 'answer', message: 'Type an answer to send.' };
          break;
        case 'option-multiselect':
          s.queue[0].title = s.focus.question = 'Which regions get release 4.2 first?';
          s.focus.recommendation = { status: 'ready', action: 'EU and US' };
          s.focus.consequence_if_approved = 'Release 4.2 reaches the chosen regions first.';
          s.focus.evidence = [];
          s.focus.evidence_total = 0;
          s.queue[0].option_count = 3;
          s.focus.widget_actions = s.queue[0].widget_actions = galleryActions({
            labels: { approve: 'Confirm selection', reject: 'Request changes' },
            selection: {
              mode: 'multiple', min: 1, max: 2, required_for: ['approve', 'reject'],
              options: [
                { id: 'eu', label: 'EU (Frankfurt)', description: '1,284 workspaces', implied_action: null, requires_reason: false },
                { id: 'us', label: 'US (Virginia)', description: '2,031 workspaces', implied_action: null, requires_reason: false },
                { id: 'apac', label: 'APAC (Singapore)', description: 'On-call is thin this week', implied_action: null, requires_reason: false },
              ],
            },
          });
          ui.selections[IDS.d1] = ['eu', 'us'];
          break;
        case 'access-request':
          s.queue[0].title = s.focus.question = 'Mara Lin asks for edit access to Billing hardening.';
          s.focus.recommendation = null;
          s.focus.consequence_if_approved = 'Mara can edit the initiative and its tasks.';
          s.focus.evidence = [];
          s.focus.evidence_total = 0;
          s.focus.widget_actions = s.queue[0].widget_actions = galleryActions({ labels: { approve: 'Grant access', reject: 'Deny' }, reject_requires_reason: false });
          break;
        case 'gateway-action':
          s.queue[0].title = s.focus.question = 'send_email (gmail.send)';
          s.queue[0].kind = s.focus.kind = 'action';
          s.queue[0].initiative_title = s.focus.initiative_title = null;
          s.focus.recommendation = null;
          s.focus.consequence_if_approved = null;
          s.focus.evidence = [];
          s.focus.evidence_total = 0;
          s.focus.widget_actions = s.queue[0].widget_actions = galleryActions({ kind: 'action', labels: { approve: 'Approve', reject: 'Deny' }, reject_requires_reason: false });
          break;
        case 'artifact-review':
          s.queue[0].title = s.focus.question = 'Review the 4.2 release notes before they publish.';
          s.focus.recommendation = { status: 'ready', action: 'Approve' };
          s.focus.consequence_if_approved = 'The notes publish with the 4.2 tag.';
          s.focus.widget_actions = s.queue[0].widget_actions = galleryActions({ labels: { approve: 'Approve', reject: 'Request changes' }, reject_requires_reason: true });
          ui.composer = { id: IDS.d1, draft: 'The export line still says CSV only.', focus: false, opener: IDS.d1 };
          break;
        case 'chat-unavailable':
          ui.chatCannotDecide = true;
          s.queue[0].decide_in_orgx_reason = s.focus.decide_in_orgx_reason = 'chat_unavailable';
          break;
        case 'no-recommendation': {
          var question = 'The OrgX floor stopped a merge action in an agent-cli session and is waiting for you. Agent’s reason: please review PR #3239. Required GitHub CI did not start because the Actions budget is exhausted. Approve to let exactly this action run once in the next 24 hours.';
          s.queue[0].title = question.slice(0, 159) + '…';
          s.focus.question = question;
          s.focus.recommendation = { status: 'unavailable', action: null };
          s.focus.evidence = [];
          s.focus.evidence_total = 0;
          s.focus.consequence_if_approved = null;
          break;
        }
        case 'decide-reason':
          s.queue[0].title = s.focus.question = 'Connect the production Stripe key for the billing agent.';
          s.queue[0].decide_in_orgx_reason = s.focus.decide_in_orgx_reason = 'credential_required';
          s.focus.evidence = [];
          s.focus.evidence_total = 0;
          delete tokens[IDS.d1];
          break;
        default:
          break;
      }
      if (params.get('caps') === 'share') {
        ui.caps.modelContext = true;
        share = X.createShareController({ modelContext: { update: function noop() { return Promise.resolve(undefined); } } });
        if (name === 'stale') share.restore({ status: 'match', entity: { id: IDS.d1, version: 'older' } }, IDS.ws);
      }
      ui.tokens = tokens;
      if (params.get('tab') === 'work' || params.get('tab') === 'done') { ui.tab = params.get('tab'); if (ui.tab === 'work') { ui.work = galleryWork(); ui.workPhase = 'ready'; } }
      accept(s, undefined, 'host');
      ui.syncedAt = new Date(NOW - 4 * 60 * 1000);
      if (failed) ui.readState = { phase: 'failed', focusId: null };
      render();
    }

    if (isGallery) {
      runGallery();
      return;
    }

    render();
    R.initWidget({
      bridge: 'mcp-apps-sdk',
      resultScope: function scope(data) {
        if (authFailure(data)) return 'disconnected';
        return data && data.schema === 'orgx.panel.v1' ? 'workspace:' + ((data.workspace && data.workspace.id) || '') : undefined;
      },
      dataAvailabilityNotice: false,
      onHostContext: onHostContext,
      onFailure: function onFailure(decoded) {
        var auth = authFailure(decoded);
        if (auth) { resetScope(); ui.snapshot = null; ui.auth = { code: auth }; }
        else ui.readState = { phase: 'failed', focusId: null };
        render();
        return true;
      },
      render: function onHostResult(data) {
        if (data === null || data === undefined) { render(); return; }
        if (accept(data, R.getToolResponseMetadata ? { 'orgx/widgetApproval': R.getToolResponseMetadata(APPROVAL_META_KEY) } : null, 'host')) {
          render();
        } else if (!isSnapshot(data)) {
          ui.readState = { phase: 'failed', focusId: null };
          render();
        }
      },
    });
    })();
