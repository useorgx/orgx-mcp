/**
 * OrgX shared: domain accent palette + agent-attribution helpers.
 *
 * Every widget that surfaces work-by-domain (scaffolded-initiative, pulse,
 * agent-status, decisions, artifact-review) must render domain color from
 * the same palette, or the product visually fragments.
 *
 * Exposes `window.OrgxDomain` for non-module script tags. Also exports
 * named symbols when loaded as an ES module.
 *
 * Canonical domains: product, engineering, marketing, sales, operations,
 * design, orchestrator. Unknown domains fall back to orchestrator (teal).
 *
 * Each accent is an "R,G,B" triplet so widgets can use it as a CSS
 * custom property: `--domain-rgb: ${accent}`, and compose colors as
 * `rgba(var(--domain-rgb), 0.12)`.
 */
(function (global) {
  'use strict';

  const DOMAIN_ACCENTS = Object.freeze({
    product: '22, 163, 74',
    engineering: '6, 182, 212',
    marketing: '249, 115, 22',
    sales: '168, 85, 247',
    operations: '245, 158, 11',
    design: '236, 72, 153',
    orchestrator: '20, 184, 166',
  });

  const AGENT_AVATAR_BY_DOMAIN = Object.freeze({
    product: 'pipeline_intelligence.png',
    engineering: 'engineering_autopilot.png',
    marketing: 'launch_captain.png',
    sales: 'xandy_orchestrator.png',
    operations: 'control_tower.png',
    design: 'design_codex.png',
    orchestrator: 'product_orchestrator.png',
  });

  function normalizeDomain(domain) {
    return typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  }

  function getDomainRgb(domain) {
    const key = normalizeDomain(domain);
    return DOMAIN_ACCENTS[key] || DOMAIN_ACCENTS.orchestrator;
  }

  function getAgentAvatar(domain, baseUrl) {
    const key = normalizeDomain(domain);
    const filename = AGENT_AVATAR_BY_DOMAIN[key] || AGENT_AVATAR_BY_DOMAIN.orchestrator;
    const prefix = typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : 'shared/';
    return prefix.replace(/\/+$/, '') + '/' + filename;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#039;',
        '"': '&quot;',
      }[character];
    });
  }

  /**
   * Render an agent-attribution chip — avatar + name + domain role.
   * The chip's accent is driven by the agent's domain via --domain-rgb.
   *
   * Sizes: 'xs' (20px avatar), 'sm' (24px), 'md' (32px).
   * Spec cap is 32px in agent cards; decision/artifact cards prefer 24px.
   *
   * @param {{ name: string, domain: string, role?: string, avatarUrl?: string }} agent
   * @param {{ size?: 'xs'|'sm'|'md', assetBaseUrl?: string }} [opts]
   */
  function renderAgentChip(agent, opts) {
    const size = (opts && opts.size) || 'sm';
    const baseUrl = opts && opts.assetBaseUrl;
    const safeAgent = agent && typeof agent === 'object' ? agent : {};
    const rgb = getDomainRgb(safeAgent.domain);
    const avatarSrc = safeAgent.avatarUrl || getAgentAvatar(safeAgent.domain, baseUrl);
    const name = safeAgent.name || 'OrgX routing';
    const role = safeAgent.role || normalizeDomain(safeAgent.domain) || 'owner pending';

    return (
      '<span class="agent-chip agent-chip--' + size + '" style="--domain-rgb:' + rgb + ';">' +
      '<span class="agent-chip__avatar"><img src="' + escapeHtml(avatarSrc) + '" alt="" onerror="this.style.display=\'none\'"/></span>' +
      '<span class="agent-chip__identity">' +
      '<span class="agent-chip__name">' + escapeHtml(name) + '</span>' +
      '<span class="agent-chip__role">' + escapeHtml(role) + '</span>' +
      '</span>' +
      '</span>'
    );
  }

  const api = Object.freeze({
    DOMAIN_ACCENTS,
    getDomainRgb,
    getAgentAvatar,
    renderAgentChip,
    normalizeDomain,
  });

  // UMD-style: attach to window AND support module consumers via `export`
  // when loaded as a module in the future.
  if (typeof global !== 'undefined') {
    global.OrgxDomain = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
