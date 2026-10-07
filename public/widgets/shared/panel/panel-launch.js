/**
 * OrgX panel: start work in chat.
 *
 * The panel teaches by showing the sentence it sends. Every prompt is a
 * plain request ChatGPT turns into a real OrgX tool call, and each line
 * says what OrgX does with it, never a tool id. Mapping (ChatGPT profile):
 *
 *   launch   -> scaffold_initiative   plan     -> orgx_plan
 *   delegate -> orgx_spawn            status   -> get_agent_status
 *   next     -> orgx_recommend        brief    -> get_morning_brief
 *   pulse    -> get_initiative_pulse  risk/wait/check -> orgx_inspect, orgx_command_status
 *
 * Restraint rules (kept here so every caller gets them):
 *   - launch prompts never render above a pending decision (callers choose
 *     the calm state, In progress and Done);
 *   - at most one tip line; it stops after two dismissals or once the
 *     person has sent three prompts;
 *   - sending posts a user message (ui/message) when the host allows it and
 *     otherwise copies the sentence, saying so. Nothing sends without a click.
 */
(function attachPanelLaunch(global) {
  'use strict';
  if (global.OrgXPanelLaunch) return;

  var STORE_KEY = 'orgx.panel.launch.v1';
  var memory = { dismissed: 0, sent: 0, opens: 0 };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clip(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
  }
  function load() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') memory = Object.assign(memory, parsed);
      }
    } catch (_) { /* private window or blocked storage: memory only */ }
    return memory;
  }
  function save() {
    try { if (global.localStorage) global.localStorage.setItem(STORE_KEY, JSON.stringify(memory)); } catch (_) { /* memory only */ }
  }
  load();

  var CATALOG = {
    launch: function () { return { text: 'Help me start a new initiative in OrgX', does: 'Sets up the initiative, its plan and its first agents' }; },
    plan: function (ctx) {
      return ctx.initiative
        ? { text: 'Plan the next steps for ' + clip(ctx.initiative, 60) + ' in OrgX', does: 'Drafts a plan you review before anything runs' }
        : { text: 'Plan my next milestone in OrgX', does: 'Drafts a plan you review before anything runs' };
    },
    delegate: function () { return { text: 'Hand a task to an OrgX agent', does: 'Picks the right agent and starts the work' }; },
    status: function () { return { text: 'What are my OrgX agents working on right now?', does: 'Reads live agent status' }; },
    next: function () { return { text: 'What should I do next in OrgX?', does: 'Recommends the next move from your workspace' }; },
    brief: function () { return { text: 'Give me my OrgX morning brief', does: 'Summarizes what changed and what needs you' }; },
    pulse: function (ctx) { return ctx.initiative ? { text: 'How is ' + clip(ctx.initiative, 60) + ' going in OrgX?', does: 'Reads the initiative’s progress and risks' } : null; },
    risk: function (ctx) { return { label: 'Explain the risk', text: 'In OrgX, explain the risk of approving “' + clip(ctx.title, 140) + '”', does: 'Reads the decision and its evidence' }; },
    wait: function (ctx) { return { label: 'What breaks if I wait?', text: 'In OrgX, what slips if I don’t decide “' + clip(ctx.title, 140) + '” today?', does: 'Reads what the decision holds up' }; },
    draft: function (ctx) { return { label: 'Draft with ChatGPT', text: 'Draft a short send-back note for the OrgX decision “' + clip(ctx.title, 140) + '”: what should change?', does: 'Writes a note you can paste back here' }; },
    check: function (ctx) { return { text: 'How is “' + clip(ctx.title, 120) + '” going in OrgX since I decided it?', does: 'Checks the work your decision started' }; },
  };

  var SETS = {
    calm: ['launch', 'next', 'plan', 'brief'],
    'work-empty': ['delegate', 'launch'],
    work: ['status', 'delegate'],
    done: ['check', 'next', 'launch'],
    packet: ['risk', 'wait'],
    tips: ['next', 'status', 'brief', 'delegate', 'pulse'],
  };

  function prompts(kind, ctx) {
    ctx = ctx || {};
    return (SETS[kind] || []).map(function build(key) {
      if (key === 'check' && !ctx.title) return null;
      var p = CATALOG[key] && CATALOG[key](ctx);
      return p ? Object.assign({ key: key }, p) : null;
    }).filter(Boolean);
  }

  /** The full list: each button shows the exact sentence and what OrgX does. */
  function sectionHtml(kind, ctx, opts) {
    opts = opts || {};
    var list = prompts(kind, ctx).slice(0, opts.limit || 4);
    if (!list.length) return '';
    var id = 'pn-launch-' + kind;
    return '<section class="pn-launch" data-launch="' + esc(kind) + '" aria-labelledby="' + id + '">' +
      '<h2 class="pn-launch-h" id="' + id + '">' + esc(opts.heading || 'Start work in chat') + '</h2>' +
      '<p class="pn-launch-sub">' + esc(opts.sub || 'Each one sends this sentence to ChatGPT, which uses OrgX to do it.') + '</p>' +
      '<div class="pn-launch-list">' + list.map(function item(p) {
        return '<button type="button" class="pn-prompt" data-action="launch" data-key="' + esc(p.key) + '" data-prompt="' + esc(p.text) + '">' +
          '<span class="pn-prompt-t">“' + esc(p.text) + '”</span>' +
          '<span class="pn-prompt-d">' + esc(p.does) + '</span>' +
          '<span class="pn-prompt-s" aria-hidden="true"></span></button>';
      }).join('') + '</div></section>';
  }

  /** Short chips for a decision; the full sentence is the accessible name. */
  function chipsHtml(kind, ctx) {
    var list = prompts(kind, ctx);
    if (!list.length) return '';
    return '<div class="pn-asks" role="group" aria-label="Ask ChatGPT about this decision"><span class="pn-asks-h">Ask ChatGPT</span>' +
      list.map(function chip(p) {
        return '<button type="button" class="pn-ask" data-action="launch" data-key="' + esc(p.key) + '" data-prompt="' + esc(p.text) + '" title="' + esc(p.text) + '" aria-label="Ask ChatGPT: ' + esc(p.text) + '">' +
          '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>' +
          '<span>' + esc(p.label || p.text) + '</span></button>';
      }).join('') + '</div>';
  }

  /** One tip line, or nothing when the person has learned it or turned it off. */
  function tipHtml(ctx, shownKinds) {
    ctx = ctx || {};
    if (memory.dismissed >= 2 || memory.sent >= 3) return '';
    // Never repeat a prompt the visible section already shows.
    var shown = {};
    (shownKinds || []).forEach(function each(kind) { prompts(kind, ctx).slice(0, 4).forEach(function mark(p) { shown[p.key] = true; }); });
    var pool = prompts('tips', ctx).filter(function fresh(p) { return !shown[p.key]; });
    if (!pool.length) return '';
    var p = pool[memory.opens % pool.length];
    return '<p class="pn-tip"><span class="pn-tip-l">Try in chat</span>' +
      '<button type="button" class="pn-tip-p" data-action="launch" data-key="' + esc(p.key) + '" data-prompt="' + esc(p.text) + '" data-tip="true">“' + esc(p.text) + '”</button>' +
      '<button type="button" class="pn-tip-x" data-action="tip-dismiss" aria-label="Hide chat tips">' +
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></p>';
  }

  function noteOpen() { memory.opens += 1; save(); }
  function noteDismiss() { memory.dismissed += 1; save(); }

  function copy(text) {
    var nav = global.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      return nav.clipboard.writeText(text).then(function copied() { return 'copied'; }, function failed() { return 'failed'; });
    }
    return Promise.resolve('failed');
  }

  /**
   * Post the sentence as the person's own chat message. Resolves to
   * 'sent', 'copied' (the host can't post; the sentence is on the
   * clipboard) or 'failed'.
   */
  function send(text) {
    var R = global.OrgXWidgetRuntime;
    var app = R && typeof R.getApp === 'function' ? R.getApp() : null;
    var done = function sent(result) {
      if (result && result.isError) throw new Error('rejected');
      memory.sent += 1; save();
      return 'sent';
    };
    var attempt = null;
    try {
      if (app && typeof app.sendMessage === 'function') {
        attempt = Promise.resolve(app.sendMessage({ role: 'user', content: [{ type: 'text', text: text }] })).then(done);
      } else if (global.openai && typeof global.openai.sendFollowUpMessage === 'function') {
        attempt = Promise.resolve(global.openai.sendFollowUpMessage({ prompt: text })).then(done);
      }
    } catch (_) {
      attempt = null;
    }
    return attempt ? attempt.catch(function fallback() { return copy(text); }) : copy(text);
  }

  global.OrgXPanelLaunch = {
    prompts: prompts,
    sectionHtml: sectionHtml,
    chipsHtml: chipsHtml,
    tipHtml: tipHtml,
    send: send,
    noteOpen: noteOpen,
    noteDismiss: noteDismiss,
    _state: function state() { return Object.assign({}, memory); },
    _reset: function reset() { memory = { dismissed: 0, sent: 0, opens: 0 }; save(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
