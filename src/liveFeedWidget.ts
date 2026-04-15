/**
 * liveFeedWidget.ts — HTML widgets for real-time SSE streams from LiveFeedDO.
 *
 * Generates self-contained HTML that:
 *  1. Connects to GET /live-feed/:feedType/:feedId/stream via EventSource
 *  2. Renders live data (agent status or initiative pulse)
 *  3. Handles reconnection with exponential backoff
 *  4. Supports dark + light mode via prefers-color-scheme
 *
 * Design: aligned with OrgX --ox-* token system (teal primary, domain-colored avatars)
 */

export interface LiveFeedWidgetOptions {
  feedType: 'agent-status' | 'initiative-pulse';
  feedId: string; // initiativeId
  streamBaseUrl: string; // e.g. https://mcp.useorgx.com
  /** Short-lived HMAC-signed stream token embedded in the EventSource URL */
  streamToken: string;
  liveUrl?: string;
  title?: string;
}

export function buildLiveFeedWidget(opts: LiveFeedWidgetOptions): string {
  const { feedType, feedId, streamBaseUrl, streamToken, liveUrl, title } = opts;
  // Token appended as ?t=<signed-token> — verified by authHandler before proxying to LiveFeedDO
  const streamUrl = `${streamBaseUrl}/live-feed/${feedType}/${encodeURIComponent(feedId)}/stream?t=${encodeURIComponent(streamToken)}`;
  const displayTitle = title
    ? escapeHtml(title)
    : feedType === 'agent-status'
    ? 'Agent Status'
    : 'Initiative Pulse';
  const safeLiveUrl = liveUrl ? escapeHtml(liveUrl) : '';
  const eyebrowLabel = feedType === 'agent-status' ? 'LIVE · AGENTS' : 'LIVE · INITIATIVE';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${displayTitle} — Live</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── OrgX Design Tokens (light-first, matches production widgets) ── */
:root,:root[data-theme="light"]{
  --ox-bg:#f8fafc;
  --ox-panel:#ffffff;
  --ox-border:rgba(0,0,0,.08);
  --ox-border-strong:rgba(0,0,0,.15);
  --ox-text:#0f172a;
  --ox-text-muted:#64748b;
  --ox-text-dim:#94a3b8;
  --ox-well:#f1f5f9;
  --ox-well-shadow:inset 0 2px 4px rgba(0,0,0,.02);
  --ox-shadow:0 12px 32px -12px rgba(0,0,0,.1),0 2px 6px rgba(0,0,0,.04);
  --ox-grid:rgba(0,0,0,.03);
}
@media(prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ox-bg:#02040a;
    --ox-panel:rgba(10,15,22,.95);
    --ox-border:rgba(255,255,255,.08);
    --ox-border-strong:rgba(255,255,255,.15);
    --ox-text:#f8fafc;
    --ox-text-muted:rgba(255,255,255,.48);
    --ox-text-dim:rgba(255,255,255,.32);
    --ox-well:rgba(0,0,0,.28);
    --ox-well-shadow:inset 0 2px 10px rgba(0,0,0,.4);
    --ox-shadow:0 24px 48px -20px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05);
    --ox-grid:rgba(255,255,255,.02);
  }
}
:root[data-theme="dark"]{
  --ox-bg:#02040a;
  --ox-panel:rgba(10,15,22,.95);
  --ox-border:rgba(255,255,255,.08);
  --ox-border-strong:rgba(255,255,255,.15);
  --ox-text:#f8fafc;
  --ox-text-muted:rgba(255,255,255,.48);
  --ox-text-dim:rgba(255,255,255,.32);
  --ox-well:rgba(0,0,0,.28);
  --ox-well-shadow:inset 0 2px 10px rgba(0,0,0,.4);
  --ox-shadow:0 24px 48px -20px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05);
  --ox-grid:rgba(255,255,255,.02);
}
/* Invariant tokens */
:root{
  --ox-primary:#00c9a7;--ox-primary-rgb:0,201,167;
  --ox-success:#22c55e;--ox-success-rgb:34,197,94;
  --ox-danger:#f43f5e;
  --ox-warn:#fbbf24;--ox-warn-rgb:251,191,36;
  --ox-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;
  --ox-font:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;
  /* Domain color palette (matches widget-foundation.css) */
  --d-engineering:6,182,212;
  --d-product:22,163,74;
  --d-marketing:249,115,22;
  --d-design:236,72,153;
  --d-sales:168,85,247;
  --d-operations:245,158,11;
  --d-orchestration:0,201,167;
  /* Status colors */
  --s-running:6,182,212;
  --s-queued:168,85,247;
  --s-blocked:245,158,11;
  --r:10px;
}

html,body{
  background:var(--ox-bg);color:var(--ox-text);
  font-family:var(--ox-font);font-size:13px;line-height:1.5;min-height:100%;
}
body{padding:14px 16px 20px;max-width:560px;margin:0 auto}

/* ── Card shell ── */
.card{
  padding:16px 18px;border-radius:16px;
  background:linear-gradient(180deg,rgba(var(--ox-primary-rgb),.05),transparent 48%),var(--ox-panel);
  border:1px solid rgba(var(--ox-primary-rgb),.14);
  box-shadow:var(--ox-shadow);
  position:relative;overflow:hidden;
}
.card::after{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(var(--ox-primary-rgb),.5),transparent);
  pointer-events:none;
}

/* ── Header ── */
.header{display:flex;align-items:center;gap:10px;margin-bottom:4px}

.eyebrow{
  display:flex;align-items:center;gap:7px;
  font-family:var(--ox-mono);font-size:.58rem;font-weight:700;
  letter-spacing:.14em;text-transform:uppercase;color:var(--ox-text-muted);
  margin-bottom:8px;
}
.live-dot{
  width:7px;height:7px;border-radius:50%;flex-shrink:0;
  background:var(--ox-primary);box-shadow:0 0 12px rgba(var(--ox-primary-rgb),.5);
  animation:blink 2s ease-in-out infinite;
}
.live-dot.ok{animation:none;background:var(--ox-success);box-shadow:0 0 10px rgba(var(--ox-success-rgb),.45)}
.live-dot.error{animation:none;background:var(--ox-danger);box-shadow:none}
@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}}

.widget-title{font-size:14px;font-weight:700;letter-spacing:-.02em;color:var(--ox-text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conn-label{font-size:11px;font-family:var(--ox-mono);color:var(--ox-text-muted);flex-shrink:0}
.updated-row{font-size:10px;font-family:var(--ox-mono);color:var(--ox-text-muted);letter-spacing:.04em;margin-bottom:12px;min-height:14px}

/* ── Empty / loading state ── */
.empty{
  text-align:center;color:var(--ox-text-muted);
  padding:24px 0;font-size:12px;font-family:var(--ox-mono);
  letter-spacing:.04em;
}

/* ── Summary bar ── */
.summary{
  display:flex;gap:8px;flex-wrap:wrap;
  margin-bottom:12px;padding-bottom:10px;
  border-bottom:1px solid var(--ox-border);
  align-items:center;
}
.sum-badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:2px 8px;border-radius:999px;
  font-family:var(--ox-mono);font-size:.6rem;font-weight:700;
  letter-spacing:.04em;text-transform:uppercase;
  white-space:nowrap;
}
.sum-badge.running{background:rgba(6,182,212,.12);color:rgb(6,182,212);border:1px solid rgba(6,182,212,.22)}
.sum-badge.queued{background:rgba(168,85,247,.12);color:rgb(168,85,247);border:1px solid rgba(168,85,247,.22)}
.sum-badge.blocked{background:rgba(245,158,11,.12);color:rgb(245,158,11);border:1px solid rgba(245,158,11,.22)}
.sum-badge.idle{background:rgba(255,255,255,.06);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.1)}
@media(prefers-color-scheme:light){
  .sum-badge.idle{background:rgba(0,0,0,.04);color:#94a3b8;border:1px solid rgba(0,0,0,.08)}
}
.sum-badge .sum-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}

/* ── Agent list ── */
.agents{display:flex;flex-direction:column;gap:6px}

.agent-row{
  display:flex;align-items:center;gap:10px;
  padding:10px 12px;border-radius:var(--r);
  border:1px solid var(--ox-border);
  background:rgba(255,255,255,.02);
  transition:background .15s,border-color .15s;
}
.agent-row:hover{background:rgba(var(--ox-primary-rgb),.04);border-color:rgba(var(--ox-primary-rgb),.12)}

/* ── Agent presence: 34×34 container with domain badge ── */
.av-wrap{
  position:relative;width:34px;height:34px;flex-shrink:0;
}
.av{
  width:34px;height:34px;border-radius:9px;
  display:inline-flex;align-items:center;justify-content:center;
  font-family:var(--ox-mono);font-size:.65rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.02em;
  overflow:hidden;
}
.av img{
  width:100%;height:100%;object-fit:cover;border-radius:9px;display:block;
}
/* Domain color variants */
.av-engineering{background:rgba(6,182,212,.12);border:1px solid rgba(6,182,212,.2);color:rgb(6,182,212)}
.av-product{background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.2);color:rgb(22,163,74)}
.av-marketing{background:rgba(249,115,22,.12);border:1px solid rgba(249,115,22,.2);color:rgb(249,115,22)}
.av-design{background:rgba(236,72,153,.12);border:1px solid rgba(236,72,153,.2);color:rgb(236,72,153)}
.av-sales{background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.2);color:rgb(168,85,247)}
.av-operations,.av-ops{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.2);color:rgb(245,158,11)}
.av-orchestration{background:rgba(0,201,167,.12);border:1px solid rgba(0,201,167,.2);color:rgb(0,201,167)}
.av-default{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.45)}

/* Domain badge chip: 14×14, bottom-right of av-wrap */
.domain-badge{
  position:absolute;bottom:-3px;right:-3px;
  width:14px;height:14px;border-radius:4px;
  display:flex;align-items:center;justify-content:center;
  border:1.5px solid var(--ox-bg);
  z-index:1;
}
.domain-badge svg{width:8px;height:8px;display:block}
.domain-badge.engineering{background:rgb(6,182,212);color:#fff}
.domain-badge.product{background:rgb(22,163,74);color:#fff}
.domain-badge.marketing{background:rgb(249,115,22);color:#fff}
.domain-badge.design{background:rgb(236,72,153);color:#fff}
.domain-badge.sales{background:rgb(168,85,247);color:#fff}
.domain-badge.operations{background:rgb(245,158,11);color:#fff}
.domain-badge.orchestration,.domain-badge.default{background:rgb(0,201,167);color:#fff}

.agent-body{flex:1;min-width:0}
.agent-name{font-weight:600;font-size:12px;color:var(--ox-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-task{font-size:11px;color:var(--ox-text-muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-workstream{
  font-size:10px;font-family:var(--ox-mono);color:var(--ox-text-muted);
  opacity:.6;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  letter-spacing:.02em;
}

/* Status pill */
.s-pill{
  display:inline-flex;align-items:center;gap:5px;
  padding:3px 8px;border-radius:999px;
  font-family:var(--ox-mono);font-size:.6rem;font-weight:700;
  letter-spacing:.05em;text-transform:uppercase;
  white-space:nowrap;flex-shrink:0;
}
.s-running{background:rgba(6,182,212,.1);color:rgb(6,182,212);border:1px solid rgba(6,182,212,.2)}
.s-queued{background:rgba(168,85,247,.1);color:rgb(168,85,247);border:1px solid rgba(168,85,247,.2)}
.s-blocked{background:rgba(245,158,11,.1);color:rgb(245,158,11);border:1px solid rgba(245,158,11,.2)}
.s-idle{background:rgba(255,255,255,.05);color:rgba(255,255,255,.38);border:1px solid rgba(255,255,255,.08)}
.s-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.s-running .s-dot{box-shadow:0 0 6px currentColor;animation:spulse 1.8s ease-in-out infinite}
@keyframes spulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ── Initiative pulse ── */
.pulse-title{font-size:13px;font-weight:600;color:var(--ox-text);letter-spacing:-.01em;margin-bottom:12px;line-height:1.35}

/* Radial progress ring */
.ring-wrap{
  display:flex;align-items:center;justify-content:center;
  position:relative;width:36px;height:36px;flex-shrink:0;
}
.ring-wrap svg{display:block}
.ring-track{fill:none;stroke:rgba(255,255,255,.08);stroke-width:2.5}
.ring-fill{
  fill:none;stroke-width:2.5;stroke-linecap:round;
  stroke:rgb(var(--progress-rgb,0,201,167));
  transition:stroke-dashoffset 180ms ease;
  transform-origin:center;transform:rotate(-90deg);
}
.ring-label{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-family:var(--ox-mono);font-size:.52rem;font-weight:700;
  color:var(--ox-text);letter-spacing:-.01em;line-height:1;
}
@media(prefers-color-scheme:light){
  .ring-track{stroke:rgba(0,0,0,.08)}
}

.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px}
.stat-card{
  padding:12px 14px;border-radius:var(--r);
  border:1px solid var(--ox-border);
  background:var(--ox-well);
  box-shadow:inset 0 2px 6px rgba(0,0,0,.2);
}
@media(prefers-color-scheme:light){
  .stat-card{box-shadow:inset 0 2px 4px rgba(0,0,0,.04)}
}
.stat-label{
  font-family:var(--ox-mono);font-size:.6rem;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;color:var(--ox-text-muted);margin-bottom:6px;
}
.stat-value{
  font-family:var(--ox-mono);font-size:1.5rem;font-weight:700;
  letter-spacing:-.03em;color:var(--ox-text);line-height:1;
}
.stat-sub{font-size:.78rem;color:var(--ox-text-muted);margin-top:4px}

/* Progress bar inside stat card */
.prog-bar{height:3px;background:var(--ox-border);border-radius:2px;overflow:hidden;margin-top:8px}
.prog-fill{
  height:100%;background:var(--ox-primary);border-radius:2px;
  transition:width .45s ease;
  box-shadow:0 0 8px rgba(var(--ox-primary-rgb),.5);
}

/* Status badge with icon (health indicator) */
.health-badge{
  display:inline-flex;align-items:center;gap:5px;
  padding:4px 9px;border-radius:6px;
  font-family:var(--ox-mono);font-size:.6rem;font-weight:700;
  letter-spacing:.05em;text-transform:uppercase;margin-top:6px;
}
.health-badge svg{width:10px;height:10px;display:block;flex-shrink:0}
.health-active{background:rgba(34,197,94,.1);color:rgb(34,197,94);border:1px solid rgba(34,197,94,.2)}
.health-running{background:rgba(6,182,212,.1);color:rgb(6,182,212);border:1px solid rgba(6,182,212,.2)}
.health-paused,.health-pending{background:rgba(245,158,11,.1);color:rgb(245,158,11);border:1px solid rgba(245,158,11,.2)}
.health-blocked,.health-at_risk{background:rgba(244,63,94,.1);color:rgb(244,63,94);border:1px solid rgba(244,63,94,.2)}
.health-done,.health-completed{background:rgba(34,197,94,.1);color:rgb(34,197,94);border:1px solid rgba(34,197,94,.2)}
.health-default{background:rgba(255,255,255,.06);color:rgba(255,255,255,.38);border:1px solid rgba(255,255,255,.1)}

/* Risk level badge */
.risk-badge{
  display:inline-flex;align-items:center;gap:5px;
  padding:4px 10px;border-radius:6px;
  font-family:var(--ox-mono);font-size:.6rem;font-weight:700;
  letter-spacing:.05em;text-transform:uppercase;margin-top:6px;
}
.risk-low{background:rgba(34,197,94,.1);color:rgb(34,197,94);border:1px solid rgba(34,197,94,.2)}
.risk-medium{background:rgba(245,158,11,.1);color:rgb(245,158,11);border:1px solid rgba(245,158,11,.2)}
.risk-high{background:rgba(244,63,94,.1);color:rgb(244,63,94);border:1px solid rgba(244,63,94,.2)}

/* ── Workstream breakdown ── */
.ws-section{margin-top:12px;padding-top:10px;border-top:1px solid var(--ox-border)}
.ws-section-label{
  font-family:var(--ox-mono);font-size:.58rem;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;color:var(--ox-text-muted);
  margin-bottom:8px;
}
.ws-list{display:flex;flex-direction:column;gap:5px}
.ws-row{
  display:flex;align-items:center;gap:8px;
  padding:7px 10px;border-radius:8px;
  border:1px solid var(--ox-border);
  background:rgba(255,255,255,.015);
}
.ws-accent{
  width:3px;border-radius:2px;align-self:stretch;flex-shrink:0;min-height:16px;
}
.ws-name{
  flex:1;min-width:0;font-size:11px;font-weight:500;color:var(--ox-text);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.ws-status-badge{
  font-family:var(--ox-mono);font-size:.55rem;font-weight:700;
  letter-spacing:.04em;text-transform:uppercase;
  padding:2px 6px;border-radius:999px;white-space:nowrap;flex-shrink:0;
}
.ws-status-badge.running{background:rgba(6,182,212,.12);color:rgb(6,182,212)}
.ws-status-badge.done,.ws-status-badge.completed{background:rgba(34,197,94,.12);color:rgb(34,197,94)}
.ws-status-badge.blocked,.ws-status-badge.at_risk{background:rgba(244,63,94,.12);color:rgb(244,63,94)}
.ws-status-badge.queued,.ws-status-badge.pending{background:rgba(168,85,247,.12);color:rgb(168,85,247)}
.ws-status-badge.default{background:rgba(255,255,255,.06);color:rgba(255,255,255,.38)}
.ws-mini-bar{
  width:40px;height:3px;background:var(--ox-border);border-radius:2px;overflow:hidden;flex-shrink:0;
}
.ws-mini-fill{height:100%;border-radius:2px;transition:width .3s ease}

/* ── Footer ── */
.footer{
  display:flex;align-items:center;justify-content:space-between;
  margin-top:14px;padding-top:12px;border-top:1px solid var(--ox-border);
  flex-wrap:wrap;gap:8px;
}
.footer-meta{
  font-family:var(--ox-mono);font-size:.6rem;letter-spacing:.1em;
  text-transform:uppercase;color:var(--ox-text-muted);font-weight:700;
}
.footer-link{
  font-family:var(--ox-mono);font-size:.65rem;letter-spacing:.04em;
  color:var(--ox-primary);text-decoration:none;
  display:inline-flex;align-items:center;gap:4px;
  padding:4px 10px;border-radius:6px;
  border:1px solid rgba(var(--ox-primary-rgb),.2);
  background:rgba(var(--ox-primary-rgb),.06);
  transition:background .15s,border-color .15s;white-space:nowrap;
}
.footer-link:hover{background:rgba(var(--ox-primary-rgb),.12);border-color:rgba(var(--ox-primary-rgb),.3)}
</style>
</head>
<body>

<div class="card">
  <!-- Live eyebrow -->
  <div class="eyebrow">
    <div class="live-dot" id="ldot"></div>
    <span>${eyebrowLabel}</span>
  </div>

  <!-- Title row -->
  <div class="header">
    <div class="widget-title">${displayTitle}</div>
    <span class="conn-label" id="connLabel">Connecting…</span>
  </div>
  <div class="updated-row" id="updatedRow"></div>

  <!-- Content area -->
  <div id="content"><div class="empty">Waiting for data…</div></div>

  <!-- Footer -->
  <div class="footer">
    <span class="footer-meta">LIVE FEED</span>
    ${safeLiveUrl ? `<a class="footer-link" href="${safeLiveUrl}" target="_blank" rel="noopener">Open Live View ↗</a>` : ''}
  </div>
</div>

<script>
(function(){
  var FEED_TYPE  = ${JSON.stringify(feedType)};
  var STREAM_URL = ${JSON.stringify(streamUrl)};
  var LIVE_URL   = ${JSON.stringify(liveUrl ?? '')};
  var IMG_BASE   = 'https://mcp.useorgx.com/widgets/shared/';

  var ldot       = document.getElementById('ldot');
  var connLabel  = document.getElementById('connLabel');
  var updatedRow = document.getElementById('updatedRow');
  var contentEl  = document.getElementById('content');

  var lastTs    = 0;
  var retryDelay = 1000;
  var es        = null;

  /* ── Helpers ── */
  function fmt(ts) {
    return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function domainKey(d) {
    var domain = (d || '').toLowerCase().replace(/[^a-z]/g, '');
    var valid = ['engineering','product','marketing','design','sales','operations','ops','orchestration'];
    return valid.indexOf(domain) !== -1 ? domain : 'default';
  }
  function domainInitial(name, domain) {
    if (domain) return domain.slice(0,2).toUpperCase();
    return (name || '?').slice(0,2).toUpperCase();
  }

  /* ── Domain → avatar image filename ── */
  function domainAvatarImg(domain) {
    var map = {
      engineering: 'engineering_autopilot.png',
      product: 'product_orchestrator.png',
      marketing: 'launch_captain.png',
      sales: 'pipeline_intelligence.png',
      operations: 'control_tower.png',
      design: 'design_codex.png',
      orchestration: 'xandy_orchestrator.png',
      ops: 'control_tower.png'
    };
    return map[domain] || 'xandy_orchestrator.png';
  }

  /* ── Domain badge SVG icons ── */
  function domainBadgeSvg(domain) {
    var icons = {
      engineering: '<polyline points="9 8 5 12 9 16"></polyline><polyline points="15 8 19 12 15 16"></polyline>',
      product: '<circle cx="12" cy="12" r="9" fill="currentColor" fill-opacity="0.1"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>',
      marketing: '<path d="M3 11v2"></path><path d="M6 10v4"></path><path d="M9 9v6"></path><path d="M9 10c5 0 8-4 8-4v12s-3-4-8-4"></path>',
      design: '<path d="m12 4 1.3 4.2L17.5 9.5l-4.2 1.3L12 15l-1.3-4.2L6.5 9.5l4.2-1.3z" fill="currentColor" stroke="none"></path>',
      sales: '<path d="M5 15 10 10 13 13 19 7"></path><path d="M15 7h4v4"></path>',
      operations: '<circle cx="12" cy="12" r="3"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path>',
      default: '<circle cx="6" cy="12" r="2" fill="currentColor" stroke="none"></circle><circle cx="18" cy="7" r="2" fill="currentColor" stroke="none"></circle><circle cx="18" cy="17" r="2" fill="currentColor" stroke="none"></circle><path d="M8 12h6"></path><path d="M16.2 8.3 12.8 11"></path><path d="M16.2 15.7 12.8 13"></path>'
    };
    return icons[domain] || icons['default'];
  }

  /* ── Build agent presence HTML (avatar + badge) ── */
  function buildAvatar(domain, name) {
    var cls = domainKey(domain);
    var badgeCls = (cls === 'ops') ? 'operations' : cls;
    var imgFile = domainAvatarImg(cls);
    var initial = esc(domainInitial(name, domain));
    var badgeSvg = domainBadgeSvg(badgeCls);
    var imgSrc = esc(IMG_BASE + imgFile);
    return (
      '<div class="av-wrap">' +
        '<div class="av av-' + cls + '">' +
          '<img src="' + imgSrc + '" alt="" onerror="this.style.display=&apos;none&apos;" />' +
          initial +
        '</div>' +
        '<div class="domain-badge ' + badgeCls + '">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            badgeSvg +
          '</svg>' +
        '</div>' +
      '</div>'
    );
  }

  /* ── Domain RGB helper for workstream accents ── */
  function domainRgb(domain) {
    var map = {
      engineering:'6,182,212',
      product:'22,163,74',
      marketing:'249,115,22',
      design:'236,72,153',
      sales:'168,85,247',
      operations:'245,158,11',
      ops:'245,158,11',
      orchestration:'0,201,167'
    };
    return map[(domain||'').toLowerCase()] || '0,201,167';
  }

  /* ── Health badge for initiative status ── */
  function healthBadge(status) {
    var s = (status || '').toLowerCase().replace(/[^a-z_]/g,'');
    var icons = {
      active:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"></polygon></svg>',
      running:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"></polygon></svg>',
      paused:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 8 8 12 12 16"></polyline><line x1="16" y1="12" x2="8" y2="12"></line></svg>',
      pending:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 8 12 12 14 14"></polyline></svg>',
      blocked:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>',
      at_risk:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
      done:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
      completed:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
    };
    var cls = 'health-' + (icons[s] ? s : 'default');
    var icon = icons[s] || '';
    return '<div class="health-badge ' + cls + '">' + icon + esc(status || '—') + '</div>';
  }

  /* ── Radial progress ring ── */
  function buildRing(pct, rgb) {
    var r = 14;
    var circ = 2 * Math.PI * r; // ≈ 87.96
    var offset = circ * (1 - Math.min(Math.max(pct, 0), 100) / 100);
    return (
      '<div class="ring-wrap">' +
        '<svg width="36" height="36" viewBox="0 0 36 36">' +
          '<circle class="ring-track" cx="18" cy="18" r="' + r + '"></circle>' +
          '<circle class="ring-fill" cx="18" cy="18" r="' + r + '"' +
            ' stroke-dasharray="' + circ.toFixed(2) + '"' +
            ' stroke-dashoffset="' + offset.toFixed(2) + '"' +
            ' style="--progress-rgb:' + (rgb || '0,201,167') + '">' +
          '</circle>' +
        '</svg>' +
        '<div class="ring-label">' + pct + '%</div>' +
      '</div>'
    );
  }

  /* ── Agent status renderer ── */
  function renderAgentStatus(data) {
    var agents  = data.agents || [];
    var summary = data.summary || {};
    if (!agents.length) {
      contentEl.innerHTML = '<div class="empty">No agents active</div>';
      return;
    }

    var parts = [];

    /* Summary bar — colored count badges */
    var sumParts = [];
    if (summary.running) sumParts.push('<span class="sum-badge running"><span class="sum-dot"></span>' + summary.running + ' running</span>');
    if (summary.queued)  sumParts.push('<span class="sum-badge queued"><span class="sum-dot"></span>' + summary.queued  + ' queued</span>');
    if (summary.blocked) sumParts.push('<span class="sum-badge blocked"><span class="sum-dot"></span>' + summary.blocked + ' blocked</span>');
    if (summary.idle)    sumParts.push('<span class="sum-badge idle">' + summary.idle + ' idle</span>');
    if (sumParts.length) parts.push('<div class="summary">' + sumParts.join('') + '</div>');

    /* Agent rows */
    parts.push('<div class="agents">');
    agents.forEach(function(a) {
      var domain  = (a.domain || '').toLowerCase();
      var status  = (a.status || 'idle').toLowerCase();
      var pill    = '<span class="s-pill s-' + esc(status) + '"><span class="s-dot"></span>' + esc(a.status || 'idle') + '</span>';
      var avatar  = buildAvatar(domain, a.name || a.id);

      parts.push(
        '<div class="agent-row">' +
        avatar +
        '<div class="agent-body">' +
          '<div class="agent-name">' + esc(a.name || a.id) + '</div>' +
          (a.currentTask
            ? '<div class="agent-task">' + esc(a.currentTask) + '</div>'
            : '<div class="agent-task" style="font-style:italic;opacity:.6">—</div>') +
          (a.workstream
            ? '<div class="agent-workstream">' + esc(a.workstream) + '</div>'
            : '') +
        '</div>' +
        pill +
        '</div>'
      );
    });
    parts.push('</div>');
    contentEl.innerHTML = parts.join('');
  }

  /* ── Initiative pulse renderer ── */
  function renderInitiativePulse(data) {
    var initiative = Array.isArray(data.initiatives) ? data.initiatives[0] : (data.initiative || data);
    if (!initiative) {
      contentEl.innerHTML = '<div class="empty">No initiative data</div>';
      return;
    }

    var pct     = Math.round(initiative.progress || initiative.progress_pct || 0);
    var status  = initiative.status || '—';
    var risk    = (initiative.risk_level || 'low').toLowerCase();
    var wsTotal = initiative.workstreamCount || initiative.activeWorkstreams || 0;
    var activeRuns = initiative.activeRuns || 0;
    var streams = initiative.workstreams || initiative.streams || [];

    var parts = [];

    if (initiative.title) {
      parts.push('<div class="pulse-title">' + esc(initiative.title) + '</div>');
    }

    parts.push('<div class="stat-grid">');

    /* Progress card — with radial ring */
    parts.push(
      '<div class="stat-card">' +
        '<div class="stat-label">Progress</div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-top:4px">' +
          buildRing(pct, '0,201,167') +
          '<div>' +
            '<div class="stat-value" style="font-size:1.2rem">' + pct + '%</div>' +
            '<div class="prog-bar" style="width:64px;margin-top:6px"><div class="prog-fill" style="width:' + pct + '%"></div></div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    /* Status card — health indicator badge */
    parts.push(
      '<div class="stat-card">' +
        '<div class="stat-label">Status</div>' +
        healthBadge(status) +
        '<div class="risk-badge risk-' + esc(risk) + '" style="margin-top:6px">' + esc(risk) + ' risk</div>' +
      '</div>'
    );

    /* Workstreams card */
    if (wsTotal > 0) {
      parts.push(
        '<div class="stat-card">' +
          '<div class="stat-label">Workstreams</div>' +
          '<div class="stat-value">' + wsTotal + '</div>' +
          '<div class="stat-sub">active</div>' +
        '</div>'
      );
    }

    /* Active runs card */
    if (activeRuns > 0) {
      parts.push(
        '<div class="stat-card">' +
          '<div class="stat-label">Active Runs</div>' +
          '<div class="stat-value">' + activeRuns + '</div>' +
          '<div class="stat-sub">in flight</div>' +
        '</div>'
      );
    }

    parts.push('</div>');

    /* Workstream breakdown section */
    if (streams && streams.length > 0) {
      parts.push('<div class="ws-section"><div class="ws-section-label">Workstreams</div><div class="ws-list">');
      streams.forEach(function(ws) {
        var wsDomain = (ws.domain || 'orchestration').toLowerCase();
        var wsRgb = domainRgb(wsDomain);
        var wsPct = Math.round(ws.progress || ws.progress_pct || 0);
        var wsStatus = (ws.status || 'pending').toLowerCase().replace(/\s+/g,'_');
        var wsStatusDisplay = wsStatus.replace(/_/g,' ');
        var wsBadgeCls = ['running','done','completed','blocked','at_risk','queued','pending'].indexOf(wsStatus) !== -1 ? wsStatus : 'default';
        parts.push(
          '<div class="ws-row">' +
            '<div class="ws-accent" style="background:rgb(' + wsRgb + ')"></div>' +
            '<div class="ws-name">' + esc(ws.name || ws.title || 'Workstream') + '</div>' +
            '<span class="ws-status-badge ' + wsBadgeCls + '">' + esc(wsStatusDisplay) + '</span>' +
            '<div class="ws-mini-bar"><div class="ws-mini-fill" style="width:' + wsPct + '%;background:rgb(' + wsRgb + ')"></div></div>' +
          '</div>'
        );
      });
      parts.push('</div></div>');
    }

    contentEl.innerHTML = parts.join('');
  }

  /* ── Event dispatcher ── */
  function handleData(event) {
    if (event.ts) lastTs = event.ts;
    var data = event.data;
    if (!data) return;

    updatedRow.textContent = 'Updated ' + fmt(event.ts || Date.now());

    if (FEED_TYPE === 'agent-status') {
      renderAgentStatus(data);
    } else {
      renderInitiativePulse(data);
    }
  }

  /* ── SSE connection with backoff ── */
  function connect() {
    if (es) { try { es.close(); } catch(_) {} }
    var url = STREAM_URL + (lastTs ? '&since=' + lastTs : '');
    connLabel.textContent = 'Connecting\u2026';
    es = new EventSource(url);

    es.onopen = function() {
      ldot.className = 'live-dot ok';
      connLabel.textContent = 'Live';
      retryDelay = 1000;
    };

    es.onmessage = function(ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch(_) { return; }
      if (d.type === 'snapshot' || d.type === 'delta') {
        ldot.className = 'live-dot ok';
        connLabel.textContent = 'Live';
        handleData(d);
      }
      if (d.type === 'error') {
        connLabel.textContent = 'Error: ' + (d.message || 'unknown');
        ldot.className = 'live-dot error';
      }
    };

    es.onerror = function() {
      try { es.close(); } catch(_) {}
      ldot.className = 'live-dot error';
      var wait = Math.round(retryDelay / 1000);
      connLabel.textContent = 'Reconnecting in ' + wait + 's\u2026';
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };
  }

  connect();
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
