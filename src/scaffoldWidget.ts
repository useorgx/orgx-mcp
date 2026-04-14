/**
 * scaffoldWidget.ts — self-contained HTML widget for real-time scaffold streaming.
 *
 * Generates a single-file HTML document that:
 *  1. Connects to GET /scaffold/:sessionId/stream via EventSource
 *  2. Renders an animated tree as entities are created
 *  3. Shows a celebration state when scaffold is complete
 *  4. Handles reconnection with exponential backoff
 *  5. Supports dark + light mode via prefers-color-scheme
 *  6. Is responsive for Claude.ai + ChatGPT MCP App iframe constraints (~600px)
 *
 * The widget is intentionally self-contained (no external dependencies) so it
 * works inside sandboxed iframes and passes CSP checks.
 */

export interface ScaffoldWidgetOptions {
  sessionId: string;
  streamBaseUrl: string; // e.g. https://mcp.useorgx.com
  initiativeTitle?: string;
  liveUrl?: string;
}

export function buildScaffoldWidget(opts: ScaffoldWidgetOptions): string {
  const { sessionId, streamBaseUrl, initiativeTitle, liveUrl } = opts;
  const streamUrl = `${streamBaseUrl}/scaffold/${encodeURIComponent(sessionId)}/stream`;
  const title = initiativeTitle ? escapeHtml(initiativeTitle) : 'Building initiative...';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#09090b;--surface:#111113;--border:#27272a;
  --fg:#fafafa;--muted:#71717a;--accent:#7c3aed;
  --accent-dim:rgba(124,58,237,.12);--success:#22c55e;
  --ws:#3b82f6;--ms:#f59e0b;--task:#a1a1aa;
  --radius:8px;--font:system-ui,-apple-system,'Segoe UI',sans-serif;
}
@media(prefers-color-scheme:light){
  :root{--bg:#fafafa;--surface:#fff;--border:#e4e4e7;--fg:#09090b;--muted:#71717a;--accent-dim:rgba(124,58,237,.08)}
}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:var(--font);font-size:13px;line-height:1.5}
body{padding:16px;max-width:600px;margin:0 auto}
/* ── Header ── */
.header{display:flex;align-items:flex-start;gap:10px;margin-bottom:16px}
.pulse{width:10px;height:10px;border-radius:50%;background:var(--accent);flex-shrink:0;margin-top:4px;
  animation:pulse 2s cubic-bezier(.4,0,.6,1) infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}
.pulse.done{background:var(--success);animation:none}
.pulse.error{background:#ef4444;animation:none}
.header-text h1{font-size:14px;font-weight:600;color:var(--fg)}
.header-text p{font-size:12px;color:var(--muted);margin-top:2px}
/* ── Progress bar ── */
.progress-bar{height:2px;background:var(--border);border-radius:1px;margin-bottom:14px;overflow:hidden}
.progress-fill{height:100%;background:var(--accent);border-radius:1px;transition:width .4s ease;width:0%}
/* ── Tree ── */
.tree{display:flex;flex-direction:column;gap:2px}
.node{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-radius:var(--radius);
  border:1px solid transparent;opacity:0;transform:translateY(6px);transition:all .25s ease;
  cursor:default}
.node.in{opacity:1;transform:translateY(0)}
.node.initiative{border-color:var(--border);background:var(--surface);font-weight:600;font-size:13px}
.node.workstream{margin-left:16px;border-color:transparent;font-size:12px;color:var(--fg)}
.node.milestone{margin-left:32px;font-size:12px;color:var(--muted)}
.node.task{margin-left:48px;font-size:11px;color:var(--muted)}
.node-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px}
.dot-initiative{background:var(--accent)}
.dot-workstream{background:var(--ws)}
.dot-milestone{background:var(--ms)}
.dot-task{background:var(--task)}
.node-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.node-badge{font-size:10px;color:var(--muted);white-space:nowrap;margin-left:auto;padding-left:8px;flex-shrink:0}
/* ── Complete / error states ── */
.complete-banner{display:none;margin-top:16px;padding:12px 14px;border-radius:var(--radius);
  background:var(--accent-dim);border:1px solid rgba(124,58,237,.2);
  font-size:12px;color:var(--fg)}
.complete-banner.show{display:flex;align-items:center;gap:10px}
.complete-banner svg{flex-shrink:0;color:var(--success)}
.complete-banner a{color:var(--accent);text-decoration:none;font-weight:500}
.complete-banner a:hover{text-decoration:underline}
.error-banner{display:none;margin-top:16px;padding:12px 14px;border-radius:var(--radius);
  background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);
  font-size:12px;color:#ef4444}
.error-banner.show{display:block}
/* ── Count badge ── */
.count{font-size:11px;color:var(--muted);margin-top:10px;text-align:right}
</style>
</head>
<body>
<div class="header">
  <div class="pulse" id="pulse"></div>
  <div class="header-text">
    <h1 id="title">${title}</h1>
    <p id="subtitle">Connecting to stream…</p>
  </div>
</div>
<div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
<div class="tree" id="tree"></div>
<div class="count" id="count" style="display:none"></div>
<div class="complete-banner" id="completeBanner">
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/>
    <path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <span id="completeBannerText">Initiative created.</span>
</div>
<div class="error-banner" id="errorBanner"></div>

<script>
(function(){
  var SESSION_ID = ${JSON.stringify(sessionId)};
  var STREAM_URL = ${JSON.stringify(streamUrl)};
  var LIVE_URL   = ${JSON.stringify(liveUrl ?? '')};

  var pulse = document.getElementById('pulse');
  var title = document.getElementById('title');
  var subtitle = document.getElementById('subtitle');
  var progressFill = document.getElementById('progressFill');
  var tree = document.getElementById('tree');
  var countEl = document.getElementById('count');
  var completeBanner = document.getElementById('completeBanner');
  var completeBannerText = document.getElementById('completeBannerText');
  var errorBanner = document.getElementById('errorBanner');

  var entityCount = 0;
  var lastEventTs = 0;
  var retryDelay = 1000;
  var maxRetry = 30000;
  var es = null;

  // Type → display label
  var TYPE_LABELS = {
    initiative: 'Initiative',
    workstream: 'Workstream',
    milestone: 'Milestone',
    task: 'Task'
  };

  function addNode(type, label, badge) {
    var node = document.createElement('div');
    node.className = 'node ' + type;
    var dotClass = 'dot-' + type;
    node.innerHTML =
      '<div class="node-dot ' + dotClass + '"></div>' +
      '<span class="node-label" title="' + escapeAttr(label) + '">' + escapeHtml(label) + '</span>' +
      (badge ? '<span class="node-badge">' + escapeHtml(badge) + '</span>' : '');
    tree.appendChild(node);
    // Trigger animation on next frame
    requestAnimationFrame(function() { node.classList.add('in'); });
    return node;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g,'&quot;');
  }

  function setProgress(pct) {
    progressFill.style.width = Math.min(100, pct) + '%';
  }

  function connect() {
    if (es) { try { es.close(); } catch(_) {} }
    var url = STREAM_URL + (lastEventTs ? '?since=' + lastEventTs : '');
    subtitle.textContent = 'Connecting…';
    es = new EventSource(url);

    es.onopen = function() {
      subtitle.textContent = 'Streaming live…';
      retryDelay = 1000;
    };

    es.onmessage = function(ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch(_) { return; }
      if (data.ts) lastEventTs = data.ts;
      handleEvent(data);
    };

    es.onerror = function() {
      try { es.close(); } catch(_) {}
      subtitle.textContent = 'Reconnecting in ' + Math.round(retryDelay/1000) + 's…';
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, maxRetry);
    };
  }

  function handleEvent(data) {
    switch (data.type) {
      case 'session.start':
        if (data.title) title.textContent = data.title;
        subtitle.textContent = 'Building hierarchy…';
        setProgress(2);
        break;

      case 'entity.created':
        entityCount++;
        var entity = data.entity || {};
        var label = entity.title || entity.name || data.entityType || 'Entity';
        var domain = (entity.metadata && entity.metadata.domain) || entity.domain || '';
        var badge = domain || '';
        addNode(data.entityType || 'task', label, badge);
        // Estimate progress: each entity is worth ~(80/total) % of progress
        var pct = data.total > 0 ? Math.min(90, 2 + (data.index / data.total) * 88) : 50;
        setProgress(pct);
        countEl.style.display = 'block';
        countEl.textContent = entityCount + ' ' + (entityCount === 1 ? 'entity' : 'entities') + ' created';
        break;

      case 'entity.failed':
        // Don't show errors inline — let scaffold.error handle the fatal case
        break;

      case 'scaffold.complete':
        setProgress(100);
        pulse.classList.remove('pulse');
        pulse.classList.add('done');
        subtitle.textContent = entityCount + ' entities created';
        var liveLink = data.liveUrl || LIVE_URL;
        if (liveLink) {
          completeBannerText.innerHTML =
            'Initiative created &mdash; <a href="' + escapeAttr(liveLink) + '" target="_blank" rel="noopener">Open live view &rarr;</a>';
        } else {
          completeBannerText.textContent = 'Initiative created successfully.';
        }
        completeBanner.classList.add('show');
        try { es.close(); } catch(_) {}
        break;

      case 'scaffold.error':
        pulse.classList.add('error');
        subtitle.textContent = 'Failed';
        errorBanner.textContent = 'Error: ' + (data.error || 'Unknown error');
        errorBanner.classList.add('show');
        try { es.close(); } catch(_) {}
        break;
    }
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
