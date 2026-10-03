/**
 * OrgX widget icons: one small inline SVG set in the kit's glyph grammar
 * (24-unit grid, 1.8 stroke, round caps and joins, currentColor; a faint
 * tinted field says what kind of thing it is, one solid mark is the unit).
 *
 *   OrgXIcons.icon('decision')                      decorative, 16 px
 *   OrgXIcons.icon('blocked', { size: 14, label: 'Blocked' })   role="img"
 *   OrgXIcons.forEntity('Workstream')  -> 'workstream'
 *   OrgXIcons.forStatus('in_progress') -> 'active'
 *
 * Entity types: initiative, workstream, milestone, task, decision, artifact,
 * run, plan, agent, search. Statuses: done, active, needs-you, blocked,
 * waiting, failed, paused, draft. Actions: open-external, expand, collapse,
 * retry, filter, time, cost, close.
 *
 * The task icon is a work card, not a rounded square with a check, so a task
 * row never reads as a checkbox the person can tick.
 */
(function installOrgXIcons(global) {
  'use strict';
  if (global.OrgXIcons) return;

  var FIELD = 'fill="currentColor" fill-opacity=".12" stroke="none"';
  var SOLID = 'fill="currentColor" stroke="none"';

  var SRC = {
    /* entities */
    initiative: '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6" @/>',
    workstream: '<rect x="2.5" y="2.5" width="19" height="19" rx="5.5" ~/><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke-opacity=".55"/><path d="M6.5 7.5c3 0 4.5 4.5 7.5 4.5M6.5 16.5c3 0 4.5-4.5 7.5-4.5M6.5 12h11"/><path d="m15 9 3 3-3 3"/>',
    milestone: '<path d="M6 3.5v17"/><path d="M6 4.5l11.5 1-2 4 2 4-11.5-1z" fill="currentColor" fill-opacity=".12"/>',
    task: '<rect x="3" y="5" width="18" height="14" rx="3" ~/><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 5v14" stroke-opacity=".9"/><path d="M10.5 10h6.5M10.5 14h4"/>',
    decision: '<path d="M12 2.8 21.2 12 12 21.2 2.8 12z" ~/><path d="M12 2.8 21.2 12 12 21.2 2.8 12z"/><path d="M12 16.5v-4M12 12.5 9 9M12 12.5 15 9"/>',
    artifact: '<path d="M6 3h8l4 4v14H6z" ~/><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 15.5h4"/>',
    run: '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="9"/><path d="M10.2 8.6v6.8l5.3-3.4z" @/>',
    plan: '<rect x="3" y="3" width="18" height="18" rx="4" ~/><path d="M7.5 7v10"/><circle cx="7.5" cy="7.5" r="1.5" @/><circle cx="7.5" cy="12" r="1.5" @/><circle cx="7.5" cy="16.5" r="1.5" @/><path d="M11 7.5h6M11 12h5M11 16.5h4"/>',
    agent: '<circle cx="12" cy="12" r="9.5" ~/><circle cx="12" cy="9.5" r="3.2"/><path d="M5.8 18.6c1.4-2.5 3.6-3.8 6.2-3.8s4.8 1.3 6.2 3.8"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5" ~/><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    /* statuses */
    done: '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="9"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
    active: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" @/>',
    'needs-you': '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.4" r="1.1" @/>',
    blocked: '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="9"/><path d="M7.5 12h9"/>',
    waiting: '<circle cx="12" cy="12" r="9" stroke-dasharray="2.6 3.1"/><path d="M12 7.5V12l3 2"/>',
    failed: '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    paused: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7M14 8.5v7"/>',
    draft: '<circle cx="12" cy="12" r="9" stroke-dasharray="2.6 3.1"/>',
    /* actions */
    'open-external': '<path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14"/><path d="M14 4h6v6M20 4l-9 9"/>',
    expand: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    collapse: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
    retry: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.2v4.5h-4.5"/>',
    filter: '<path d="M4 6.5h16M7 12h10M10 17.5h4"/>',
    time: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    cost: '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="9"/><path d="M14.6 9.2c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1.2 1.6 2.6 2 2.6.9 2.6 2.1-1.1 2-2.6 2c-1.2 0-2.2-.5-2.7-1.5M12 6.3v1.5M12 16.2v1.5"/>',
    close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  };

  var GLYPHS = {};
  Object.keys(SRC).forEach(function (name) {
    GLYPHS[name] = SRC[name].replace(/~/g, FIELD).replace(/@/g, SOLID);
  });

  var ALIASES = {
    // entity type spellings seen in payloads
    initiatives: 'initiative', project: 'initiative', objective: 'initiative', goal: 'initiative',
    workstreams: 'workstream', stream: 'workstream',
    milestones: 'milestone',
    tasks: 'task', todo: 'task', issue: 'task',
    decisions: 'decision', approval: 'decision',
    artifacts: 'artifact', document: 'artifact', doc: 'artifact', file: 'artifact', output: 'artifact',
    runs: 'run', agent_run: 'run', session: 'run', execution: 'run',
    plans: 'plan', plan_session: 'plan',
    agents: 'agent', person: 'agent', owner: 'agent',
    query: 'search',
    // action spellings
    ext: 'open-external', external: 'open-external', open: 'open-external', link: 'open-external',
    chevron: 'expand', 'chevron-down': 'expand', 'chevron-up': 'collapse',
    refresh: 'retry', reload: 'retry',
    clock: 'time', duration: 'time',
    spend: 'cost', budget: 'cost', usd: 'cost',
    x: 'close', dismiss: 'close',
  };

  var STATUS = {
    done: ['done', 'completed', 'complete', 'succeeded', 'success', 'approved', 'accepted', 'verified', 'confirmed', 'shipped', 'merged', 'passed', 'resolved'],
    active: ['active', 'running', 'in_progress', 'progressing', 'working', 'verifying', 'sending', 'live', 'started'],
    'needs-you': ['needs_you', 'needs_review', 'in_review', 'review', 'pending', 'pending_approval', 'awaiting_approval', 'held', 'paused_for_input', 'asking', 'needs_human'],
    blocked: ['blocked', 'stalled', 'stuck', 'at_risk'],
    waiting: ['waiting', 'queued', 'scheduled', 'not_started', 'todo', 'planned', 'open', 'backlog'],
    failed: ['failed', 'failure', 'error', 'errored', 'rejected', 'declined', 'cancelled', 'canceled'],
    paused: ['paused', 'on_hold', 'snoozed'],
    draft: ['draft', 'proposed', 'idea', 'unknown'],
  };
  var STATUS_OF = {};
  Object.keys(STATUS).forEach(function (icon) {
    STATUS[icon].forEach(function (word) { STATUS_OF[word] = icon; });
  });

  function slug(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function resolve(name) {
    var key = String(name == null ? '' : name).trim().toLowerCase();
    if (GLYPHS[key]) return key;
    var s = slug(key);
    if (GLYPHS[s.replace(/_/g, '-')]) return s.replace(/_/g, '-');
    return ALIASES[s] || ALIASES[key] || null;
  }

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  }

  /**
   * icon(name, { size = 16, label, className, strokeWidth }) -> '<svg ...>'.
   * Unknown names render nothing (''), never a broken box. Decorative
   * (aria-hidden) unless a label is given.
   */
  function icon(name, options) {
    var key = resolve(name);
    if (!key) return '';
    var opts = typeof options === 'number' ? { size: options } : options || {};
    var size = Number(opts.size) || 16;
    var a11y = opts.label ? 'role="img" aria-label="' + escapeAttr(opts.label) + '"' : 'aria-hidden="true" focusable="false"';
    return (
      '<svg class="ox-icon' + (opts.className ? ' ' + escapeAttr(opts.className) : '') + '" data-icon="' + key + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (opts.strokeWidth || 1.8) +
      '" stroke-linecap="round" stroke-linejoin="round" ' + a11y + '>' + GLYPHS[key] + '</svg>'
    );
  }

  /** Entity type ("Workstream", "agent_run", "plan_session") -> icon name, or null. */
  function forEntity(type) {
    var key = resolve(type);
    return key && ['initiative', 'workstream', 'milestone', 'task', 'decision', 'artifact', 'run', 'plan', 'agent', 'search'].indexOf(key) !== -1 ? key : null;
  }

  /** Free-form status ("In progress", "needs_review") -> status icon name (default "draft"). */
  function forStatus(status) {
    return STATUS_OF[slug(status)] || 'draft';
  }

  global.OrgXIcons = {
    icon: icon,
    forEntity: forEntity,
    forStatus: forStatus,
    resolve: resolve,
    names: Object.keys(GLYPHS),
  };
})(window);
