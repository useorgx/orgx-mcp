/**
 * OrgX panel: Start. The place to set work going from the chat (ChatGPT, Claude or any MCP Apps host).
 *
 * One question and one composer, after the OrgX chat composer: say what should
 * get done, then two quiet controls in the composer's own bar — who takes it
 * (a menu, OrgX picks by default) and how (initiative, plan first, hand off).
 * The panel never runs anything itself: it sends one plain sentence to
 * the assistant, which uses OrgX to do it, and it shows that exact sentence before
 * it is sent. Ideas fill the composer rather than firing.
 *
 *   OrgXPanelStart.html(opts)           -> the Start view
 *   OrgXPanelStart.sentence(verb, opts) -> the sentence a verb sends
 */
(function attachPanelStart(global) {
  'use strict';
  if (global.OrgXPanelStart) return;
  /** Host-aware copy: {host}, {Host}, {assistant}, {settings} name the app the panel is inside. */
  function fill(text) { var H = global.OrgXPanelHost; return H ? H.fill(text) : String(text).replace(/\{(?:host|chat)\}/g, 'the chat').replace(/\{(?:Host|Chat)\}/g, 'The assistant').replace(/\{assistant\}/g, 'the assistant').replace(/\{settings\}/g, 'the app’s settings'); }


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

  /** Each domain's light, so the stage takes the colour of whoever takes the work. */
  var TINT = { eli: '0, 201, 167', dana: '167, 139, 250', mark: '250, 204, 21', sage: '191, 255, 0', pace: '96, 165, 250', orion: '45, 212, 191' };

  var VERBS = [
    ['initiative', 'Initiative', 'OrgX sets up the initiative, its workstreams and first tasks.'],
    ['plan', 'Plan first', 'OrgX drafts a plan for you to review. Nothing runs until you accept it.'],
    ['delegate', 'Hand off', 'OrgX gives it to the best-fit agent and starts now.'],
  ];

  /** The exact sentence each verb sends. Plain words; OrgX is named so the assistant uses it. */
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

  /** Ideas per domain: concrete jobs, filled into the composer to edit. */
  var STARTERS = {
    eli: ['Fix the flaky checkout test and open a PR', 'Add rate limiting to the public API', 'Cut cold-start time on the API by half'],
    dana: ['Audit the onboarding flow for friction', 'Design the empty state for the reports page', 'Tighten the mobile checkout layout'],
    mark: ['Draft the launch post for the new pricing', 'Plan a two-week campaign for founders', 'Turn this week’s release into a changelog'],
    sage: ['Build an ICP list of 50 founder-led SaaS companies', 'Write a follow-up sequence for stalled trials', 'Prep a call brief for my next demo'],
    pace: ['Write a PRD for team workspaces', 'Synthesize this week’s customer calls', 'Size the pricing experiment we discussed'],
    orion: ['Write a runbook for a failed deploy', 'Review this month’s spend against budget', 'Find what slowed releases this month'],
  };
  var MIXED = [['mark', 0], ['eli', 0], ['pace', 1], ['sage', 0]];

  function verbOf(opts, picked) { return opts.verb || (picked ? 'delegate' : 'initiative'); }
  function verbHint(verb, picked) {
    if (verb === 'delegate') return picked ? 'OrgX gives it to ' + picked.name + ' and starts now.' : VERBS[2][2];
    return verb === 'plan' ? VERBS[1][2] : VERBS[0][2];
  }

  /** The line under the composer: the exact sentence once there is one, else what this choice does. */
  function previewHtml(verb, opts) {
    var picked = agentByKey(opts.agent);
    var said = sentence(verb, opts);
    return said
      ? '<span class="st-pl">Sends</span> “' + esc(said) + '”'
      : '<span class="st-ph">' + esc(verbHint(verb, picked)) + '</span>';
  }

  /**
   * opts: { text, agent, verb, status, initiative, workAgents, whoOpen }
   * workAgents: { name: count } of agents already holding work, to say who is busy.
   */
  function html(opts) {
    opts = opts || {};
    var agents = roster();
    var busy = opts.workAgents || {};
    var picked = agentByKey(opts.agent);
    var verb = verbOf(opts, picked);
    var said = sentence(verb, { text: opts.text, agent: opts.agent });

    // Who takes it: one pill in the bar. OrgX picks shows the team, stacked.
    var face = picked
      ? '<span class="st-face">' + avatar(picked.name) + '</span>'
      : '<span class="st-stack" aria-hidden="true">' + agents.slice(0, 3).map(function f(a) { return avatar(a.name); }).join('') + '</span>';
    var who = '<button type="button" class="st-who" data-action="start-who" aria-haspopup="true" aria-expanded="' + !!opts.whoOpen + '" aria-controls="st-menu">' +
      face + '<span class="st-who-n">' + esc(picked ? picked.name : 'OrgX picks') + '</span>' +
      '<svg class="st-car" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';

    var menu = opts.whoOpen
      ? '<div class="st-menu" id="st-menu" role="radiogroup" aria-label="Who takes it"><p class="st-mh">Who takes it</p>' +
        '<button type="button" class="st-opt" role="radio" data-action="start-agent" data-id="" aria-checked="' + !picked + '">' +
        '<span class="st-auto" aria-hidden="true">✦</span><span class="st-on">OrgX picks</span><span class="st-or">Best fit for the job</span></button>' +
        agents.map(function opt(a) {
          var n = busy[a.name] || 0;
          return '<button type="button" class="st-opt" role="radio" data-action="start-agent" data-id="' + esc(a.key) + '" aria-checked="' + (!!picked && picked.key === a.key) + '">' +
            '<span class="st-face">' + avatar(a.name) + '</span><span class="st-on">' + esc(a.name) + '</span>' +
            '<span class="st-or">' + esc(a.role) + (n ? ' · ' + n + ' running' : '') + '</span></button>';
        }).join('') + '</div>'
      : '';

    var how = '<div class="st-how" role="radiogroup" aria-label="How">' + VERBS.map(function v(x) {
      return '<button type="button" class="st-verb" role="radio" data-action="start-verb" data-id="' + x[0] + '" aria-checked="' + (verb === x[0]) + '"><b>' +
        esc(x[0] === 'delegate' && picked ? 'Hand to ' + picked.name : x[1]) + '</b></button>';
    }).join('') + '</div>';

    var status = opts.status
      ? '<p class="st-status" role="status" data-outcome="' + esc(opts.status) + '">' +
        (opts.status === 'sent' ? fill('Sent. {Host} is taking it to OrgX; questions will come back to Needs you.') : opts.status === 'copied' ? 'Copied. Paste it into the chat to send it.' : 'Couldn’t send it from here. Type it in the chat.') + '</p>'
      : '';

    // Ideas: three, for the picked agent or one each across the team; the
    // open initiative first when there is one.
    var ideas = picked
      ? (STARTERS[picked.key] || []).map(function p(t) { return [picked.key, t]; })
      : MIXED.slice(0, 3).map(function m(x) { return [x[0], STARTERS[x[0]][x[1]]]; });
    if (opts.initiative) ideas.unshift(['', 'Plan the next steps for ' + opts.initiative]);
    var tryRow = '<div class="st-try"><span class="st-sl">Try</span>' + ideas.slice(0, 4).map(function chip(x) {
      return '<button type="button" class="st-idea" data-action="start-fill" data-id="' + esc(x[0]) + '" data-text="' + esc(x[1]) + '">' + esc(x[1]) + '</button>';
    }).join('') + '</div>';

    var tint = picked ? TINT[picked.key] : '';
    return '<section class="pn-start" id="pn-view" role="tabpanel" aria-labelledby="pn-tab-start">' +
      '<div class="st-stage"' + (tint ? ' style="--st-tint: ' + tint + '"' : '') + '>' +
      '<div class="st-glow" aria-hidden="true"></div>' +
      '<h2 class="st-q">What should get done?</h2>' +
      '<p class="st-sub">Say the outcome. OrgX plans it, runs it with your agents and brings decisions back here.</p>' +
      '<div class="st-box">' +
      '<label class="sr-only" for="st-text">What should get done?</label>' +
      '<textarea id="st-text" class="st-text" data-action="start-text" rows="2" maxlength="600" placeholder="Launch the new pricing page by Friday, with a post and an email to trials">' + esc(opts.text || '') + '</textarea>' +
      '<div class="st-bar">' + who + how + '<span class="st-sp"></span>' +
      '<span class="st-kbd" aria-hidden="true">↵ send</span>' +
      '<button type="button" class="st-go" data-action="start-send" aria-label="Send to chat"' + (said ? '' : ' disabled aria-disabled="true"') + '>' +
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>' +
      '</div>' + menu + '</div>' +
      '<p class="st-preview" aria-live="polite">' + previewHtml(verb, { text: opts.text, agent: opts.agent }) + '</p>' +
      // The agreement that comes before any work (Agree on done, in Needs you).
      '<p class="st-done">Before work starts, OrgX asks you to agree on what done means.</p>' +
      status + tryRow + '</div></section>';
  }

  global.OrgXPanelStart = {
    html: html,
    sentence: sentence,
    roster: roster,
    /** The preview line alone, so typing updates it without rebuilding the composer. */
    previewHtml: function preview(opts) { opts = opts || {}; return previewHtml(verbOf(opts, agentByKey(opts.agent)), opts); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
