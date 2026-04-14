/**
 * liveFeedWidget.ts — HTML widgets for real-time SSE streams from LiveFeedDO.
 *
 * Generates self-contained HTML that:
 *  1. Connects to GET /live-feed/:feedType/:feedId/stream via EventSource
 *  2. Renders live data (agent status or initiative pulse)
 *  3. Handles reconnection with exponential backoff
 *  4. Supports dark + light mode
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
  // Token is appended as ?t=<signed-token> — verified by authHandler before proxying to LiveFeedDO
  const streamUrl = `${streamBaseUrl}/live-feed/${feedType}/${encodeURIComponent(feedId)}/stream?t=${encodeURIComponent(streamToken)}`;
  const displayTitle = title
    ? escapeHtml(title)
    : feedType === 'agent-status'
    ? 'Agent Status'
    : 'Initiative Pulse';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${displayTitle} — Live</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#09090b;--surface:#111113;--border:#27272a;
  --fg:#fafafa;--muted:#71717a;--accent:#7c3aed;
  --success:#22c55e;--warn:#f59e0b;--danger:#ef4444;
  --running:#3b82f6;--idle:#52525b;--queued:#a78bfa;
  --radius:8px;--font:system-ui,-apple-system,'Segoe UI',sans-serif;
}
@media(prefers-color-scheme:light){
  :root{--bg:#fafafa;--surface:#fff;--border:#e4e4e7;--fg:#09090b;--muted:#71717a}
}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:var(--font);font-size:13px;line-height:1.5}
body{padding:16px;max-width:600px;margin:0 auto}
.header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0;
  animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}
.pulse.ok{background:var(--success);animation:none}
.pulse.error{background:var(--danger);animation:none}
h1{font-size:14px;font-weight:600;flex:1}
.status{font-size:11px;color:var(--muted)}
.updated{font-size:10px;color:var(--muted);margin-bottom:10px}
/* agent grid */
.agents{display:flex;flex-direction:column;gap:4px}
.agent{display:flex;align-items:center;gap:8px;padding:6px 10px;
  border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
.agent-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-running{background:var(--running);box-shadow:0 0 0 3px rgba(59,130,246,.2)}
.dot-queued{background:var(--queued)}
.dot-blocked{background:var(--warn)}
.dot-idle{background:var(--idle)}
.agent-name{font-weight:500;font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-task{font-size:11px;color:var(--muted);flex:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-badge{font-size:10px;padding:1px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0}
.badge-running{background:rgba(59,130,246,.12);color:var(--running)}
.badge-queued{background:rgba(167,139,250,.12);color:var(--queued)}
.badge-blocked{background:rgba(245,158,11,.12);color:var(--warn)}
.badge-idle{background:rgba(82,82,91,.12);color:var(--idle)}
/* summary bar */
.summary{display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.summary-item{font-size:11px;color:var(--muted)}
.summary-item strong{color:var(--fg)}
/* initiative pulse layout */
.pulse-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.pulse-card{padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface)}
.pulse-card-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.pulse-card-value{font-size:22px;font-weight:700}
.progress-bar{height:4px;background:var(--border);border-radius:2px;margin-top:6px;overflow:hidden}
.progress-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .4s ease}
.empty{text-align:center;color:var(--muted);padding:20px 0;font-size:12px}
.live-link{display:inline-block;margin-top:12px;font-size:11px;color:var(--accent);text-decoration:none}
.live-link:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="header">
  <div class="pulse" id="pulse"></div>
  <h1>${displayTitle}</h1>
  <span class="status" id="status">Connecting…</span>
</div>
<div class="updated" id="updated"></div>
<div id="content"><div class="empty">Waiting for data…</div></div>
${liveUrl ? `<a class="live-link" href="${escapeHtml(liveUrl)}" target="_blank" rel="noopener">Open live view →</a>` : ''}

<script>
(function(){
  var FEED_TYPE = ${JSON.stringify(feedType)};
  var STREAM_URL = ${JSON.stringify(streamUrl)};

  var pulse = document.getElementById('pulse');
  var statusEl = document.getElementById('status');
  var updatedEl = document.getElementById('updated');
  var contentEl = document.getElementById('content');

  var lastTs = 0;
  var retryDelay = 1000;
  var es = null;

  function fmt(ts) {
    return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderAgentStatus(data) {
    var agents = data.agents || [];
    var summary = data.summary || {};
    if (!agents.length) {
      contentEl.innerHTML = '<div class="empty">No agents active</div>';
      return;
    }
    var parts = [
      '<div class="summary">',
      summary.running ? '<span class="summary-item"><strong>' + summary.running + '</strong> running</span>' : '',
      summary.queued  ? '<span class="summary-item"><strong>' + summary.queued  + '</strong> queued</span>'  : '',
      summary.blocked ? '<span class="summary-item"><strong>' + summary.blocked + '</strong> blocked</span>' : '',
      summary.idle    ? '<span class="summary-item"><strong>' + summary.idle    + '</strong> idle</span>'    : '',
      '</div><div class="agents">',
    ];
    agents.forEach(function(a) {
      parts.push(
        '<div class="agent">' +
        '<div class="agent-dot dot-' + esc(a.status || 'idle') + '"></div>' +
        '<span class="agent-name">' + esc(a.name || a.id) + '</span>' +
        (a.currentTask ? '<span class="agent-task">' + esc(a.currentTask) + '</span>' : '') +
        '<span class="agent-badge badge-' + esc(a.status || 'idle') + '">' + esc(a.status || 'idle') + '</span>' +
        '</div>'
      );
    });
    parts.push('</div>');
    contentEl.innerHTML = parts.join('');
  }

  function renderInitiativePulse(data) {
    // data may be { initiatives: [...], ... } from /api/live/initiatives
    // or a direct initiative object
    var initiative = Array.isArray(data.initiatives) ? data.initiatives[0] : (data.initiative || data);
    if (!initiative) {
      contentEl.innerHTML = '<div class="empty">No initiative data</div>';
      return;
    }
    var pct = initiative.progress || initiative.progress_pct || 0;
    var parts = [
      '<div class="pulse-grid">',
      '<div class="pulse-card">',
      '<div class="pulse-card-label">Progress</div>',
      '<div class="pulse-card-value">' + Math.round(pct) + '%</div>',
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>',
      '</div>',
      '<div class="pulse-card">',
      '<div class="pulse-card-label">Status</div>',
      '<div class="pulse-card-value" style="font-size:16px;margin-top:4px">' + esc(initiative.status || '—') + '</div>',
      '</div>',
      '</div>',
    ];
    if (initiative.title) {
      parts.unshift('<div style="font-size:13px;font-weight:600;margin-bottom:10px">' + esc(initiative.title) + '</div>');
    }
    contentEl.innerHTML = parts.join('');
  }

  function handleData(event) {
    if (event.ts) lastTs = event.ts;
    var data = event.data;
    if (!data) return;

    updatedEl.textContent = 'Updated ' + fmt(event.ts || Date.now());

    if (FEED_TYPE === 'agent-status') {
      renderAgentStatus(data);
    } else {
      renderInitiativePulse(data);
    }
  }

  function connect() {
    if (es) { try { es.close(); } catch(_) {} }
    var url = STREAM_URL + (lastTs ? '?since=' + lastTs : '');
    statusEl.textContent = 'Connecting…';
    es = new EventSource(url);

    es.onopen = function() {
      pulse.className = 'pulse';
      statusEl.textContent = 'Live';
      retryDelay = 1000;
    };

    es.onmessage = function(ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch(_) { return; }
      if (d.type === 'snapshot' || d.type === 'delta') handleData(d);
      if (d.type === 'error') {
        statusEl.textContent = 'Error: ' + (d.message || 'unknown');
        pulse.className = 'pulse error';
      }
    };

    es.onerror = function() {
      try { es.close(); } catch(_) {}
      pulse.className = 'pulse error';
      statusEl.textContent = 'Reconnecting in ' + Math.round(retryDelay/1000) + 's…';
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
