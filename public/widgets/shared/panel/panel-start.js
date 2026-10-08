/**
 * OrgX panel: Start. The place to set work going from ChatGPT.
 *
 * Say what should get done, pick who takes it (or let OrgX route it), and
 * choose how: start an initiative, plan it first, or hand it straight to an
 * agent. The panel never runs anything itself: it sends one plain sentence to
 * ChatGPT, which uses OrgX to do it, and it always shows that exact sentence
 * before it is sent. Starters fill the composer rather than firing, so the
 * person can make them theirs.
 *
 *   OrgXPanelStart.html(opts)           -> the Start view
 *   OrgXPanelStart.sentence(verb, opts) -> the sentence a verb sends
 */
(function attachPanelStart(global) {
  'use strict';
  if (global.OrgXPanelStart) return;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function roster() {
    var identity = global.OrgXAgentIdentity;
    return identity && identity.AGENTS ? identity.AGENTS.filter(function worker(a) { return a.key !== 'xandy'; }) : [];
  }
  function agentByKey(key) {
    return roster().filter(function same(a) { return a.key === key; })[0] || null;
  }
  function avatar(name) {
    var identity = global.OrgXAgentIdentity;
    return identity && identity.avatar ? identity.avatar({ agent: name, name: name, size: 'inline' }) : '';
  }

  var VERBS = [
    ['initiative', 'Start an initiative', 'Creates the initiative with its workstreams and tasks'],
    ['plan', 'Plan it first', 'Drafts a plan you review; nothing runs until you accept'],
    ['delegate', 'Hand it off', 'Picks the agent and starts the work now'],
  ];

  /** The exact sentence each verb sends. Plain words; OrgX is named so ChatGPT uses it. */
  function sentence(verb, opts) {
    var text = String((opts && opts.text) || '').trim().replace(/\s+/g, ' ').replace(/[.。]+$/, '');
    if (!text) return '';
    var agent = agentByKey(opts && opts.agent);
    if (verb === 'initiative') return 'Start a new initiative in OrgX: ' + text + '.';
    if (verb === 'plan') return 'Plan this in OrgX before anything runs: ' + text + '.';
    return agent
      ? 'In OrgX, hand this to ' + agent.name + ' (' + agent.role + '): ' + text + '.'
      : 'In OrgX, hand this to the right agent: ' + text + '.';
  }

  /** Starters per domain: concrete jobs, filled into the composer to edit. */
  var STARTERS = {
    eli: ['Fix the flaky checkout test and open a PR', 'Add rate limiting to the public API'],
    dana: ['Audit the onboarding flow for friction', 'Design the empty state for the reports page'],
    mark: ['Draft the launch post for the new pricing', 'Plan a two-week campaign for founders'],
    sage: ['Build an ICP list of 50 founder-led SaaS companies', 'Write a follow-up sequence for stalled trials'],
    pace: ['Write a PRD for team workspaces', 'Synthesize this week’s customer calls'],
    orion: ['Write a runbook for a failed deploy', 'Review this month’s spend against budget'],
  };

  /**
   * opts: { text, agent, verb, status, initiative, workAgents }
   * workAgents: { name: count } of agents already holding work, to say who is busy.
   */
  function html(opts) {
    opts = opts || {};
    var text = opts.text || '';
    var agents = roster();
    var busy = opts.workAgents || {};
    var picked = agentByKey(opts.agent);
    var verb = opts.verb || (picked ? 'delegate' : 'initiative');
    var preview = sentence(verb, { text: text, agent: opts.agent });

    var who = '<div class="st-who" role="radiogroup" aria-label="Who takes it">' +
      '<button type="button" class="st-agent" role="radio" data-action="start-agent" data-id="" aria-checked="' + !picked + '">' +
      '<span class="st-auto" aria-hidden="true">✦</span><span class="st-an">OrgX picks</span><span class="st-ar">best fit</span></button>' +
      agents.map(function chip(a) {
        var n = busy[a.name] || 0;
        return '<button type="button" class="st-agent" role="radio" data-action="start-agent" data-id="' + esc(a.key) + '" aria-checked="' + (picked && picked.key === a.key) + '">' +
          '<span class="md-av">' + avatar(a.name) + '</span><span class="st-an">' + esc(a.name) + '</span>' +
          '<span class="st-ar">' + esc(a.role) + (n ? ' · ' + n + ' in progress' : '') + '</span></button>';
      }).join('') + '</div>';

    var verbs = '<div class="st-verbs" role="radiogroup" aria-label="How">' + VERBS.map(function v(x) {
      return '<button type="button" class="st-verb" role="radio" data-action="start-verb" data-id="' + x[0] + '" aria-checked="' + (verb === x[0]) + '">' +
        '<b>' + esc(x[0] === 'delegate' && picked ? 'Hand it to ' + picked.name : x[1]) + '</b><span>' + esc(x[2]) + '</span></button>';
    }).join('') + '</div>';

    var status = opts.status
      ? '<p class="st-status" role="status" data-outcome="' + esc(opts.status) + '">' +
        (opts.status === 'sent' ? 'Sent to the chat. ChatGPT is taking it to OrgX.' : opts.status === 'copied' ? 'Copied. Paste it into the chat to send it.' : 'Couldn’t send it from here. Type it in the chat.') + '</p>'
      : '';

    var starterKey = picked ? picked.key : null;
    var starterSets = starterKey ? [[picked, STARTERS[starterKey] || []]] : agents.slice(0, 6).map(function s(a) { return [a, (STARTERS[a.key] || []).slice(0, 1)]; });
    var starters = '<div class="st-starters"><h3 class="st-h">' + (picked ? 'Ideas for ' + esc(picked.name) : 'Or start from one of these') + '</h3><ul role="list">' +
      starterSets.map(function set(pair) {
        return pair[1].map(function one(t) {
          return '<li><button type="button" class="st-starter" data-action="start-fill" data-id="' + esc(pair[0].key) + '" data-text="' + esc(t) + '">' +
            '<span class="md-av">' + avatar(pair[0].name) + '</span><span class="st-st">' + esc(t) + '</span><span class="st-sr">' + esc(pair[0].role) + '</span></button></li>';
        }).join('');
      }).join('') + '</ul></div>';

    var cont = opts.initiative
      ? '<div class="st-continue"><h3 class="st-h">Keep ' + esc(opts.initiative) + ' moving</h3><div class="st-cont-b">' +
        '<button type="button" class="pn-chip" data-action="launch" data-prompt="' + esc('Plan the next steps for ' + opts.initiative + ' in OrgX') + '">Plan the next steps</button>' +
        '<button type="button" class="pn-chip" data-action="launch" data-prompt="' + esc('How is ' + opts.initiative + ' going in OrgX?') + '">How is it going?</button></div></div>'
      : '';

    // The loop this starts, in the panel's own words: where each part comes back.
    var steps = [
      ['Sent', 'ChatGPT takes your sentence to OrgX.'],
      [verb === 'plan' ? 'Planned' : verb === 'delegate' ? 'Routed' : 'Set up', verb === 'plan' ? 'OrgX drafts the plan; nothing runs until you accept it.' : verb === 'delegate' ? 'OrgX hands it to ' + (picked ? picked.name : 'the right agent') + ' and starts it.' : 'OrgX creates the initiative, its workstreams and first tasks.'],
      ['Back here', 'Questions arrive in Needs you, running work in In progress, receipts in Done.'],
    ];
    var busyList = Object.keys(busy).sort(function most(a, b) { return busy[b] - busy[a]; }).slice(0, 5);
    var aside = '<aside class="st-aside"><div class="md-card"><p class="md-kicker">What happens next</p><ol class="st-steps">' +
      steps.map(function step(x, i) { return '<li><span class="st-n">' + (i + 1) + '</span><span><b>' + esc(x[0]) + '</b> ' + esc(x[1]) + '</span></li>'; }).join('') + '</ol>' +
      (busyList.length ? '<p class="md-kicker st-busy-h">Agents right now</p><ul class="st-busy" role="list">' + busyList.map(function b(name) {
        return '<li><span class="md-av">' + avatar(name) + '</span><span>' + esc(name) + '</span><span class="st-ar">' + busy[name] + ' in progress</span></li>';
      }).join('') + '</ul>' : '') + '</div></aside>';
    return '<section class="pn-start" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-start">' +
      '<div class="pn-view-head"><h2 class="pn-view-h">Start work</h2></div>' +
      '<p class="st-lede">Say what should get done. ChatGPT sends it to OrgX, which plans it, runs it with your agents and brings decisions back to this panel.</p>' +
      '<div class="st-grid"><div class="st-main">' +
      '<div class="st-card">' +
      '<label class="st-label" for="st-text">What should get done?</label>' +
      '<textarea id="st-text" class="st-text" data-action="start-text" rows="3" maxlength="600" placeholder="e.g. Launch the new pricing page by Friday, with a post and an email to trials">' + esc(text) + '</textarea>' +
      '<p class="st-label">Who takes it</p>' + who +
      '<p class="st-label">How</p>' + verbs +
      '<div class="st-send"><p class="st-preview" aria-live="polite">' +
      (preview ? '<span class="st-pl">Sends</span> “' + esc(preview) + '”' : '<span class="st-pl">Sends</span> <span class="st-ph">your sentence, exactly as shown here</span>') + '</p>' +
      '<button type="button" class="pn-btn st-go" data-action="start-send"' + (preview ? '' : ' disabled aria-disabled="true"') + '>Send to chat</button></div>' +
      status + '</div>' + starters + cont + '</div>' + aside + '</div></section>';
  }

  global.OrgXPanelStart = { html: html, sentence: sentence, roster: roster };
})(typeof window !== 'undefined' ? window : globalThis);
