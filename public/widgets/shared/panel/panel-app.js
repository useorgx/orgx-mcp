/* OrgX panel controller: snapshot reads, rulings, rendering. */
    (function orgxPanel() {
    'use strict';

    var R = window.OrgXWidgetRuntime;
    var X = window.OrgXOpenAIExtensions;
    var Brand = window.OrgXPanelBrand || null;
    var Launch = window.OrgXPanelLaunch || null;
    var Views = window.OrgXPanelViews || null;
    var Tour = window.OrgXPanelTour || null;
    var Start = window.OrgXPanelStart || null;
    var Receipts = window.OrgXPanelReceipts || null;
    var Expect = window.OrgXExpectations || null;
    // Which app and device the panel is inside: copy names the host, layout follows the platform.
    var Host = window.OrgXPanelHost || null;
    function hostName() { return Host ? Host.chat() : 'the chat'; }
    function hostFill(text) { return Host ? Host.fill(text) : String(text).replace(/\{(?:host|chat|Host|Chat)\}/g, 'the chat').replace(/\{assistant\}/g, 'the assistant').replace(/\{settings\}/g, 'the app’s settings'); }
    var root = document.getElementById('panel');
    if (Expect && root) Expect.bind(root);
    // "Change this workstream in chat", from an opened workstream in an Agree on done bar.
    if (Expect && root) root.addEventListener('ox-xp-edit', function onBarEdit(event) {
      var d = event.detail || {};
      var item = findItem(d.key);
      var set = agreementOf(item);
      if (!item || !set || !Launch) return;
      var button = d.button;
      Launch.send(Expect.editSentence(set, item.initiative_title || splitHeadline(item.question || item.title).headline, d.group)).then(function edited(outcome) {
        if (button) button.textContent = outcome === 'sent' ? 'Sent to the chat' : outcome === 'copied' ? 'Copied. Paste it into the chat' : 'Type it in the chat';
        announce(outcome === 'sent' ? 'Sent to the chat. Agree here once it reads right.' : outcome === 'copied' ? 'Copied. Paste it into the chat.' : 'Couldn’t send it. Type it in the chat.');
      });
    });
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
      // In progress: selected task, state filter, search, agents shown in full.
      workSel: null,
      workFilter: 'all',
      workQuery: '',
      workExpanded: {},
      // Done: time range, history per range, selected receipt, page.
      doneRange: 'session',
      history: {},
      historyPhase: 'idle',
      donePage: 1,
      // Done › Work: Work Ledger receipts per range, the open one, and its full read.
      doneLens: 'work',
      receipts: {},
      receiptsPhase: 'idle',
      receiptSel: null,
      receiptDetail: {},
      receiptRows: {},
      receiptCalls: {},
      receiptTokens: {},
      // Needs you: the receipt behind the open decision (by decision id).
      behind: {},
      whyOpen: null,
      // Start: the composer's text, who takes it, how, and the last send's outcome.
      startText: '',
      startAgent: '',
      startVerb: '',
      startStatus: null,
      startWhoOpen: false,
      tourChecked: false,
      // Live feed: connection status, and what it says In progress holds
      // before (or without) the full In progress read.
      live: 'off',
      liveWork: null,
      renderPending: false,
      // Cold start: 'reading', then 'slow', then 'stalled' while no snapshot has arrived.
      bootStage: isGallery && params.get('stage') ? params.get('stage') : 'reading',
      // The browser says it has no network. Shown, never guessed.
      offline: (isGallery && params.get('offline') === '1') || (typeof navigator !== 'undefined' && navigator.onLine === false),
      // Workspace switcher: the list is read when it is opened.
      wsOpen: false,
      wsPhase: 'idle',
      workspaces: null,
      wsError: null,
    };
    var live = null;
    var tour = null;
    // The local preview's fixtures (panel-gallery.js), once loaded.
    var gallery = null;
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
      check: '<svg class="pn-ic receipt-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
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
      // "PR #3239 (https://github.com/…/pull/3239)" says the number twice once
      // the URL becomes a link: keep only the link.
      text = String(text == null ? '' : text).replace(/\b(?:PR|pull request) #(\d+) \((https?:\/\/github\.com\/[^\s)]+\/pull\/\1)\)/gi, '$2');
      return esc(text)
        .replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, function link(url) {
          var raw = url.replace(/&amp;/g, '&');
          // A pull request reads as one: "PR #3239 ↗", not a truncated URL.
          var pr = /github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/.exec(raw);
          var label = pr ? (pr[1] === 'pull' ? 'PR #' : 'Issue #') + pr[2] + ' ↗' : raw.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48);
          return '<a href="' + url + '" class="' + (pr ? 'pr-link' : '') + '" data-action="open" data-url="' + url + '">' + esc(label) + '</a>';
        })
        .replace(/`([^`]{1,200})`/g, '<code>$1</code>')
        .replace(/\b([0-9a-f]{12,64})\b/g, function hash(m, h) { return '<code title="' + h + '">' + h.slice(0, 10) + '</code>'; });
    }
    /**
     * Split a command from the instruction run on after it. Agents write
     * "Command: gh pr merge 3236 Approve to let exactly this action run once…"
     * with no full stop, which put the consequence inside the code block.
     */
    function splitCommand(text) {
      var m = /^(.*?\S)\s+((?:Approve|Approving|Allow|Deny|Reject|Decline)\b.*)$/.exec(text);
      return m ? { cmd: m[1].replace(/\.$/, ''), tail: m[2] } : { cmd: String(text).replace(/\.$/, ''), tail: '' };
    }
    function structureBody(text) {
      var parts = { lede: [], facts: [], commands: [], ifApproved: '' };
      sentences(text).forEach(function sort(line) {
        var bare = line.replace(/[.!]$/, '');
        var m = /^([A-Z][\w’' -]{2,28}?)\s*:\s+(.+)$/.exec(line);
        var label = m ? m[1].trim() : '';
        var split;
        if (m && /^(?:command|run|cmd|shell)$/i.test(label)) {
          split = splitCommand(m[2]);
          parts.commands.push(split.cmd);
          if (split.tail) sort(split.tail);
          return;
        }
        if (CLI.test(bare) && !/\s(?:the|to|and|because)\s/i.test(splitCommand(bare).cmd)) {
          split = splitCommand(bare);
          parts.commands.push(split.cmd);
          if (split.tail) sort(split.tail);
          return;
        }
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
    /**
     * ChatGPT checks a widget's calls against its own saved copy of the OrgX
     * tools. When that copy is older than the panel, a new view or tool is
     * refused before it reaches OrgX. Say how to fix it instead of echoing the
     * validator.
     */
    function STALE_TOOLS() { return hostFill('{Host} is using an older copy of the OrgX tools. Refresh the OrgX app in {settings}, then try again.'); }
    function staleTools(error) {
      var raw = [error && error.message, error && error.details && error.details.raw].filter(function str(v) { return typeof v === 'string'; }).join(' ');
      return /connector schema validation|not in allowed enum|unrecognized key|additional propert|tool not found|unknown tool|no such tool/i.test(raw);
    }
    function safeErrorText(error, fallback, max) {
      if (staleTools(error)) return STALE_TOOLS();
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
      approve: 'Approved', 'agree · start work': 'Agreed', agree: 'Agreed', 'approve and continue': 'Approved', 'approve selected': 'Approved', 'grant access': 'Access granted',
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
    /** The bar on an "Agree on done" decision (expectation_agreement), or null. */
    function agreementOf(f) {
      return Expect && f ? Expect.fromDecision(f) : null;
    }
    function isAgreementItem(f) {
      return Boolean(f && (f.agreement === true || agreementOf(f)));
    }
    /** An agreement says what agreeing does; a generic "Approve" would not. */
    function choicesFor(f) {
      var spec = baseChoicesFor(f);
      if (isAgreementItem(f)) {
        if (spec.approve && /^(approve|confirm)$/i.test(spec.approve.label)) spec.approve.label = 'Agree · start work';
        if (spec.reject && /^(reject|decline)$/i.test(spec.reject.label)) spec.reject.label = 'Send back';
      }
      return spec;
    }
    function baseChoicesFor(f) {
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
      // Agreeing on done means reading the bar first: the row opens it.
      if (isAgreementItem(item)) return false;
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
    function adoptReceiptTokens(meta, receiptId) {
      if (receiptId) delete ui.receiptTokens[receiptId];
      var dedicated = meta && meta['orgx/receiptApproval'];
      var shared = meta && meta[APPROVAL_META_KEY];
      var tokens = dedicated && dedicated.approval_tokens || shared && shared.receipt_approval_tokens;
      if (tokens && typeof tokens === 'object') Object.keys(tokens).forEach(function remember(id) {
        if (typeof tokens[id] === 'string' && tokens[id]) ui.receiptTokens[id] = tokens[id];
      });
    }
    function receiptTokenFor(id) {
      var token = ui.receiptTokens[id];
      return typeof token === 'string' && token ? token : null;
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
      var synced = syncLabel();
      var refresh = ui.auth || ui.readState.phase === 'failed' ? '' : '<button type="button" class="quiet-btn" data-action="refresh">Refresh</button>';
      var nameHtml = name
        ? (ui.mode === 'global' ? '<h1 class="ws-h">' + workspaceButtonHtml(name) + '</h1>' : '<span class="ws">' + esc(name) + '</span>')
        : (ui.mode === 'global' ? '<h1 class="sr-only">OrgX</h1>' : '');
      var mark = Brand ? '<span class="pn-mark-slot">' + Brand.mark(22) + '</span>' : '';
      var tabs = tabsHtml();
      var help = tabs ? '<button type="button" class="quiet-btn pn-help" data-action="tour" aria-label="How the OrgX panel works">?</button>' : '';
      var display = displayButtonHtml();
      return '<header class="top' + (tabs ? ' has-tabs' : '') + '">' + mark + '<div class="top-id"><span class="brand" aria-hidden="' + (name ? 'false' : 'true') + '">OrgX</span>' +
        (name ? '<span aria-hidden="true">·</span>' : '') + nameHtml + '</div>' + tabs +
        (synced ? '<span class="sync" data-live="' + esc(ui.live) + '"' + (ui.live === 'live' ? ' role="img" aria-label="Live: updates as they happen" title="Updates as they happen"' : '') + '>' + esc(synced) + '</span>' : '') + refresh + display + help + '</header>';
    }

    /**
     * On a phone, a way to take the panel full screen and back, only where the
     * host offers that mode. A sidebar or a desktop never shows it.
     */
    function displayButtonHtml() {
      if (!Host || ui.mode !== 'global') return '';
      var full = Host.displayMode() === 'fullscreen';
      // Full screen the host owns (ChatGPT's phone app has its own way back) gets no button of ours.
      if (full && Host.modes().indexOf('inline') === -1) return '';
      if (!full && !(Host.canFullscreen() && (Host.isMobile() || Host.touch()))) return '';
      var icon = full
        ? '<svg class="pn-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
        : '<svg class="pn-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
      return '<button type="button" class="quiet-btn pn-display" data-action="display-mode" data-mode="' + (full ? 'inline' : 'fullscreen') + '" aria-label="' + (full ? 'Back to the chat' : 'Open full screen') + '" title="' + (full ? 'Back to the chat' : 'Full screen') + '">' + icon + '</button>';
    }
    function requestDisplay(mode) {
      if (!R || !R.requestDisplayMode) return;
      var want = mode === 'fullscreen' ? 'fullscreen' : 'inline';
      R.requestDisplayMode(want).then(function applied(result) {
        var got = result && (result.mode === 'inline' || result.mode === 'fullscreen' || result.mode === 'pip') ? result.mode : want;
        if (Host) Host.apply({ displayMode: got });
        announce(got === 'fullscreen' ? 'Full screen.' : 'Back in the chat.');
        render();
      }, function failed() { announce('The view could not be changed here.'); });
    }

    /** The workspace name doubles as the switcher's trigger. */
    function workspaceButtonHtml(name) {
      return '<button type="button" class="ws ws-btn" data-action="workspaces" aria-haspopup="true" aria-expanded="' + (ui.wsOpen ? 'true' : 'false') + '"' +
        ' aria-controls="pn-ws-menu" title="Switch workspace"><span class="ws-n">' + esc(name) + '</span>' +
        '<svg class="ws-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="sr-only">, switch workspace</span></button>';
    }

    function workspaceMenuHtml() {
      if (!ui.wsOpen) return '';
      var body;
      if (ui.wsPhase === 'loading') {
        body = '<p class="ws-note" role="status">Loading your workspaces…</p>';
      } else if (ui.wsPhase === 'failed' || (ui.workspaces && ui.workspaces.status !== 'ok')) {
        body = '<p class="ws-note" role="alert">' + esc(ui.wsError || 'Your workspaces could not be loaded.') + '</p>' +
          '<button type="button" class="quiet-btn" data-action="workspaces-retry">Try again</button>';
      } else {
        var all = ui.workspaces ? ui.workspaces.items : [];
        var wq = String(ui.wsQuery || '').trim().toLowerCase();
        var items = wq ? all.filter(function match(w) { return w.name.toLowerCase().indexOf(wq) !== -1; }) : all;
        var filter = all.length > 8
          ? '<label class="ws-filter"><span class="sr-only">Find a workspace</span><input type="search" data-action="ws-query" placeholder="Find a workspace" value="' + esc(ui.wsQuery || '') + '" autocomplete="off"></label>' : '';
        body = filter + (items.length ? '' : '<p class="ws-note">No workspace matches “' + esc(ui.wsQuery) + '”.</p>') + '<ul class="ws-list" role="list">' + items.map(function item(w) {
          var busy = ui.wsPhase === 'switching' && ui.wsSwitchingTo === w.id;
          return '<li><button type="button" class="ws-item" data-action="switch-workspace" data-id="' + esc(w.id) + '"' +
            (w.current ? ' aria-current="true"' : '') + (busy ? ' aria-busy="true"' : '') +
            (ui.wsPhase === 'switching' ? ' disabled' : '') + '>' +
            '<span class="ws-item-n">' + esc(w.name) + '</span>' +
            (w.current ? '<span class="ws-item-s">Current</span>' : busy ? '<span class="ws-item-s">Switching…</span>' : '') +
            '</button></li>';
        }).join('') + '</ul>' +
          (ui.wsError ? '<p class="ws-note" role="alert">' + esc(ui.wsError) + '</p>' : '') +
          '<p class="ws-note">' + hostFill('You can also ask {assistant} to switch your OrgX workspace.') + '</p>';
      }
      return '<div id="pn-ws-menu" class="ws-menu" role="dialog" aria-label="Switch workspace">' + body + '</div>';
    }

    function openWorkspaces() {
      ui.wsOpen = true;
      ui.wsError = null;
      if (ui.workspaces && ui.workspaces.status === 'ok' && ui.wsPhase !== 'failed') { render(); focusFirst('.ws-item[aria-current="true"], .ws-item'); return; }
      if (isGallery) {
        ui.workspaces = gallery.workspaces();
        ui.wsPhase = 'ready';
        render();
        focusFirst('.ws-item[aria-current="true"]');
        return;
      }
      ui.wsPhase = 'loading';
      render();
      var gen = ui.generation;
      R.callToolResult('orgx_panel_snapshot', { view: 'workspaces' }).then(function onList(result) {
        if (gen !== ui.generation) return;
        var data = result && result.data;
        if (isSnapshot(data)) accept(data, result.meta || null, 'refresh');
        ui.workspaces = data && data.workspaces ? data.workspaces : { status: 'unavailable', items: [] };
        ui.wsPhase = ui.workspaces.status === 'ok' ? 'ready' : 'failed';
        render();
        if (ui.wsOpen) focusFirst('.ws-item[aria-current="true"], .ws-item, [data-action="workspaces-retry"]');
      }, function onListError() {
        if (gen !== ui.generation) return;
        ui.wsPhase = 'failed';
        render();
      });
    }

    function closeWorkspaces(restoreFocus) {
      if (!ui.wsOpen) return;
      ui.wsOpen = false;
      ui.wsQuery = '';
      ui.wsError = null;
      if (ui.wsPhase === 'failed') ui.wsPhase = 'idle';
      render();
      if (restoreFocus) focusFirst('[data-action="workspaces"]');
    }

    /**
     * Switch through the explicit widget workspace selection, changing the
     * session's workspace, then read the panel again. The new snapshot carries
     * the new workspace's live grant, so the feed follows on its own.
     */
    function switchWorkspace(id) {
      var target = ui.workspaces && ui.workspaces.items.filter(function same(w) { return w.id === id; })[0];
      if (!target || target.current || ui.wsPhase === 'switching') { closeWorkspaces(true); return; }
      if (isGallery) {
        ui.workspaces.items.forEach(function mark(w) { w.current = w.id === id; });
        ui.snapshot.workspace = { id: ui.snapshot.workspace.id, name: target.name };
        closeWorkspaces(true);
        announce('Switched to ' + target.name + '.');
        return;
      }
      ui.wsPhase = 'switching';
      ui.wsSwitchingTo = id;
      ui.wsError = null;
      render();
      var gen = ui.generation;
      R.callWidgetToolResult('orgx_widget_select_workspace', { workspace_id: id }).then(function onSwitched() {
        if (gen !== ui.generation) return;
        ui.wsPhase = 'idle';
        ui.wsSwitchingTo = null;
        ui.workspaces = null;
        ui.wsOpen = false;
        announce('Switched to ' + target.name + '.');
        fetchSnapshot(null, 'switch');
        focusFirst('[data-action="workspaces"]');
      }, function onSwitchFailed(error) {
        if (gen !== ui.generation) return;
        ui.wsPhase = 'ready';
        ui.wsSwitchingTo = null;
        ui.wsError = safeErrorText(error, hostFill('Couldn’t switch. Try again, or ask {assistant} to switch your OrgX workspace.'), 160);
        render();
      });
    }

    /** "Live" while the feed is attached; otherwise when the panel last synced. */
    function syncLabel() {
      if (ui.snapshot && ui.live === 'live') return 'Live';
      if (ui.snapshot && ui.live === 'reconnecting') return 'Reconnecting…';
      return ui.syncedAt ? window.OrgXTime.synced(ui.syncedAt).replace(/^s/, 'S') : '';
    }

    function tabsHtml() {
      var s = ui.snapshot;
      if (!Views || ui.mode !== 'global' || ui.auth || !s || s.state !== 'ok' || ui.limited || s.selection.status === 'unavailable') return '';
      var workRead = ui.work && ui.work.status === 'ok';
      var blocked = workRead
        ? ui.work.items.some(function b(i) { return i.state === 'blocked'; })
        : Boolean(ui.liveWork && ui.liveWork.blocked);
      var workCount = workRead ? ui.work.total : ui.liveWork ? ui.liveWork.total : null;
      var counts = { needs: s.attention.pending, work: workCount, done: ui.session.length };
      ui.countChanged = {};
      Object.keys(counts).forEach(function diff(k) {
        if (ui.lastCounts && ui.lastCounts[k] !== undefined && ui.lastCounts[k] !== null && counts[k] !== ui.lastCounts[k]) ui.countChanged[k] = true;
      });
      ui.lastCounts = counts;
      return Views.tabsHtml({
        changed: ui.countChanged,
        active: ui.tab,
        counts: { needs: s.attention.pending, work: workCount, done: ui.session.length },
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
      if (ui.offline && ui.snapshot) {
        parts.push('<div class="notice is-offline" data-tone="amber" role="status"><p><strong>You’re offline.</strong> Showing what loaded' + (ui.syncedAt ? ' at ' + esc(clock(ui.syncedAt)) : ' last') + '. It refreshes when you’re back.</p></div>');
      }
      if (ui.readState.phase === 'failed' && ui.snapshot) {
        parts.push('<div class="notice" data-tone="amber" role="status"><p>Showing the snapshot from ' + esc(clock(ui.syncedAt)) +
          '. The latest snapshot could not be loaded.</p><button type="button" class="text-btn" data-action="refresh">Refresh</button></div>');
      }
      // One line, then it gets out of the way: Done keeps the receipt.
      if (ui.lastRuling && ui.tab !== 'done') {
        var receiptTitle = splitHeadline(ui.lastRuling.title);
        var receiptCommand = structureBody(receiptTitle.body).commands[0];
        var receiptEntry = ui.session.filter(function same(e) { return e.id === ui.lastRuling.id; })[0];
        var verb = ui.lastRuling.elsewhere ? 'Settled in OrgX' : (ui.lastRuling.verb || (ui.lastRuling.action === 'approve' ? 'Approved' : 'Sent back')) + ' by you';
        parts.push('<div class="notice receipt" data-tone="teal" role="status">' + ICON.check +
          '<p><strong>' + esc(verb) + '</strong> ' + (receiptCommand ? '<code>' + esc(receiptCommand) + '</code>' : esc(receiptTitle.headline)) + '</p>' +
          (receiptEntry && Views && Views.trailMarks ? Views.trailMarks(receiptEntry) : '') +
          (ui.session.length ? '<button type="button" class="text-btn" data-action="done-decisions">In Done</button>' : '') + '</div>');
        armReceiptDismiss();
      }
      return parts.join('');
    }

    var receiptTimer = null;
    var receiptShown = null;
    /** The receipt line fades after a few seconds unless the person is reading it. */
    function armReceiptDismiss() {
      if (receiptShown === ui.lastRuling) return;
      receiptShown = ui.lastRuling;
      if (receiptTimer) window.clearTimeout(receiptTimer);
      var shown = ui.lastRuling;
      receiptTimer = window.setTimeout(function fade() {
        receiptTimer = null;
        if (ui.lastRuling !== shown) return;
        var el = root.querySelector('.notice.receipt');
        if (el && (el.matches(':hover') || el.contains(document.activeElement))) { receiptShown = null; armReceiptDismiss(); return; }
        if (el) el.classList.add('leaving');
        window.setTimeout(function gone() {
          if (ui.lastRuling !== shown) return;
          ui.lastRuling = null;
          if (typeof liveRender === 'function') liveRender(); else render();
        }, 220);
      }, 6000);
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
      if (isAgreementItem(f)) return { heading: 'Agree on done', detail: ready ? 'agents start when you agree' : detail, primary: c.approve.label, disabled: !ready };
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
          // Say what is happening, and keep the pressed button's own label (with
          // the kit's spinner) so the footer does not jump to "Saving…".
          saving: {
            state: 'saving',
            heading: 'Sending “' + ((ruling.action === 'approve' ? ruling.approveLabel : ruling.rejectLabel) || (ruling.action === 'approve' ? 'Approve' : 'Send back')) + '” to OrgX',
            detail: 'confirming in a moment',
            primary: (ruling.action === 'approve' ? ruling.approveLabel : ruling.rejectLabel) || '',
          },
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
          (fr.action ? ' action-label="' + esc(fr.action) + '"' : '') + (fr.primary ? ' primary-label="' + esc(fr.primary) + '"' : '') + ' data-id="' + esc(f.id) + '"></ox-footer>';
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
      return '<div class="share-row"><button type="button" class="pn-chip share" data-action="share" data-id="' + esc(f.id) + '">' +
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8.5l4-2.5M6 7.5l4 2.5"/><circle cx="4.5" cy="8" r="2"/><circle cx="11.5" cy="5" r="2"/><circle cx="11.5" cy="11" r="2"/></svg>' +
        '<span>Share with chat</span></button><span class="share-hint">' + hostFill('{Host} can then read this decision') + '</span></div>';
    }

    function actionErrorHtml(style) {
      var e = ui.actionError;
      return '<p class="error-line" role="alert"' + (style ? ' style="' + style + '"' : '') + '>' + esc(e.message) +
        (e.refresh ? ' <button type="button" class="text-btn" data-action="refresh">Refresh</button>' : '') + '</p>';
    }

    var GLYPH = {
      floor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9.5 12.2l1.8 1.8 3.4-3.6"/></svg>',
      agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 7V4M9.5 12h.01M14.5 12h.01M9.5 15.5h5"/></svg>',
    };
    /**
     * Who is asking, honestly. The floor's stops arrive as "OrgX System" and
     * some run approvals as just "Agent"; neither names the agent behind the
     * work, so the panel says what it knows instead of inventing an identity.
     */
    function askerAvatar(kind, name, size) {
      if (kind === 'floor') return '<span class="ax ax-floor ax-' + size + '" title="Stopped by the OrgX floor">' + GLYPH.floor + '</span>';
      if (kind === 'unnamed') return '<span class="ax ax-agent ax-' + size + '" title="An agent (not named)">' + GLYPH.agent + '</span>';
      return Views ? Views.avatar(kind === 'agent' ? name || '' : '', size) : '';
    }
    function askerPhrase(f) {
      if (f.asker_kind === 'floor') return 'Stopped by the OrgX floor' + (f.session_label ? ' · ' + f.session_label : '');
      if (f.asker_kind === 'unnamed') return 'An agent asks';
      return f.asker ? f.asker + ' asks' : '';
    }

    /**
     * Why you are being asked, from the review packet: what it blocks, why only
     * a person can answer, the policy that stopped it, what is uncertain, and
     * where it came from. Closed by default; the question stays the headline.
     */
    function whyHtml(f) {
      var why = f.why || {};
      var lines = [];
      if (f.blocked) lines.push(['Blocking', 'Work stays stopped until you decide.']);
      if (why.policy) lines.push(['Policy', why.policy]);
      if (why.authority) lines.push(['Why you', why.authority]);
      (why.uncertainty || []).forEach(function u(text) { lines.push(['Uncertain', text]); });
      if (f.session_label && f.asker_kind === 'floor') lines.push(['Where', 'The floor paused an action in an ' + f.session_label + ' before it ran.']);
      var refs = [];
      if (why.run_url) refs.push('<button type="button" class="pn-chip" data-action="open" data-url="' + esc(why.run_url) + '">Source run ↗</button>');
      if (why.initiative_url) refs.push('<button type="button" class="pn-chip" data-action="open" data-url="' + esc(why.initiative_url) + '">Initiative ↗</button>');
      if (!lines.length && !refs.length) return '';
      var open = ui.whyOpen === f.id;
      return '<div class="why"><button type="button" class="why-t" data-action="why" data-id="' + esc(f.id) + '" aria-expanded="' + open + '" aria-controls="why-' + esc(f.id) + '">' +
        '<span>Why you’re asked</span><span class="why-n">' + (lines.length + refs.length) + '</span><span class="why-chev" aria-hidden="true">›</span></button>' +
        '<div class="why-b" id="why-' + esc(f.id) + '"' + (open ? '' : ' hidden') + '>' +
        (lines.length ? '<dl class="why-l">' + lines.map(function l(x) { return '<div><dt>' + esc(x[0]) + '</dt><dd>' + inline(x[1]) + '</dd></div>'; }).join('') + '</dl>' : '') +
        (refs.length ? '<div class="why-refs">' + refs.join('') + '</div>' : '') + '</div></div>';
    }

    function packetHtml(f, headingTag) {
      var metaBits = [askerPhrase(f), f.kind === 'action' ? 'Action approval' : f.kind === 'approval' ? 'Agent run approval' : '', ago(f.waiting_since), f.initiative_title].filter(Boolean);
      var askerAvatarHtml = '<span class="pn-asker" aria-hidden="true">' + askerAvatar(f.asker_kind, f.asker, 'inline') + '</span>';
      var error = ui.actionError && ui.actionError.id === f.id ? actionErrorHtml() : '';
      var changed = ui.changedSince
        ? '<div class="notice" role="status"><p>Changed since ' + esc(ui.changedSince) + '</p></div>' : '';
      var facts = [];
      var evidenceSlot = '';
      var head = splitHeadline(f.question);
      var body = structureBody(head.body);
      body.facts.forEach(function fact(x) {
        facts.push('<div class="fact"><dt>' + esc(x.k) + '</dt><dd>' + inline(x.v) + '</dd></div>');
      });
      if (f.recommendation && f.recommendation.action) {
        facts.push('<div class="fact"><dt>Recommendation</dt><dd>' + esc(f.recommendation.action) +
          (f.recommendation.status === 'unverified' ? ' <span class="sub">(unverified)</span>' : '') + '</dd></div>');
      } else if (f.recommendation && kindOf(f) === 'decision') {
        // Said, quietly: no recommendation is information for a decision.
        facts.push('<div class="fact"><dt>Recommendation</dt><dd class="quiet">No recommendation yet</dd></div>');
      }
      if (f.consequence_if_approved || body.ifApproved) {
        facts.push('<div class="fact"><dt>If approved</dt><dd>' + inline(f.consequence_if_approved || body.ifApproved) + '</dd></div>');
      }
      var bar = agreementOf(f);
      if (bar) {
        // The bar is the packet: what OrgX drafted, where each check came from,
        // new since last time first, then per owner. No recommendation row.
        facts = [];
        evidenceSlot = '<div class="xp-packet">' + Expect.barHtml(bar, { key: f.id }) +
          (ui.rulings[f.id] ? '' : '<div class="xp-acts"><button type="button" class="text-btn" data-action="exp-edit" data-id="' + esc(f.id) + '">Edit in chat</button>' +
            '<span class="xp-hint">Change a check before you agree</span></div>') + '</div>';
      }
      return '<section class="packet enter" aria-labelledby="pk-q">' + changed +
        '<p class="meta">' + askerAvatarHtml +
        // "Normal · Blocking work" says two things at once; blocking is the one that matters.
        (f.blocked && (f.urgency === 'medium' || f.urgency === 'low') ? '' : '<span class="urgency" data-u="' + esc(f.urgency) + '">' + esc(urgencyLabel(f.urgency)) + '</span>') +
        (f.blocked ? (f.urgency === 'medium' || f.urgency === 'low' ? '' : '<span aria-hidden="true">·</span>') + '<span class="blocked-tag">Blocking work</span>' : '') +
        (metaBits.length ? '<span aria-hidden="true">·</span><span class="meta-text" title="' + esc(metaBits.join(' · ')) + '">' + esc(metaBits.join(' · ')) + '</span>' : '<span class="meta-text"></span>') +
        (tokenFor(f.id) || ui.rulings[f.id] ? '<button type="button" class="ox-open" data-action="open" data-url="' + esc(f.url) + '" aria-label="Open this decision in OrgX">Open in OrgX</button>' : '') + '</p>' +
        '<' + headingTag + ' id="pk-q" tabindex="-1" class="q' + (ui.wholeQ === f.id ? ' is-whole' : '') + '">' + esc(head.headline) + '</' + headingTag + '>' +
        '<button type="button" class="q-more" data-action="whole-q" data-id="' + esc(f.id) + '" hidden>Show the whole question</button>' +
        (body.lede.length ? '<p class="q-body">' + inline(body.lede.join(' ')) + '</p>' : '') +
        body.commands.map(function cmd(c) { return '<div class="q-cmd"><span>Command</span><pre><code>' + esc(c) + '</code></pre></div>'; }).join('') +
        (facts.length ? '<dl class="facts">' + facts.join('') + '</dl>' : '') +
        (evidenceSlot || evidenceHtml(f)) + whyHtml(f) +
        // The work this decision would let through, read before deciding, not after.
        behindFor(f) +
        '<div class="actions">' + footerFor(f) + error + '</div>' +
        shareHtml(f) + (Launch && !ui.rulings[f.id] && !bar ? Launch.chipsHtml('packet', { title: head.headline }) : '') + '</section>';
    }

    function rowHtml(item, opts) {
      var grouped = Boolean(opts && opts.grouped);
      var ruling = ui.rulings[item.id];
      var repeatedTitle = ui.snapshot.queue.some(function repeated(other) {
        return other.id !== item.id && splitHeadline(other.title).headline === splitHeadline(item.title).headline;
      });
      var calmUrgency = item.urgency === 'medium' || item.urgency === 'low';
      var meta = [item.blocked && calmUrgency ? 'Blocking work' : urgencyLabel(item.urgency), ago(item.waiting_since), item.initiative_title].filter(Boolean).join(' · ');
      var acts = '';
      var opening = ui.readState.phase === 'loading' && ui.readState.focusId === item.id;
      var current = Boolean(ui.snapshot.focus && ui.snapshot.focus.id === item.id && !ruling);
      if (current) {
        acts = '<div class="row-acts"><span class="row-open">Open</span></div>';
      } else if (ui.readState.phase !== 'idle') {
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
        acts = '<div class="row-acts"><button type="button" class="mini' + (repeatedTitle ? ' ghost' : ' approve') + '" data-action="select" data-id="' + esc(item.id) + '" aria-label="' + esc(open + ': ' + item.title) + '">' + open + '</button></div>';
      } else if (tokenFor(item.id) && !(ui.composer && ui.composer.id === item.id)) {
        var c = choicesFor(item);
        acts = '<div class="row-acts">' +
          (c.reject ? '<button type="button" class="mini" data-action="sendback" data-id="' + esc(item.id) + '" aria-label="' + esc(c.reject.label + ': ' + item.title) + '">' + esc(c.reject.label) + '</button>' : '') +
          '<button type="button" class="mini approve" data-action="approve" data-id="' + esc(item.id) + '" aria-label="' + esc(c.approve.label + ': ' + item.title) + '">' + esc(c.approve.label) + '</button></div>';
      }
      var error = ui.actionError && ui.actionError.id === item.id ? actionErrorHtml('flex:1 1 100%') : '';
      var kindTag = item.kind === 'action' ? 'Action · ' : item.kind === 'approval' ? 'Run approval · ' : '';
      var arrived = ui.seenRows && !ui.seenRows[item.id];
      if (grouped) {
        // Inside a group the title is the group's; the line is what differs.
        return '<li class="row grow' + (arrived ? ' arrive' : '') + (current ? ' is-current' : '') + '" data-row="' + esc(item.id) + '"' + (current ? ' aria-current="true"' : '') + '><button type="button" class="row-main" data-action="select" data-id="' + esc(item.id) + '"' + (opening ? ' aria-disabled="true"' : '') + ' aria-label="' + esc(item.title + ' ' + (item.detail || '') + '. ' + meta) + '">' +
          distinguisherHtml(item) + '<span class="row-meta"><span>' + esc(meta) + '</span></span></button>' + acts +
          (ui.composer && ui.composer.id === item.id ? composerHtml(item) : '') + error + '</li>';
      }
      return '<li class="row' + (arrived ? ' arrive' : '') + (current ? ' is-current' : '') + '" data-row="' + esc(item.id) + '"' + (current ? ' aria-current="true"' : '') + '><button type="button" class="row-main" data-action="select" data-id="' + esc(item.id) + '"' + (opening ? ' aria-disabled="true"' : '') + ' aria-label="' + esc(item.title + '. ' + meta) + '">' +
        '<span class="row-av" aria-hidden="true">' + askerAvatar(item.asker_kind, item.asker, 'row') + '</span>' +
        // Repeated titles step back to one muted line; what differs leads.
        (repeatedTitle && distinguisherHtml(item)
          ? distinguisherHtml(item) + '<span class="row-title is-repeat">' + esc(splitHeadline(item.title).headline) + '</span>'
          : '<span class="row-title">' + esc(splitHeadline(item.title).headline) + '</span>') +
        '<span class="row-meta"><span>' + esc(kindTag + meta) + '</span></span></button>' + acts +
        (ui.composer && ui.composer.id === item.id ? composerHtml(item) : '') + error + '</li>';
    }

    /**
     * The queue, with decisions that share a title folded into one group: the
     * title once with a count, then one compact line per decision led by what
     * differs. Five "merge stopped" approvals are one thing to scan, not five.
     */
    function queueRowsHtml(items) {
      var order = [];
      var groups = {};
      items.forEach(function bucket(item) {
        var key = splitHeadline(item.title).headline;
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(item);
      });
      return order.map(function render(key) {
        var members = groups[key];
        var distinct = members.every(function has(item) { return Boolean(distinguisherHtml(item)); });
        if (members.length < 2 || !distinct) return members.map(function one(item) { return rowHtml(item); }).join('');
        var gid = 'grp-' + members[0].id;
        return '<li class="qgroup" aria-labelledby="' + gid + '"><p class="qgroup-h" id="' + gid + '"><span class="row-av" aria-hidden="true">' + askerAvatar(members[0].asker_kind, members[0].asker, 'row') + '</span><span class="qgroup-t">' + esc(key) + '</span>' +
          '<span class="qgroup-n">' + members.length + '</span></p><ul class="qgroup-rows" role="list">' +
          members.map(function member(item) { return rowHtml(item, { grouped: true }); }).join('') + '</ul></li>';
      }).join('');
    }

    /**
     * Rows that share a title differ somewhere in the question: usually the
     * command or the PR. Show that, so five "merge stopped" rows read as five
     * different merges.
     */
    function distinguisherHtml(item) {
      var head = splitHeadline(item.detail || '');
      var source = head.body || (head.headline !== splitHeadline(item.title).headline ? head.headline : '');
      if (!source) return '';
      var body = structureBody(source);
      var text = body.commands[0] || body.lede[0] || (body.facts[0] ? body.facts[0].v : '') || source;
      if (!text) return '';
      return '<span class="row-sub' + (body.commands[0] ? ' is-cmd' : '') + '">' + esc(text.length > 90 ? text.slice(0, 89) + '…' : text) + '</span>';
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
          ' <button type="button" class="text-btn" data-action="open" data-url="' + esc(window.OrgXLinks.workLedger({ center: s.workspace && s.workspace.id, range: '30d' })) + '">Review in OrgX ↗</button></p>';
      }
      return html ? '<div class="proof">' + html + '</div>' : '';
    }

    function skeletonHtml() {
      // Cold start: the header frame and the real OrgX mark revealing in the
      // space the content will take, so nothing shifts when data lands.
      // The panel's own shape, arriving: header, attention line, queue and the
      // decision, shimmering in place, so the first paint lands without a jump.
      var mark = Brand ? '<span class="pn-mark-slot pn-breathe">' + Brand.mark(22) + '</span>' : '<span class="pn-mark-slot"></span>';
      var frame = ui.mode === 'global'
        ? '<header class="top">' + mark + '<div class="top-id"><span class="sk sk-ws"></span></div><span class="sk sk-tab"></span><span class="sk sk-tab"></span><span class="sk sk-tab"></span></header>'
        : '';
      // The stage: the mark in the middle of the open view with the team's
      // lights in orbit (panel-brand.js), and under it what the wait means.
      var shape = '<div class="pn-skel" aria-hidden="true">' +
        (Brand ? Brand.bootHtml(bootCaptionHtml()) : '<div class="pn-boot">' + bootCaptionHtml() + '</div>') + '</div>';
      return frame + shape + '<p class="sr-only">Loading your decisions.</p>';
    }

    /**
     * The line under the skeleton. It changes as the wait grows, so a slow
     * network on a phone never looks like a panel that is broken, and after
     * a while it offers a way out instead of shimmering forever.
     */
    function bootCaptionHtml() {
      if (ui.offline) return '<p class="sk-cap is-now" role="status">You’re offline. The panel loads when you’re back.</p>';
      if (ui.bootStage === 'stalled') {
        return '<div class="sk-stall" role="status"><p class="sk-cap is-now">OrgX hasn’t answered yet.</p>' +
          '<div class="sk-stall-acts"><button type="button" class="secondary-btn" data-action="refresh">Try again</button>' +
          '<button type="button" class="text-btn" data-action="open" data-url="' + ORGX_HOME + '">Open OrgX ↗</button></div></div>';
      }
      if (ui.bootStage === 'slow') return '<p class="sk-cap is-now" role="status">Still reading. OrgX is taking longer than usual.</p>';
      return '<p class="sk-cap">Reading your workspace</p>';
    }

    function signedOutHtml() {
      // Not connected yet, or connected without the Read scope: the steps,
      // named for the app the panel is inside, and a button that checks again.
      var scope = Boolean(ui.auth && ui.auth.code === 'insufficient_scope');
      var mark = Brand ? '<span class="so-mark" aria-hidden="true">' + Brand.mark(40) + '</span>' : '';
      var steps = scope
        ? [['Reconnect OrgX', hostFill('In {settings}, open OrgX and allow it to read your initiatives.')],
           ['Check again below', 'The panel reads your workspace as soon as it can.']]
        : [[hostFill('Add OrgX in {settings}'), 'The connector address is mcp.useorgx.com/mcp. It takes about a minute.'],
           ['Sign in and choose Read or Operate', 'Read shows your decisions here. Operate lets you decide them here.'],
           ['Check again below', 'The panel reads your workspace as soon as it can.']];
      var checking = ui.readState.phase === 'loading';
      return header() + '<section class="pn-so" aria-labelledby="so-h">' + mark +
        '<h2 class="so-h" id="so-h">' + esc(scope ? 'OrgX needs permission to read your workspace.' : hostFill('Connect OrgX to {host}.')) + '</h2>' +
        '<p class="so-sub">' + esc(scope ? 'The connection is there, but it can’t see your initiatives yet.' : hostFill('Decide agent work, watch it move and keep the receipts, without leaving {host}.')) + '</p>' +
        '<ol class="so-steps">' + steps.map(function step(x, i) {
          return '<li class="so-step"><span class="so-n" aria-hidden="true">' + (i + 1) + '</span><span class="so-t"><b>' + esc(x[0]) + '</b><span>' + esc(x[1]) + '</span></span></li>';
        }).join('') + '</ol>' +
        '<div class="so-acts"><button type="button" class="pn-btn st-cta" data-action="refresh"' + (checking ? ' aria-busy="true" disabled' : '') + '>' + (checking ? 'Checking…' : 'I’ve connected it') + '</button>' +
        '<button type="button" class="secondary-btn" data-action="open" data-url="' + ORGX_HOME + '">Open OrgX ↗</button></div></section>';
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
      var html = header() + workspaceMenuHtml() + noticeHtml();
      if (s.state === 'no_workspace') {
        return html + '<p class="lede">Choose a workspace to see its decisions.</p>' +
          '<button type="button" class="secondary-btn" data-action="workspaces" aria-haspopup="true" aria-controls="pn-ws-menu" aria-expanded="' + (ui.wsOpen ? 'true' : 'false') + '">Choose a workspace</button>';
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
      if (ui.tab === 'start' && Start) return html + startViewHtml(ctx);
      if (ui.tab === 'work' && Views) {
        var wv = workView();
        return html + Views.workHtml(wv.work, wv.phase, startLinkHtml(wv.work && wv.work.items.length ? 'Start or delegate more work' : 'Start work'),
          { sel: ui.workSel, filter: ui.workFilter, query: ui.workQuery, expanded: ui.workExpanded });
      }
      if (ui.tab === 'done' && Views) {
        var workRange = workRangeOf(ui.doneRange);
        return html + Views.doneHtml({
          lens: ui.doneLens,
          receipts: ui.receipts[workRange] ? withRow(ui.receipts[workRange]) : null,
          receiptsPhase: ui.receiptsPhase,
          rsel: ui.receiptSel,
          receiptDetail: ui.receiptSel ? ui.receiptDetail[ui.receiptSel] || null : null,
          receiptPhase: ui.receiptSel && !ui.receiptDetail[ui.receiptSel] ? 'loading' : 'ready',
          receiptCall: ui.receiptSel ? ui.receiptCalls[ui.receiptSel] || (!isGallery && !receiptTokenFor(ui.receiptSel) ? { phase: 'unavailable' } : undefined) : undefined,
          session: ui.session,
          sel: ui.openReceipt,
          range: ui.doneLens === 'work' ? workRange : ui.doneRange,
          history: ui.history[ui.doneRange] || null,
          historyPhase: ui.historyPhase,
          page: ui.donePage,
          workspaceId: s.workspace && s.workspace.id,
          overviewHtml: proofHtml(s, true),
          launch: startLinkHtml('Start something next'),
        });
      }
      if (isFirstUse(s)) return html + calmHtml(s, true);
      if (calm) return html + calmHtml(s);
      // The whole queue, with the open decision marked in place: the list's
      // count is the attention line's count, never one short of it.
      var hidden = Math.max(0, s.attention.pending - s.queue.length);
      html += '<div class="pn-split">' +
        '<div class="pn-att">' + attentionLine(s) + '</div>' +
        '<div class="pn-detail">' + (s.focus ? packetHtml(s.focus, 'h2') : '') + '</div>' +
        (s.queue.length > 1 || !s.focus ? '<div class="pn-list"><h2 class="queue-head">Your queue <span class="queue-n">' + s.attention.pending + '</span></h2><ul class="queue">' + queueRowsHtml(s.queue) + '</ul>' +
          (hidden ? '<p class="sub">' + hidden + ' more in OrgX. <button type="button" class="text-btn" data-action="open" data-url="' + esc(window.OrgXLinks.decisions({ status: 'pending' })) + '">All decisions ↗</button></p>' : '') + '</div>' : '') +
        '</div>';
      return html;
    }

    /**
     * Nothing needs a decision. Say so once, show the work that is moving
     * without the person (so "clear" never reads as "idle"), and invite the
     * next thing: a prompt that opens Start with the cursor already in it.
     */
    function calmHtml(s, firstUse) {
      var w = workView().work;
      var items = w && w.items ? w.items : [];
      var agents = {};
      items.forEach(function n(i) { agents[i.agent] = true; });
      var nAgents = Object.keys(agents).length;
      var blocked = items.filter(function b(i) { return i.state === 'blocked'; }).length;
      // Only say what is known: before In progress has been read, say nothing about it.
      var moving = !w ? ''
        : items.length ? nAgents + (nAgents === 1 ? ' agent is' : ' agents are') + ' working on ' + items.length + (items.length === 1 ? ' task' : ' tasks') + (blocked ? ', ' + blocked + ' blocked' : '') + '.'
        : 'No agent work is running right now.';
      var glyph = '<span class="cm-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg></span>';
      var prompt = Start && ui.mode === 'global'
        ? '<button type="button" class="cm-prompt" data-action="start-open"><span class="cm-pp">What should get done next?</span><span class="cm-go" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span></button>'
        : '';
      var see = items.length ? '<button type="button" class="text-btn" data-action="tab" data-tab="work">See what’s running</button>' : '';
      // Ways in, the way the other apps do it: a rail of concrete jobs under
      // the prompt. Each one opens Start with the words already in the box.
      var rail = Start && ui.mode === 'global'
        ? '<div class="cm-rail" role="list" aria-label="Try">' + Start.starters(launchContext(s).initiative).map(function chip(x) {
          return '<button type="button" class="st-idea" role="listitem" data-action="start-fill" data-id="' + esc(x.agent) + '" data-text="' + esc(x.text) + '">' + esc(x.text) + '</button>';
        }).join('') + '</div>'
        : '';
      if (firstUse) {
        // A new workspace: nothing to be clear of yet. Invite the first job.
        return '<section class="pn-calm is-first" aria-labelledby="cm-h">' +
          (Brand ? '<span class="cm-mark is-brand" aria-hidden="true">' + Brand.mark(26) + '</span>' : '') +
          '<h2 class="cm-h" id="cm-h">Start your first piece of work.</h2>' +
          '<p class="cm-sub">Say what should get done. OrgX plans it, runs it with your agents and brings decisions back here.</p>' +
          (prompt || '<button type="button" class="pn-btn st-cta" data-action="open" data-url="' + ORGX_HOME + '">Open OrgX ↗</button>') + rail + '</section>';
      }
      return '<section class="pn-calm" aria-labelledby="cm-h">' + glyph +
        '<h2 class="cm-h" id="cm-h">You’re clear.</h2>' +
        '<p class="cm-sub">Nothing needs your decision. ' + esc(moving) + (see ? ' ' + see : '') + '</p>' +
        prompt + rail + '</section>' + proofHtml(s, true);
    }

    /** The receipt behind the open decision, once read; starts the read the first time. */
    function behindFor(focus) {
      if (!Receipts) return '';
      if (ui.behind[focus.id] === undefined) later(function read() { maybeFetchBehind(focus); }, 0);
      var b = ui.behind[focus.id];
      return b && b !== 'loading' ? Receipts.behindHtml(b) : '';
    }

    /** One way to the Start tab from any view, instead of prompt lists everywhere. */
    function startLinkHtml(label) {
      if (!Start || ui.mode !== 'global') return '';
      return '<div class="st-link"><button type="button" class="pn-btn ghost" data-action="tab" data-tab="start">' +
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>' +
        esc(label) + '</button></div>';
    }

    function startViewHtml(ctx) {
      var busy = {};
      var w = workView().work;
      if (w && w.items) w.items.forEach(function n(i) { busy[i.agent] = (busy[i.agent] || 0) + 1; });
      return Start.html({ text: ui.startText, agent: ui.startAgent, verb: ui.startVerb, status: ui.startStatus, initiative: ctx.initiative || '', workAgents: busy, whoOpen: ui.startWhoOpen });
    }

    function startSentence() {
      return Start ? Start.sentence(ui.startVerb || (ui.startAgent ? 'delegate' : 'initiative'), { text: ui.startText, agent: ui.startAgent }) : '';
    }

    function launchContext(s) {
      var initiative = null;
      (s && s.queue || []).some(function pick(item) { initiative = item.initiative_title || null; return Boolean(initiative); });
      return { initiative: initiative };
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

    var bootLeaving = false;
    function render() {
      // The first content after the cold start arrives as one move: the stage
      // falls away and the view rises in its place (reduced motion: a cut).
      if (!bootLeaving && ui.snapshot && root.querySelector('.pn-boot')) {
        bootLeaving = true;
        transition('boot', function firstPaint() { try { render(); } finally { bootLeaving = false; } });
        return;
      }
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
      if (ui.snapshot && ui.snapshot.state === 'ok') {
        var seen = {};
        ui.snapshot.queue.forEach(function mark(item) { seen[item.id] = true; });
        ui.seenRows = seen;
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

    function setTab(tab, quiet, after) {
      if (['needs', 'work', 'done', 'start'].indexOf(tab) === -1 || (tab === 'start' && !Start)) return;
      var changed = ui.tab !== tab;
      var order = ['needs', 'work', 'done', 'start'];
      var dir = order.indexOf(tab) >= order.indexOf(ui.tab) ? 'fwd' : 'back';
      function apply() {
        ui.tab = tab;
        ui.composer = changed ? null : ui.composer;
        ui.startWhoOpen = false;
        if (tab === 'work' && (!ui.work || ui.workPhase === 'failed')) { fetchWork(); return; }
        // Done › Work reads its receipts the first time it opens; the read renders the loading rows.
        if (tab === 'done' && ui.doneLens === 'work' && Receipts && !ui.receipts[workRangeOf(ui.doneRange)]) fetchReceipts(workRangeOf(ui.doneRange));
        else render();
        if (changed && !quiet) {
          var t = root.querySelector('#pn-tab-' + tab);
          if (t) t.focus();
          announce(tab === 'needs' ? 'Needs you.' : tab === 'work' ? 'In progress.' : tab === 'done' ? 'Done.' : 'Start.');
        }
        if (after) after();
      }
      if (changed) transition('tab', apply, dir); else apply();
    }

    /**
     * What In progress shows. The panel's own read when it has one; otherwise
     * the live feed's rows (the same projection, without proof enrichment), so
     * the tab never says "13" over a body that says it could not read anything.
     */
    function workView() {
      if (ui.work && ui.work.status === 'ok') return { work: ui.work, phase: ui.workPhase };
      if (ui.liveWork && ui.liveWork.items) {
        var live = window.OrgXLinks.live();
        return {
          work: { status: 'ok', total: ui.liveWork.items.length, items: ui.liveWork.items.map(function row(i) {
            return {
              id: i.id, agent: i.agent, title: i.title, state: i.state === 'running' || i.state === 'blocked' ? i.state : 'queued',
              url: i.url || live, domain: i.domain || null, updated_at: i.updated_at || null, stale: Boolean(i.stale),
            };
          }) },
          phase: ui.workPhase === 'loading' ? 'loading' : 'ready',
        };
      }
      return { work: ui.work, phase: ui.workPhase };
    }

    /** Done's range. "This session" is local; the others read OrgX's decision history once per range. */
    function setDoneRange(range) {
      ui.doneRange = range || 'session';
      ui.openReceipt = null;
      ui.donePage = 1;
      if (ui.doneLens === 'work' && Receipts) { ui.receiptSel = null; fetchReceipts(workRangeOf(ui.doneRange)); return; }
      if (ui.doneRange === 'session' || isGallery) {
        if (isGallery && ui.doneRange !== 'session') ui.history[ui.doneRange] = gallery.history(ui.doneRange);
        render();
        return;
      }
      var cached = ui.history[ui.doneRange];
      if (cached && cached.status === 'ok') { render(); return; }
      ui.historyPhase = 'loading';
      delete ui.history[ui.doneRange];
      render();
      var gen = ui.generation;
      var asked = ui.doneRange;
      R.callToolResult('orgx_panel_snapshot', { view: 'history', range: asked }).then(function onHistory(result) {
        if (gen !== ui.generation) return;
        var data = result && result.data;
        if (isSnapshot(data)) accept(data, result.meta || null, 'refresh');
        ui.history[asked] = data && data.history ? data.history : { status: 'unavailable', range: asked, items: [] };
        ui.historyPhase = 'ready';
        if (ui.doneRange === asked) render();
      }, function onHistoryError(error) {
        if (gen !== ui.generation) return;
        ui.history[asked] = { status: 'unavailable', range: asked, items: [], reason: safeErrorText(error, 'Decision history could not be read right now.', 160) };
        ui.historyPhase = 'ready';
        if (ui.doneRange === asked) render();
      });
    }

    /** Work receipts read by range; "This session" is a decisions idea, so Work shows 7 days. */
    function workRangeOf(range) { return range === 'today' || range === '30d' ? range : '7d'; }
    /** A receipt list with the open receipt's row kept, even when it came from elsewhere (a decision). */
    function withRow(list) {
      if (!ui.receiptSel || !list || list.status !== 'ok' || !ui.receiptRows[ui.receiptSel]) return list;
      if (list.items.some(function has(r) { return r.id === ui.receiptSel; })) return list;
      return Object.assign({}, list, { items: [ui.receiptRows[ui.receiptSel]].concat(list.items) });
    }
    function sameReceiptDocument(left, right) {
      return left && right && (left.receipt_id || null) === (right.receipt_id || null) &&
        (left.receipt_review_revision || null) === (right.receipt_review_revision || null);
    }
    function rememberReceiptRow(row) {
      var previous = ui.receiptRows[row.id];
      if (previous && !sameReceiptDocument(previous, row)) {
        delete ui.receiptCalls[row.id];
        delete ui.receiptDetail[row.id];
        delete ui.receiptTokens[row.id];
      }
      ui.receiptRows[row.id] = row;
    }
    function rememberRows(list) {
      if (list && list.items) list.items.forEach(rememberReceiptRow);
    }

    function receiptRangeQuery(range) {
      var now = new Date();
      var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (range === 'today' ? 0 : range === '30d' ? 29 : 6));
      return 'since:' + start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-' + String(start.getDate()).padStart(2, '0');
    }

    function fetchReceipts(range) {
      var cached = ui.receipts[range];
      if (cached && cached.status === 'ok') { render(); return; }
      if (isGallery) { ui.receipts[range] = gallery.receipts(range); rememberRows(ui.receipts[range]); ui.receiptsPhase = 'ready'; render(); return; }
      ui.receiptsPhase = 'loading';
      delete ui.receipts[range];
      render();
      var gen = ui.generation;
      R.callWidgetRead('orgx_list_work_receipts', { query: receiptRangeQuery(range), limit: 50 }).then(function onReceipts(result) {
        if (gen !== ui.generation) return;
        var data = result && result.data;
        if (isSnapshot(data)) accept(data, result.meta || null, 'refresh');
        ui.receipts[range] = Receipts.normalizeList(data, receiptRangeQuery(range));
        rememberRows(ui.receipts[range]);
        adoptReceiptTokens(result && result.meta);
        ui.receiptsPhase = ui.receipts[range].status === 'ok' ? 'ready' : 'failed';
        if (ui.tab === 'done') render();
      }, function onReceiptsError(error) {
        if (gen !== ui.generation) return;
        ui.receipts[range] = { status: 'unavailable', query: '', total: 0, items: [], reason: safeErrorText(error, 'Work receipts could not be read right now.', 160) };
        ui.receiptsPhase = 'failed';
        if (ui.tab === 'done') render();
      });
    }

    function openWorkReceipt(id) {
      ui.receiptSel = !id || ui.receiptSel === id ? null : id;
      render();
      var open = ui.receiptSel;
      if (!open || ui.receiptDetail[open]) return;
      if (isGallery) { ui.receiptDetail[open] = gallery.receipt(open); render(); return; }
      var gen = ui.generation;
      R.callWidgetRead('orgx_get_work_receipt', { receipt_id: open }).then(function onReceipt(result) {
        if (gen !== ui.generation) return;
        var data = result && result.data;
        var detail = Receipts.normalizeDetail(data, open, ui.receiptRows[open]);
        if (detail && detail.row) rememberReceiptRow(detail.row);
        ui.receiptDetail[open] = detail;
        adoptReceiptTokens(result && result.meta, open);
        if (ui.receiptSel === open) render();
      }, function onReceiptError(error) {
        if (gen !== ui.generation) return;
        ui.receiptDetail[open] = { status: 'unavailable', id: open, reason: safeErrorText(error, 'This receipt could not be read right now.', 160), criteria: [], artifacts: [], uncertain: [] };
        if (ui.receiptSel === open) render();
      });
    }

    /** A person's call on a receipt, recorded in the ledger; the row shows it at once. */
    function recordReceiptCall(id, status) {
      if (!id || !status) return;
      var approvalToken = receiptTokenFor(id);
      if (!isGallery && !approvalToken) return;
      if (ui.receiptCalls[id] && ui.receiptCalls[id].phase === 'saving') return;
      var gen = ui.generation;
      var reviewedRow = ui.receiptRows[id];
      ui.receiptCalls[id] = { status: status, phase: 'saving' };
      render();
      var done = function saved() {
        if (gen !== ui.generation) return;
        ui.receiptCalls[id] = { status: status, phase: 'saved' };
        var row = ui.receiptRows[id];
        if (row) { row.outcome = status; row.outcome_source = 'human'; }
        Object.keys(ui.receipts).forEach(function each(k) {
          (ui.receipts[k].items || []).forEach(function upd(r) { if (r.id === id) { r.outcome = status; r.outcome_source = 'human'; } });
        });
        render();
        announce('Recorded your call.');
      };
      if (isGallery) { later(done, 400); return; }
      R.callToolResult('orgx_widget_receipt_call', { receipt_id: id, status: status, approval_token: approvalToken }).then(function onCall(result) {
        if (gen !== ui.generation) return;
        if (!sameReceiptDocument(reviewedRow, ui.receiptRows[id])) {
          delete ui.receiptCalls[id]; render(); return;
        }
        var data = result && result.data;
        if (data && data.recorded === true && data.receipt_id === id && data.status === status) {
          delete ui.receiptTokens[id]; done(); return;
        }
        ui.receiptCalls[id] = { status: status, phase: 'failed', reason: (data && data.reason) || 'Your call could not be confirmed. Reopen this receipt in the Work Ledger before trying again.' };
        render();
      }, function onCallError(error) {
        if (gen !== ui.generation) return;
        if (!sameReceiptDocument(reviewedRow, ui.receiptRows[id])) {
          delete ui.receiptCalls[id]; render(); return;
        }
        ui.receiptCalls[id] = { status: status, phase: 'failed', reason: safeErrorText(error, 'Your call could not be recorded. Try again.', 160) };
        render();
      });
    }

    /** The work behind the open decision: the ledger's receipts for its PR, read once per decision. */
    function maybeFetchBehind(focus) {
      if (!Receipts || !focus || ui.behind[focus.id] !== undefined) return;
      var pr = Receipts.prOf([focus.title, focus.question, focus.detail].filter(Boolean).join('\n'));
      if (!pr) { ui.behind[focus.id] = null; return; }
      ui.behind[focus.id] = 'loading';
      if (isGallery) { ui.behind[focus.id] = gallery.behind(pr); rememberRows(ui.behind[focus.id]); later(render, 0); return; }
      var gen = ui.generation;
      R.callWidgetRead('orgx_list_work_receipts', { query: 'pr:' + pr }).then(function onBehind(result) {
        if (gen !== ui.generation) return;
        var data = result && result.data;
        ui.behind[focus.id] = Receipts.normalizeList(data, 'pr:' + pr);
        rememberRows(ui.behind[focus.id]);
        if (ui.tab === 'needs' && ui.snapshot && ui.snapshot.focus && ui.snapshot.focus.id === focus.id) render();
      }, function onBehindError() {
        if (gen !== ui.generation) return;
        ui.behind[focus.id] = null;
      });
    }

    /** In progress is read only when opened: the same snapshot with view "work". */
    function fetchWork() {
      if (isGallery) {
        ui.work = gallery.work();
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
      if (live) live.update(snapshot.live || null);
      Object.keys(ui.rulings).forEach(function prune(id) {
        var r = ui.rulings[id];
        if (!findItem(id) && (r.phase === 'confirmed' || r.phase === 'rejected' || r.phase === 'elsewhere')) {
          ui.lastRuling = {
            id: id, action: r.action, title: r.title, elsewhere: r.phase === 'elsewhere',
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
        // A live change that arrived during this read waited for it.
        if (liveAgain) { liveAgain = false; scheduleLiveRefresh(); }
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
        transition('detail', function showGallery() {
          var item = findItem(id);
          if (item) s.focus = Object.assign({}, s.focus || {}, gallery.focus(item));
          render();
        });
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
      if (Host && context) Host.apply(context);
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
        return R.callWidgetRead('orgx_get_operation_status', { kind: 'decision', id: id }).then(function onStatus(result) {
          var status = result && result.data;
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
      var agreeing = isAgreementItem(item);
      function doneDetail(status) {
        if (!status) return 'recorded; status not available yet';
        if (agreeing) return action === 'approve' ? 'agents start; every receipt is judged against this bar' : 'OrgX redrafts it and asks again';
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
          if (Host && ui.rulings[id].phase === 'failed') Host.haptic('warn');
          render();
          return;
        }
        delete ui.answers[id];
        delete ui.notes[id];
        announce(pastTense(action === 'approve' ? ui.rulings[id].approveLabel : ui.rulings[id].rejectLabel, action) + ': ' + title);
        if (Host) Host.haptic('success');
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
      R.callWidgetRead('orgx_get_operation_status', { kind: 'decision', id: id }).then(function onStatus(result) {
        var status = result && result.data;
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
      if (ui.startWhoOpen && !event.target.closest('.st-menu, [data-action="start-who"]')) transition('menu', function dismiss() { ui.startWhoOpen = false; render(); });
      var el = event.target.closest('[data-action]');
      if (!el || !root.contains(el) || el.disabled) return;
      var action = el.getAttribute('data-action');
      var id = el.getAttribute('data-id');
      // During the tour only the practice press is live; picks and send-back wait.
      if (tour && tour.active() && ['approve', 'option', 'toggle-option', 'reject-option', 'sendback', 'submit-sendback'].indexOf(action) !== -1) return;
      switch (action) {
        case 'workspaces': transition('menu', function toggleWs() { if (ui.wsOpen) closeWorkspaces(true); else openWorkspaces(); }); break;
        case 'workspaces-retry': ui.workspaces = null; ui.wsPhase = 'idle'; openWorkspaces(); break;
        case 'switch-workspace': switchWorkspace(id); break;
        case 'refresh':
          if (ui.auth) { ui.auth = null; ui.bootStage = 'reading'; }
          fetchSnapshot(ui.snapshot && ui.snapshot.selection.status === 'selected' && ui.snapshot.focus ? ui.snapshot.focus.id : null, 'refresh');
          break;
        case 'display-mode': requestDisplay(el.getAttribute('data-mode')); break;
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
        case 'tour': startTour(); break;
        case 'work-retry': ui.workPhase = 'failed'; fetchWork(); break;
        case 'receipt':
          transition('detail', function openReceipt() {
            ui.openReceipt = !id || ui.openReceipt === id ? null : id;
            render();
            focusFirst(ui.openReceipt ? '.pn-md-detail .md-close' : '[data-action="receipt"][aria-pressed]');
          });
          break;
        case 'work-select':
          transition('detail', function openWork() {
            ui.workSel = !id || ui.workSel === id ? null : id;
            render();
            focusFirst(ui.workSel ? '.pn-md-detail .md-close' : '.wk-row');
          });
          break;
        case 'work-filter': ui.workFilter = id || 'all'; if (id === 'all') ui.workQuery = ''; render(); focusFirst('[data-action="work-filter"][aria-pressed="true"]'); break;
        case 'agent-expand': transition('expand', function expand() { ui.workExpanded[id] = !ui.workExpanded[id]; render(); }); break;
        case 'agent-focus':
          // Show that agent's whole list in place rather than filtering it away.
          ui.workFilter = 'all'; ui.workQuery = ''; ui.workExpanded[id] = true;
          render();
          var agentEl = root.querySelector('.ag[data-agent="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
          if (agentEl) { agentEl.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); var firstRow = agentEl.querySelector('.wk-row'); if (firstRow) firstRow.focus({ preventScroll: true }); }
          break;
        case 'done-range': transition('swap', function range() { setDoneRange(id); }); break;
        // From a ruling's confirmation: Done, on the decisions this panel settled.
        case 'done-decisions':
          ui.doneLens = 'decisions';
          if (!ui.history[ui.doneRange] && ui.doneRange !== 'session') ui.doneRange = 'session';
          setTab('done');
          break;
        case 'done-lens':
          transition('swap', function lens() {
            ui.doneLens = id === 'decisions' ? 'decisions' : 'work';
            ui.donePage = 1;
            setDoneRange(ui.doneLens === 'work' ? workRangeOf(ui.doneRange) : ui.doneRange);
            focusFirst('[data-action="done-lens"][aria-pressed="true"]');
          });
          break;
        case 'work-receipt':
          transition('detail', function openRc() {
            openWorkReceipt(id);
            focusFirst(ui.receiptSel ? '.pn-md-detail .md-close' : '.rc-row');
          });
          break;
        case 'behind-open':
          ui.doneLens = 'work';
          setTab('done', true, function showBehind() {
            fetchReceipts(workRangeOf(ui.doneRange));
            ui.receiptSel = null;
            openWorkReceipt(id);
            focusFirst('.pn-md-detail .md-close');
          });
          break;
        case 'receipt-call': recordReceiptCall(id, el.getAttribute('data-status')); break;
        case 'exp-edit': {
          var fx = findItem(id);
          var bx = agreementOf(fx);
          if (!fx || !bx || !Launch) break;
          el.setAttribute('aria-busy', 'true');
          Launch.send(Expect.editSentence(bx, fx.initiative_title || splitHeadline(fx.question || fx.title).headline)).then(function edited(outcome) {
            el.removeAttribute('aria-busy');
            el.textContent = outcome === 'sent' ? 'Sent to the chat' : outcome === 'copied' ? 'Copied. Paste it into the chat' : 'Type it in the chat';
            announce(outcome === 'sent' ? 'Sent to the chat. Agree here once it reads right.' : outcome === 'copied' ? 'Copied. Paste it into the chat.' : 'Couldn’t send it. Type it in the chat.');
          });
          break;
        }
        case 'receipt-iterate': {
          var rrow = ui.receiptRows[id] || (ui.receiptDetail[id] && ui.receiptDetail[id].row);
          if (!rrow || !Launch || !Receipts) break;
          el.setAttribute('aria-busy', 'true');
          Launch.send(Receipts.iterateSentence(rrow)).then(function iterated(outcome) {
            el.removeAttribute('aria-busy');
            el.textContent = outcome === 'sent' ? 'Sent to the chat' : outcome === 'copied' ? 'Copied. Paste it into the chat' : 'Type it in the chat';
            announce(outcome === 'sent' ? 'Sent to the chat.' : outcome === 'copied' ? 'Copied. Paste it into the chat.' : 'Couldn’t send it. Type it in the chat.');
          });
          break;
        }
        case 'done-more': transition('expand', function more() { ui.donePage += 1; render(); }); break;
        case 'start-open': setTab('start', true, function focusComposer() { focusFirst('#st-text'); }); break;
        case 'start-who':
          transition('menu', function toggleWho() {
            ui.startWhoOpen = !ui.startWhoOpen;
            render();
            focusFirst(ui.startWhoOpen ? '.st-opt[aria-checked="true"]' : '[data-action="start-who"]');
          });
          break;
        case 'start-agent':
          ui.startAgent = id || '';
          // Picking an agent means handing it to them; OrgX picks keeps the chosen verb.
          if (id) ui.startVerb = 'delegate'; else if (ui.startVerb === 'delegate') ui.startVerb = '';
          ui.startStatus = null;
          transition('menu', function picked() { ui.startWhoOpen = false; render(); focusFirst('#st-text'); });
          break;
        case 'start-verb': ui.startVerb = id || ''; ui.startStatus = null; render(); focusFirst('[data-action="start-verb"][aria-checked="true"]'); break;
        case 'start-fill':
          ui.startText = el.getAttribute('data-text') || '';
          ui.startAgent = id || ui.startAgent;
          if (ui.startAgent) ui.startVerb = 'delegate';
          else if (/^Plan the next steps/.test(ui.startText)) ui.startVerb = 'plan';
          ui.startStatus = null;
          // From another view (the calm rail): open Start with the words in the box.
          if (ui.tab !== 'start') { setTab('start', true, function placeCaret() { var t = root.querySelector('#st-text'); if (t) { t.focus(); try { t.setSelectionRange(t.value.length, t.value.length); } catch (_) { /* not a text input */ } } }); break; }
          render();
          var ta = root.querySelector('#st-text');
          if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) { /* not a text input */ } }
          break;
        case 'start-send': {
          var sentenceToSend = startSentence();
          if (!sentenceToSend || !Launch) break;
          el.setAttribute('aria-busy', 'true');
          Launch.send(sentenceToSend).then(function sentStart(outcome) {
            ui.startStatus = outcome;
            if (outcome === 'sent') ui.startText = '';
            render();
            announce(outcome === 'sent' ? 'Sent to the chat.' : outcome === 'copied' ? 'Copied. Paste it into the chat.' : 'Couldn’t send it. Type it in the chat.');
          });
          break;
        }
        case 'why': transition('expand', function why() { ui.whyOpen = ui.whyOpen === id ? null : id; render(); focusFirst('[data-action="why"]'); }); break;
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
      if (area.matches('textarea[data-action="start-text"]')) {
        ui.startText = area.value;
        ui.startStatus = null;
        var preview = root.querySelector('.st-preview');
        var go = root.querySelector('[data-action="start-send"]');
        var said = startSentence();
        if (preview) preview.innerHTML = Start.previewHtml({ text: ui.startText, agent: ui.startAgent, verb: ui.startVerb });
        if (go) { go.disabled = !said; if (said) go.removeAttribute('aria-disabled'); else go.setAttribute('aria-disabled', 'true'); }
        var st = root.querySelector('.st-status');
        if (st) st.remove();
        return;
      }
      if (area.matches('input[data-action="ws-query"]')) {
        ui.wsQuery = area.value;
        var wcaret = area.selectionStart;
        render();
        var wsAgain = root.querySelector('input[data-action="ws-query"]');
        if (wsAgain) { wsAgain.focus(); try { wsAgain.setSelectionRange(wcaret, wcaret); } catch (_) { /* not a text input */ } }
        return;
      }
      if (area.matches('input[data-action="work-query"]')) {
        ui.workQuery = area.value;
        var caret = area.selectionStart;
        render();
        var again = root.querySelector('input[data-action="work-query"]');
        if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (_) { /* not a text input */ } }
      }
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
        var order = Start ? ['needs', 'work', 'done', 'start'] : ['needs', 'work', 'done'];
        var at = order.indexOf(tabEl.getAttribute('data-tab'));
        var next = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
        event.preventDefault();
        setTab(order[next]);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target && event.target.id === 'st-text') {
        event.preventDefault();
        var goBtn = root.querySelector('[data-action="start-send"]');
        if (goBtn && !goBtn.disabled) goBtn.click();
        return;
      }
      if (event.key !== 'Escape') return;
      if (ui.startWhoOpen) { event.preventDefault(); transition('menu', function esc() { ui.startWhoOpen = false; render(); focusFirst('[data-action="start-who"]'); }); return; }
      if (ui.wsOpen) { event.preventDefault(); transition('menu', function escWs() { closeWorkspaces(true); }); return; }
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

    document.addEventListener('pointerdown', function pointerModality() {
      document.documentElement.setAttribute('data-modality', 'pointer');
    }, true);
    document.addEventListener('keydown', function keyModality(event) {
      if (event.key === 'Tab' || event.key.indexOf('Arrow') === 0 || event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
        document.documentElement.setAttribute('data-modality', 'keyboard');
      }
    }, true);

    document.addEventListener('pointerdown', function closeOnOutside(event) {
      if (!ui.wsOpen) return;
      var t = event.target;
      if (t && t.closest && (t.closest('#pn-ws-menu') || t.closest('[data-action="workspaces"]'))) return;
      closeWorkspaces(false);
    });

    function dispose() {
      ui.generation += 1;
      timers.forEach(function clear(id) { window.clearTimeout(id); });
      timers = [];
    }
    function resetScope() {
      dispose();
      if (live) live.stop();
      ui.live = 'off'; ui.liveWork = null; ui.renderPending = false;
      inflight = null; pendingFocus = undefined; lastFocusRequest = null;
      ui.readState = { phase: 'idle' };
      ui.tokens = {}; ui.receiptTokens = {}; ui.rulings = {}; ui.lastRuling = null; ui.composer = null;
      ui.selections = {}; ui.rejectPicks = {}; ui.answers = {}; ui.notes = {}; ui.fieldErrors = {};
      ui.actionError = null; ui.changedSince = null; ui.chatCannotDecide = false;
      ui.listOpen = false; ui.evidenceOpen = false; ui.wholeQ = null;
      ui.tab = 'needs'; ui.work = null; ui.workPhase = 'idle'; ui.session = []; ui.openReceipt = null;
      ui.workSel = null; ui.workFilter = 'all'; ui.workQuery = ''; ui.workExpanded = {};
      ui.doneRange = 'session'; ui.history = {}; ui.historyPhase = 'idle'; ui.donePage = 1;
      ui.doneLens = 'work'; ui.receipts = {}; ui.receiptsPhase = 'idle'; ui.receiptSel = null;
      ui.receiptDetail = {}; ui.receiptRows = {}; ui.receiptCalls = {}; ui.behind = {}; ui.whyOpen = null;
      ui.startStatus = null; ui.startWhoOpen = false;
      ui.wsOpen = false; ui.wsPhase = 'idle'; ui.workspaces = null; ui.wsError = null; ui.wsSwitchingTo = null;
      ui.seenRows = null; ui.lastCounts = null;
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

    /**
     * The gallery's fixtures live in panel-gallery.js, which is not inlined
     * into the MCP Apps resource: it loads here, only for ?gallery=true, and
     * reads the panel's own state and functions through this context.
     */
    function bootGallery() {
      gallery = window.OrgXPanelGallery.boot({
        ui: ui,
        params: params,
        render: render,
        accept: accept,
        clock: clock,
        useShare: function useShare(modelContext) {
          share = X.createShareController({ modelContext: modelContext });
          return share;
        },
      });
      gallery.run();
    }
    if (isGallery) {
      if (window.OrgXPanelGallery) { bootGallery(); return; }
      var galleryScript = document.createElement('script');
      galleryScript.src = 'shared/panel/panel-gallery.js';
      galleryScript.onload = bootGallery;
      galleryScript.onerror = function galleryMissing() { render(); };
      document.body.appendChild(galleryScript);
      return;
    }

    // ── Live updates ───────────────────────────────────────────────────────
    // The feed says what changed; the panel re-reads its own snapshot to show
    // it. These reads are quiet: no loading state, no announcement of the read
    // itself, and no repaint while the person is typing.
    var LIVE_DEBOUNCE_MS = 300;
    var LIVE_MIN_GAP_MS = 1500;
    var FALLBACK_STALE_MS = 30000;
    var liveTimer = null;
    var liveInflight = false;
    var liveAgain = false;
    var liveLastAt = 0;

    function typingInPanel() {
      var el = document.activeElement;
      return Boolean(el && root.contains(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'radio')));
    }
    function liveRender() {
      if (typingInPanel()) { ui.renderPending = true; return; }
      ui.renderPending = false;
      render();
    }
    root.addEventListener('focusout', function flushPending() {
      if (!ui.renderPending) return;
      window.setTimeout(function afterFocusMoves() {
        if (ui.renderPending && !typingInPanel()) { ui.renderPending = false; render(); }
      }, 0);
    });

    function shownQueue() {
      var map = {};
      var s = ui.snapshot;
      if (s && s.state === 'ok') s.queue.forEach(function each(item) { map[item.id] = item.version || ''; });
      return map;
    }

    /** Decisions settled somewhere else leave the list now; the re-read follows. */
    function dropSettled(ids) {
      var s = ui.snapshot;
      if (!s || s.state !== 'ok') return;
      var dropped = 0;
      ids.forEach(function drop(id) {
        // Our own rulings already narrate themselves, and a decision someone is
        // replying to stays put until the re-read says what happened to it.
        if (ui.rulings[id] || (ui.composer && ui.composer.id === id)) return;
        if (s.focus && s.focus.id === id && typingInPanel()) return;
        var before = s.queue.length;
        s.queue = s.queue.filter(function keep(item) { return item.id !== id; });
        if (s.queue.length < before) {
          dropped += 1;
          s.attention.pending = Math.max(0, s.attention.pending - 1);
        }
      });
      if (!dropped) return;
      announce(dropped === 1 ? 'A decision was settled elsewhere.' : dropped + ' decisions were settled elsewhere.');
      // The count changes now; the row collapses out before the repaint, so
      // the eye sees which one left rather than the list jumping.
      var badge = root.querySelector('#pn-tab-needs .pn-tab-n');
      if (badge) { badge.textContent = String(s.attention.pending); badge.classList.add('tick'); }
      var leaving = ids.map(function row(id) { return root.querySelector('[data-row="' + id + '"]'); }).filter(Boolean);
      if (!leaving.length || reducedMotion()) { liveRender(); return; }
      leaving.forEach(function mark(el) { el.style.height = el.offsetHeight + 'px'; });
      void root.offsetHeight; // commit the pinned heights so the collapse transitions from them
      leaving.forEach(function mark(el) { el.classList.add('leaving'); });
      window.setTimeout(liveRender, 200);
    }

    function reducedMotion() {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /**
     * Run a state change and its render as one view transition, so what leaves
     * and what arrives move together: tabs slide in the direction travelled,
     * menus grow from their trigger and shrink back, the detail pane rises in
     * and the header stays put. `change` renders and moves focus itself; it
     * runs synchronously when transitions are unavailable or motion is
     * reduced, so callers never depend on the animation.
     */
    function transition(kind, change, dir) {
      var html = document.documentElement;
      var can = typeof document.startViewTransition === 'function' && !reducedMotion() && document.visibilityState !== 'hidden';
      if (!can) {
        change();
        if (kind === 'tab' && !reducedMotion()) {
          var view = root.querySelector('#pn-view, .pn-split, .pn-calm');
          if (view) view.classList.add('pn-enter');
        }
        return;
      }
      html.setAttribute('data-vt', kind);
      if (dir) html.setAttribute('data-vt-dir', dir); else html.removeAttribute('data-vt-dir');
      var vt = document.startViewTransition(change);
      vt.finished.then(clear, clear);
      function clear() {
        if (html.getAttribute('data-vt') !== kind) return;
        html.removeAttribute('data-vt');
        html.removeAttribute('data-vt-dir');
      }
    }

    function liveRefresh() {
      liveTimer = null;
      if (liveInflight || inflight) { liveAgain = true; return; }
      liveInflight = true;
      liveLastAt = Date.now();
      var gen = ui.generation;
      var args = currentReadArgs();
      var withWork = args.view === 'work';
      R.callToolResult('orgx_panel_snapshot', args).then(function onLive(result) {
        if (gen !== ui.generation) return;
        var data = result && result.data;
        if (accept(data, result.meta || null, 'refresh')) {
          if (withWork) {
            ui.work = data.work || { status: 'unavailable', items: [], total: 0 };
            ui.workPhase = 'ready';
          }
          liveRender();
        }
      }, function onLiveError() {
        // The feed will report the next change; a failed quiet read changes
        // nothing on screen.
      }).then(function release() {
        liveInflight = false;
        if (liveAgain) { liveAgain = false; scheduleLiveRefresh(); }
      });
    }
    /** What the panel would read now: its selected decision and open tab. */
    function currentReadArgs() {
      var s = ui.snapshot;
      var args = {};
      if (s && s.selection.status === 'selected' && s.focus) args.focus = { type: 'decision', id: s.focus.id };
      if (ui.tab === 'work') args.view = 'work';
      return args;
    }
    function scheduleLiveRefresh() {
      if (liveTimer) return;
      var wait = Math.max(LIVE_DEBOUNCE_MS, LIVE_MIN_GAP_MS - (Date.now() - liveLastAt));
      liveTimer = window.setTimeout(liveRefresh, wait);
    }

    function onLiveWork(summary, moved) {
      var prev = ui.liveWork;
      ui.liveWork = summary;
      if (moved) {
        if (ui.tab === 'work') { scheduleLiveRefresh(); return; }
        // Read again when opened rather than showing what was running before.
        if (ui.workPhase !== 'loading') { ui.work = null; ui.workPhase = 'idle'; }
      }
      if (!prev || prev.total !== summary.total || prev.blocked !== summary.blocked || moved) liveRender();
    }

    function onLiveStatus(status) {
      ui.live = status;
      var el = root.querySelector('.sync');
      if (el) {
        el.textContent = syncLabel();
        el.setAttribute('data-live', status);
        if (status === 'live') {
          el.setAttribute('role', 'img');
          el.setAttribute('aria-label', 'Live: updates as they happen');
          el.setAttribute('title', 'Updates as they happen');
        } else {
          el.removeAttribute('role'); el.removeAttribute('aria-label'); el.removeAttribute('title');
        }
      } else {
        liveRender();
      }
    }

    live = window.OrgXPanelLive ? window.OrgXPanelLive.create({
      runtime: R,
      shownQueue: shownQueue,
      onRemoved: dropSettled,
      onStale: scheduleLiveRefresh,
      onWork: onLiveWork,
      refreshArgs: currentReadArgs,
      onSnapshot: function onGrantRead(result) {
        if (!result || !accept(result.data, result.meta || null, 'refresh')) return;
        if (result.data.work) { ui.work = result.data.work; ui.workPhase = 'ready'; }
        liveRender();
      },
      onStatus: onLiveStatus,
    }) : null;

    // Without a live feed (none granted, unsupported, or stopped), coming back
    // to the panel re-reads it if what it shows has aged.
    document.addEventListener('visibilitychange', function onVisible() {
      if (document.hidden || !ui.snapshot || ui.auth) return;
      if (live && live.status() !== 'off') return;
      if (ui.syncedAt && Date.now() - ui.syncedAt.getTime() < FALLBACK_STALE_MS) return;
      scheduleLiveRefresh();
    });

    // ── Host, device and network ───────────────────────────────────────────
    // The host names itself after connect; the platform and safe areas come
    // with the host context. Either can change after the first paint.
    var hostRenderQueued = false;
    if (Host) Host.onChange(function onHostChange() {
      if (hostRenderQueued) return;
      hostRenderQueued = true;
      later(function rerender() { hostRenderQueued = false; render(); }, 0);
    });

    // A cold start that drags says so, then offers a way out, rather than
    // shimmering forever on a slow phone network.
    var BOOT_SLOW_MS = 6000;
    var BOOT_STALL_MS = 15000;
    function stillCold() { return !ui.snapshot && !ui.auth && ui.readState.phase !== 'failed'; }
    later(function slow() { if (stillCold() && ui.bootStage === 'reading') { ui.bootStage = 'slow'; render(); } }, BOOT_SLOW_MS);
    later(function stalled() {
      if (!stillCold() || ui.bootStage === 'stalled') return;
      ui.bootStage = 'stalled';
      announce('OrgX is taking longer than usual to load.');
      render();
    }, BOOT_STALL_MS);

    function setOffline(off) {
      if (ui.offline === off) return;
      ui.offline = off;
      if (off) { announce('You’re offline. Showing what loaded last.'); render(); return; }
      announce('Back online. Refreshing.');
      if (isGallery) { render(); return; }
      if (ui.auth) { ui.auth = null; ui.bootStage = 'reading'; }
      fetchSnapshot(ui.snapshot && ui.snapshot.selection.status === 'selected' && ui.snapshot.focus ? ui.snapshot.focus.id : null, 'refresh');
    }
    window.addEventListener('online', function onOnline() { setOffline(false); });
    window.addEventListener('offline', function onOffline() { setOffline(true); });

    // On a touch screen, a horizontal swipe across the view moves between the
    // tabs in their own order. Vertical scrolling, text fields and the rows
    // that scroll sideways themselves are left alone.
    var swipe = null;
    function swipeAllowed(target) {
      if (ui.mode !== 'global' || !ui.snapshot || ui.auth) return false;
      if ((tour && tour.active()) || ui.wsOpen || ui.startWhoOpen || ui.composer) return false;
      if (!root.querySelector('.pn-tabs')) return false;
      return !target.closest('textarea, input, select, .pn-tabs, .pn-asks, .st-try, .ws-menu, .st-menu, pre, [data-swipe="off"]');
    }
    root.addEventListener('pointerdown', function onSwipeStart(event) {
      swipe = null;
      if (event.pointerType !== 'touch' || !swipeAllowed(event.target)) return;
      swipe = { x: event.clientX, y: event.clientY, at: Date.now() };
    });
    root.addEventListener('pointerup', function onSwipeEnd(event) {
      if (!swipe || event.pointerType !== 'touch') return;
      var dx = event.clientX - swipe.x, dy = event.clientY - swipe.y, dt = Date.now() - swipe.at;
      swipe = null;
      if (dt > 800 || Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      var order = ['needs', 'work', 'done', 'start'].filter(function has(t) { return Boolean(root.querySelector('#pn-tab-' + t)); });
      var at = order.indexOf(ui.tab);
      var next = at === -1 ? null : order[dx < 0 ? at + 1 : at - 1];
      if (!next) return;
      if (Host) Host.haptic('tap');
      setTab(next);
    });
    root.addEventListener('pointercancel', function onSwipeCancel() { swipe = null; });

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
