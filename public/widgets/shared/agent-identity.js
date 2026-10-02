/**
 * Map an agent name, id or domain to one of the seven OrgX agent keys used
 * by <ox-avatar> (pace, eli, mark, sage, orion, dana, xandy).
 *
 * Matches whole words only, so "Developer" or "Scope" never resolve to an
 * agent by accident. Returns null for system or unknown owners.
 */
(function attachAgentIdentity(global) {
  var AGENTS = [
    { key: 'pace', words: ['pace', 'product', 'product-agent', 'product_orchestrator'] },
    { key: 'eli', words: ['eli', 'engineering', 'engineering-agent', 'engineering_autopilot'] },
    { key: 'mark', words: ['mark', 'marketing', 'marketing-agent', 'launch_captain'] },
    { key: 'sage', words: ['sage', 'sales', 'sales-agent', 'pipeline_intelligence'] },
    { key: 'orion', words: ['orion', 'operations', 'ops', 'operations-agent', 'control_tower'] },
    { key: 'dana', words: ['dana', 'design', 'design-agent', 'design_codex'] },
    { key: 'xandy', words: ['xandy', 'orchestrator', 'orchestrator-agent', 'xandy_orchestrator'] },
  ];

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

  global.OrgXAgentIdentity = { resolveAgentKey: resolveAgentKey, formForState: formForState };
})(window);
