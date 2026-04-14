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

/* ── OrgX Design Tokens ── */
:root{
  --ox-bg:#02040a;
  --ox-panel:rgba(10,15,22,.95);
  --ox-border:rgba(255,255,255,.08);
  --ox-border-strong:rgba(255,255,255,.15);
  --ox-text:#f8fafc;
  --ox-text-muted:rgba(255,255,255,.48);
  --ox-well:rgba(0,0,0,.28);
  --ox-shadow:0 24px 48px -20px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05);
  --ox-primary:#00c9a7;
  --ox-primary-rgb:0,201,167;
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

@media(prefers-color-scheme:light){
  :root{
    --ox-bg:#f8fafc;--ox-panel:#fff;
    --ox-border:rgba(0,0,0,.08);--ox-border-strong:rgba(0,0,0,.15);
    --ox-text:#0f172a;--ox-text-muted:#64748b;
    --ox-well:#f1f5f9;
    --ox-shadow:0 12px 32px -12px rgba(0,0,0,.1),0 2px 6px rgba(0,0,0,.04);
  }
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
  display:flex;gap:14px;flex-wrap:wrap;
  margin-bottom:12px;padding-bottom:10px;
  border-bottom:1px solid var(--ox-border);
}
.summary-item{font-size:11px;font-family:var(--ox-mono);color:var(--ox-text-muted)}
.summary-item strong{color:var(--ox-text);font-weight:700}

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

/* Domain avatar (letter icon) */
.av{
  width:32px;height:32px;border-radius:9px;
  display:inline-flex;align-items:center;justify-content:center;
  flex-shrink:0;font-family:var(--ox-mono);font-size:.65rem;font-weight:700;
  text-transform:uppercase;letter-spacing:.02em;
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

.agent-body{flex:1;min-width:0}
.agent-name{font-weight:600;font-size:12px;color:var(--ox-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-task{font-size:11px;color:var(--ox-text-muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

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
  function domainClass(d) {
    var domain = (d || '').toLowerCase().replace(/[^a-z]/g, '');
    var valid = ['engineering','product','marketing','design','sales','operations','ops','orchestration'];
    return valid.indexOf(domain) !== -1 ? domain : 'default';
  }
  function domainInitial(name, domain) {
    if (domain) return domain.slice(0,2).toUpperCase();
    return (name || '?').slice(0,2).toUpperCase();
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

    /* Summary bar */
    var sumParts = [];
    if (summary.running) sumParts.push('<span class="summary-item"><strong>' + summary.running + '</strong> running</span>');
    if (summary.queued)  sumParts.push('<span class="summary-item"><strong>' + summary.queued  + '</strong> queued</span>');
    if (summary.blocked) sumParts.push('<span class="summary-item"><strong>' + summary.blocked + '</strong> blocked</span>');
    if (summary.idle)    sumParts.push('<span class="summary-item"><strong>' + summary.idle    + '</strong> idle</span>');
    if (sumParts.length) parts.push('<div class="summary">' + sumParts.join('') + '</div>');

    /* Agent rows */
    parts.push('<div class="agents">');
    agents.forEach(function(a) {
      var domain  = (a.domain || '').toLowerCase();
      var cls     = domainClass(domain);
      var initial = domainInitial(a.name || a.id, domain);
      var status  = (a.status || 'idle').toLowerCase();
      var pill    = '<span class="s-pill s-' + esc(status) + '"><span class="s-dot"></span>' + esc(a.status || 'idle') + '</span>';

      parts.push(
        '<div class="agent-row">' +
        '<div class="av av-' + cls + '">' + esc(initial) + '</div>' +
        '<div class="agent-body">' +
        '<div class="agent-name">' + esc(a.name || a.id) + '</div>' +
        (a.currentTask ? '<div class="agent-task">' + esc(a.currentTask) + '</div>' : '<div class="agent-task" style="font-style:italic;opacity:.6">—</div>') +
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
    var status  = esc(initiative.status || '—');
    var risk    = (initiative.risk_level || 'low').toLowerCase();
    var wsTotal = initiative.workstreamCount || initiative.activeWorkstreams || 0;
    var activeRuns = initiative.activeRuns || 0;

    var parts = [];

    if (initiative.title) {
      parts.push('<div class="pulse-title">' + esc(initiative.title) + '</div>');
    }

    parts.push('<div class="stat-grid">');

    /* Progress card */
    parts.push(
      '<div class="stat-card">' +
      '<div class="stat-label">Progress</div>' +
      '<div class="stat-value">' + pct + '%</div>' +
      '<div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%"></div></div>' +
      '</div>'
    );

    /* Status card */
    parts.push(
      '<div class="stat-card">' +
      '<div class="stat-label">Status</div>' +
      '<div class="stat-value" style="font-size:1rem;margin-top:4px">' + status + '</div>' +
      '<div class="risk-badge risk-' + esc(risk) + '">' + esc(risk) + ' risk</div>' +
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
    connLabel.textContent = 'Connecting…';
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
      connLabel.textContent = 'Reconnecting in ' + wait + 's…';
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
