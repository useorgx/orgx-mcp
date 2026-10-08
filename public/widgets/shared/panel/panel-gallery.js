/**
 * OrgX panel: the local preview gallery (?gallery=true&state=…).
 *
 * Fixture snapshots for every panel state, so the panel can be checked in a
 * browser without OrgX behind it. panel-app.js loads this file only when the
 * page asks for the gallery; it is never inlined into the MCP Apps resource
 * (keep it off MCP_APPS_SHARED_COMPONENT_PATHS and the build allowlists).
 *
 *   OrgXPanelGallery.boot(ctx) -> { run, work, history, focus, workspaces,
 *                                   receipts, receipt, behind }
 *
 * ctx is the panel's own state and functions: ui, params, render, accept,
 * clock, and useShare(modelContext), which swaps in a share controller.
 */
(function attachPanelGallery(global) {
  'use strict';

  function boot(ctx) {
    var ui = ctx.ui;
    var params = ctx.params;
    var render = ctx.render;
    var accept = ctx.accept;
    var clock = ctx.clock;
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
      // Visual check of the live indicator; the gallery has no feed of its own.
      if (['live', 'reconnecting'].indexOf(params.get('live')) !== -1) ui.live = params.get('live');
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
        case 'merges': {
          // The production shape: several merge approvals that share one title
          // and differ only in the PR named in the question, whose command runs
          // straight into the approval wording, plus one blocking run approval.
          // Shaped like production: the whole question as the title, the
          // command on its own line, the floor as the asker.
          var mergeTitle = 'The OrgX floor stopped a merge action in a agent-cli session and is waiting for you.';
          var merges = [3236, 3237, 3238, 3239].map(function merge(pr, i) {
            var id = '5b1e0c3a-1d2f-4c3b-9a8e-0000000032' + String(30 + i);
            var question = mergeTitle + '\n\nAgent\'s reason: PR #' + pr + ' (https://github.com/hopeatina/orgx/pull/' + pr + ') adds accessible decision action tiles. All GitHub checks pass; please review and decide whether to merge.\n\nCommand:\ngh pr merge ' + pr + '\n\nApprove to let exactly this action run once in the next 24 hours. Decline and the agent is told to continue without it.';
            return {
              id: id, version: isoAgo((8 * 24 - i) * H), title: question.slice(0, 160), urgency: 'medium', waiting_since: isoAgo(8 * D), initiative_title: null,
              blocked: true, decide_in_orgx_reason: null, option_count: 0, kind: 'decision', asker: null, asker_kind: 'floor', session_label: 'agent-cli session', url: decisionUrl(id),
              widget_actions: { kind: 'decision', actions: ['approve', 'reject'], labels: { approve: 'Allow once', reject: 'Deny' }, reject_requires_reason: false, answer: null, selection: null },
              detail: question,
            };
          });
          s = baseSnapshot();
          s.queue = merges.concat([Object.assign({}, FIXTURE_QUEUE[1])]);
          s.attention = { pending: s.queue.length, oldest_at: isoAgo(8 * D), blocking: true };
          var first = merges[0];
          s.focus = Object.assign(galleryFocus(FIXTURE_QUEUE[0]), {
            id: first.id, version: first.version, urgency: 'medium', blocked: true, waiting_since: first.waiting_since, initiative_title: null, asker: null, url: first.url,
            question: first.detail, recommendation: { status: 'unavailable', action: null }, evidence: [], evidence_total: 0, consequence_if_approved: null,
            asker_kind: 'floor', session_label: 'agent-cli session', widget_actions: first.widget_actions,
            why: { authority: 'This gate blocks work until an authorized person answers.', policy: null, uncertainty: [], run_url: null, initiative_url: window.OrgXLinks.initiative('14985d6c-214c-4f9e-96ac-4f6b254e1770') },
          });
          tokens = allTokens(s);
          break;
        }
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
        var share = ctx.useShare({ update: function noop() { return Promise.resolve(undefined); } });
        if (name === 'stale') share.restore({ status: 'match', entity: { id: IDS.d1, version: 'older' } }, IDS.ws);
      }
      ui.tokens = tokens;
      if (params.get('tab') === 'work' || params.get('tab') === 'done') { ui.tab = params.get('tab'); if (ui.tab === 'work') { ui.work = galleryWork(); ui.workPhase = 'ready'; } }
      accept(s, undefined, 'host');
      ui.syncedAt = new Date(NOW - 4 * 60 * 1000);
      if (failed) ui.readState = { phase: 'failed', focusId: null };
      render();
    }

    function galleryReceipts(range) {
      var rows = [
        ['Fix the flaky checkout test and open a PR', 'Eli', 'succeeded', 'verified', 'accepted', [3, 0, 1], ['useorgx/orgx#3236']],
        ['Draft the launch post for the new pricing', 'Mark', 'succeeded', 'unverified', null, [2, 0, 2], []],
        ['Add rate limiting to the public API', 'Eli', 'partially_succeeded', 'verified', null, [2, 1, 0], ['useorgx/orgx#3237']],
        ['Build an ICP list of 50 founder-led SaaS companies', 'Sage', 'succeeded', 'unverified', 'accepted', [1, 0, 2], []],
        ['Audit the onboarding flow for friction', 'Dana', 'failed', 'failed', 'rejected', [0, 2, 1], []],
        ['Write a runbook for a failed deploy', 'Orion', 'succeeded', 'unverified', null, [0, 0, 0], []],
      ];
      var n = range === 'today' ? 2 : range === '7d' ? 5 : 6;
      return { status: 'ok', query: 'since:', total: n, reason: null, items: rows.slice(0, n).map(function r(x, i) {
        return { id: 'rcpt-' + i, at: new Date(Date.now() - (i + 1) * 4 * 3600 * 1000).toISOString(), actor: x[1], summary: x[0], outcome: x[2], verification: x[3], accepted: x[4],
          work_type: null, area: null, entity_title: i < 3 ? 'Release initiative' : null, criteria: { met: x[5][0], unmet: x[5][1], unknown: x[5][2] }, prs: x[6], confidence: i === 1 ? 0.5 : 0.8 };
      }) };
    }
    function galleryReceipt(id) {
      var row = ui.receiptRows[id] || galleryReceipts('30d').items[0];
      var texts = ['The checkout suite passes ten runs in a row', 'The fix has a regression test', 'No new console errors on checkout', 'The PR is reviewed by a person'];
      var crit = [];
      ['met', 'unmet', 'unknown'].forEach(function k(status) {
        for (var i = 0; i < row.criteria[status]; i += 1) crit.push({ id: 'c' + crit.length, text: texts[crit.length % texts.length], kind: 'test', status: status, confidence: status === 'unknown' ? null : 0.85 });
      });
      return { status: 'ok', id: id, row: row, objective: null, outcome_summary: row.outcome === 'failed' ? 'Stopped after two attempts; the flow still drops users at step 3.' : 'Opened the change and ran the checks listed below.',
        criteria: crit, artifacts: row.prs.map(function a(pr) { return { kind: 'pull_request', name: pr, url: 'https://github.com/' + pr.replace('#', '/pull/') }; }),
        uncertain: row.criteria.unknown ? ['no evidence either way for: ' + texts[3]] : [], workstream_title: null, cost_usd: 0.42, completed_at: row.at, reason: null };
    }
    function galleryBehind(pr) {
      var all = galleryReceipts('30d').items.filter(function m(r) { return r.prs.some(function has(x) { return x.slice(-pr.length - 1) === '#' + pr; }); });
      return { status: 'ok', query: 'pr:' + pr, total: all.length, items: all, reason: null };
    }

    function galleryHistory(range) {
      var titles = ['Ship release 4.1 to production?', 'Approve the Q4 pricing page copy', 'Allow gh pr merge 3221', 'Rotate the staging database password', 'Publish the September changelog', 'Pause the low-intent ads campaign'];
      var n = range === 'today' ? 2 : range === '7d' ? 5 : 6;
      return { status: 'ok', range: range, items: titles.slice(0, n).map(function item(t, i) {
        return { id: 'h' + i + '-0000-4000-8000-000000000000', title: t, outcome: i % 4 === 3 ? 'declined' : 'approved', settled_at: new Date(Date.now() - (i + 1) * 5 * 3600 * 1000).toISOString(), url: decisionUrl('h' + i) };
      }) };
    }

    function galleryWork() {
      var live = window.OrgXLinks.live();
      var h = function hoursAgo(n) { return new Date(Date.now() - n * 3600 * 1000).toISOString(); };
      var items = [
        ['w1', 'Dana', 'Design', 'Design plan for OrgX Live', 'blocked', 3],
        ['w2', 'Eli', 'Engineering', 'Reconcile launch telemetry fields', 'running', 0.2],
        ['w3', 'Eli', 'Engineering', 'Upgrade the actual Mac and replay its backlog without duplicates', 'running', 150],
        ['w4', 'Eli', 'Engineering', 'tokens.json to CSS variables and dashboard theme', 'queued', 30],
        ['w5', 'Eli', 'Engineering', 'One AgentAvatar on ox-avatar', 'queued', 30],
        ['w6', 'Eli', 'Engineering', 'Rebuild 12 widgets on orgx-ui-kit elements', 'queued', 31],
        ['w7', 'Eli', 'Engineering', 'Widget-only orgx_approve tool', 'queued', 31],
        ['w8', 'Mark', 'Marketing', 'Pricing page copy, variant B', 'running', 1],
        ['w9', 'Orion', 'Operations', 'Agent routing fixture', 'blocked', 120],
        ['w10', 'Orion', 'Operations', 'PR6: collect production proof and independent verification', 'blocked', 96],
        ['w11', 'Sage', 'Sales', 'ICP list for founder-led SaaS', 'queued', 4],
      ];
      return {
        status: 'ok', total: items.length,
        items: items.map(function row(x) {
          return { id: x[0], agent: x[1], domain: x[2], title: x[3], state: x[4], url: live, updated_at: h(x[5]), stale: x[4] === 'running' && x[5] > 24 };
        }),
      };
    }

    function galleryWorkspaces() {
      return { status: 'ok', items: [
        { id: 'g-acme', name: 'Acme workspace', current: true },
        { id: 'g-labs', name: 'Acme Labs', current: false },
        { id: 'g-personal', name: 'Personal', current: false },
      ] };
    }

    return {
      run: runGallery, work: galleryWork, history: galleryHistory, focus: galleryFocus, workspaces: galleryWorkspaces,
      receipts: galleryReceipts, receipt: galleryReceipt, behind: galleryBehind,
    };
  }

  global.OrgXPanelGallery = { boot: boot };
})(window);
