/**
 * Who an owner is, and how a widget shows them.
 *
 *   OrgXAgentIdentity.resolveAgentKey('Engineering-Agent')   -> 'eli'
 *   OrgXAgentIdentity.profile('launch_captain')              -> { key: 'mark', name: 'Mark', role: 'Marketing' }
 *   OrgXAgentIdentity.isSystem('OrgX System')                -> true
 *   OrgXAgentIdentity.avatar({ agent, name, size })          -> '<ox-avatar …>'
 *   OrgXAgentIdentity.agentCard({ agent, name, size, state, task, updatedAt, label })
 *                                                            -> '<ox-agent-card …>' (agents) or the avatar
 *
 * Avatars are the original headshots (kit photo mode). Never an empty circle:
 * a known agent gets their photo and hue ring, OrgX/system/automatic owners
 * (or no owner) get the OrgX mark, and anyone else their initials.
 *
 * Matching is whole words only, so "Developer" or "Scope" never resolve to an
 * agent by accident.
 */
(function attachAgentIdentity(global) {
  var AGENTS = [
    { key: 'pace', name: 'Pace', role: 'Product', words: ['pace', 'product', 'product-agent', 'product_agent', 'product_orchestrator'] },
    { key: 'eli', name: 'Eli', role: 'Engineering', words: ['eli', 'engineering', 'engineering-agent', 'engineering_agent', 'engineering_autopilot'] },
    { key: 'mark', name: 'Mark', role: 'Marketing', words: ['mark', 'marketing', 'marketing-agent', 'marketing_agent', 'launch_captain'] },
    { key: 'sage', name: 'Sage', role: 'Sales', words: ['sage', 'sales', 'sales-agent', 'sales_agent', 'pipeline_intelligence'] },
    { key: 'orion', name: 'Orion', role: 'Operations', words: ['orion', 'operations', 'ops', 'operations-agent', 'operations_agent', 'control_tower'] },
    { key: 'dana', name: 'Dana', role: 'Design', words: ['dana', 'design', 'design-agent', 'design_agent', 'design_codex'] },
    { key: 'xandy', name: 'Xandy', role: 'Orchestrator', words: ['xandy', 'orchestrator', 'orchestrator-agent', 'orchestrator_agent', 'xandy_orchestrator'] },
  ];
  var BY_KEY = {};
  AGENTS.forEach(function (agent) { BY_KEY[agent.key] = agent; });

  var SYSTEM = /^(orgx([\s_-]*(system|agent|automation|bot))?|system|automation|automatic|auto|scheduler)$/i;

  function resolveAgentKey() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (typeof value !== 'string' || !value.trim()) continue;
      var tokens = value.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
      for (var a = 0; a < AGENTS.length; a += 1) {
        for (var t = 0; t < tokens.length; t += 1) {
          if (AGENTS[a].words.indexOf(tokens[t]) !== -1) return AGENTS[a].key;
        }
      }
    }
    return null;
  }

  /** { key, name, role } for an agent name, id, domain or headshot stem; null for anyone else. */
  function profile() {
    var key = resolveAgentKey.apply(null, arguments);
    if (!key) return null;
    var agent = BY_KEY[key];
    return { key: key, name: agent.name, role: agent.role };
  }

  /** OrgX itself (system, automation) rather than a person or agent; empty counts as OrgX. */
  function isSystem(value) {
    if (value === null || value === undefined) return true;
    var text = String(value).trim();
    return !text || SYSTEM.test(text);
  }

  /** Avatar form for a widget state: asking needs the person, working runs, verifying checks proof. */
  function formForState(state) {
    switch (state) {
      case 'needs_you':
      case 'held':
      case 'paused_for_input':
        return 'asking';
      case 'running':
      case 'queued':
      case 'sending':
        return 'working';
      case 'verifying':
        return 'verifying';
      case 'succeeded':
      case 'confirmed':
        return 'proactive';
      default:
        return 'base';
    }
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  }

  function attrs(map) {
    var out = '';
    Object.keys(map).forEach(function (name) {
      var value = map[name];
      if (value === null || value === undefined || value === '') return;
      out += ' ' + name + '="' + esc(value) + '"';
    });
    return out;
  }

  /**
   * '<ox-avatar>' for an owner. options: agent (key, name, id or domain),
   * name (display name), size (px, default 24), form (kept for the rendered
   * set; photo mode ignores it), className.
   */
  function avatar(options) {
    var o = options || {};
    var who = profile(o.agent, o.name);
    var base = { class: o.className, size: String(Math.round(Number(o.size) || 24)), form: o.form };
    if (who) {
      base.agent = who.key;
      base.name = who.name;
    } else if (isSystem(o.agent) && isSystem(o.name)) {
      base.agent = 'system';
      base.name = 'OrgX';
    } else {
      base.name = String(o.name || o.agent).trim();
    }
    return '<ox-avatar' + attrs(base) + '></ox-avatar>';
  }

  /**
   * '<ox-agent-card>' for an agent: the avatar as a button that reveals name,
   * role, state, current task and "Open in OrgX". Anyone who is not one of the
   * seven agents gets the plain avatar (and label), since there is nothing
   * more to reveal. options: agent, name, size, role, state (kit state chip),
   * statusLabel, detail, updatedAt (-> "updated 2m ago" when no detail), task,
   * href (default: the agent's desk), label (trusted HTML beside the avatar),
   * className.
   */
  function agentCard(options) {
    var o = options || {};
    var who = profile(o.agent, o.name);
    var label = o.label || '';
    if (!who) return avatar(o) + label;
    var time = global.OrgXTime;
    var linkBuilder = global.OrgXLinks;
    var detail = o.detail || (o.updatedAt && time && time.relative(o.updatedAt) ? 'updated ' + time.relative(o.updatedAt, { inline: true }) : '');
    return (
      '<ox-agent-card' +
      attrs({
        class: o.className,
        agent: who.key,
        name: who.name,
        role: o.role || who.role,
        size: String(Math.round(Number(o.size) || 24)),
        state: o.state,
        'status-label': o.statusLabel,
        detail: detail,
        task: o.task,
        href: o.href || (linkBuilder ? linkBuilder.agent(who.key) : ''),
      }) +
      '>' + label + '</ox-agent-card>'
    );
  }

  global.OrgXAgentIdentity = {
    AGENTS: AGENTS.map(function (agent) { return { key: agent.key, name: agent.name, role: agent.role }; }),
    resolveAgentKey: resolveAgentKey,
    profile: profile,
    isSystem: isSystem,
    formForState: formForState,
    avatar: avatar,
    agentCard: agentCard,
  };
})(window);
