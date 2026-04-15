/**
 * scaffoldWidget.ts — self-contained HTML widget for real-time scaffold streaming.
 *
 * Matches the production scaffolded-initiative.html visual language:
 *  - Dark-first design with teal primary
 *  - Card-based workstream layout (not flat dot-list)
 *  - Domain-colored card accents
 *  - WS count badges, milestone type icons, status pills
 *  - Agent avatar placeholders
 *  - WORK BREAKDOWN STRUCTURE section header
 *  - SYNCED footer with Open Live View link
 *  - Skeleton shimmer while connecting
 *  - Celebration state on scaffold.complete
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
  const title = initiativeTitle ? escapeHtml(initiativeTitle) : 'Building initiative…';
  const safeLiveUrl = liveUrl ? escapeHtml(liveUrl) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── OrgX Token System ─────────────────────────────────── */
:root{
  /* dark-first (widget lives in Claude dark UI) */
  --ox-bg:#02040a;
  --ox-panel:rgba(8,12,20,.96);
  --ox-card:rgba(14,19,30,.9);
  --ox-border:rgba(255,255,255,.07);
  --ox-border-strong:rgba(255,255,255,.14);
  --ox-text:#f2f7ff;
  --ox-text-muted:rgba(255,255,255,.46);
  --ox-text-sub:rgba(255,255,255,.28);
  --ox-well:rgba(0,0,0,.3);
  --ox-shadow:0 28px 56px -24px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.04);
  --ox-primary:#00c9a7;--ox-primary-rgb:0,201,167;
  --ox-success:#22c55e;--ox-success-rgb:34,197,94;
  --ox-danger:#f43f5e;
  --ox-warn:#fbbf24;--ox-warn-rgb:251,191,36;
  --ox-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;
  --ox-font:-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;
  --ox-grid:rgba(255,255,255,.02);
  /* domain rgb palette */
  --rgb-engineering:6,182,212;
  --rgb-product:22,163,74;
  --rgb-marketing:249,115,22;
  --rgb-design:236,72,153;
  --rgb-sales:168,85,247;
  --rgb-operations:245,158,11;
  --rgb-ops:245,158,11;
  --rgb-orchestration:0,201,167;
  --rgb-default:99,102,241;
}
/* light-mode override for when widget renders outside Claude */
@media(prefers-color-scheme:light){
  :root{
    --ox-bg:#f1f5f9;
    --ox-panel:#fff;
    --ox-card:#f8fafc;
    --ox-border:rgba(0,0,0,.07);
    --ox-border-strong:rgba(0,0,0,.14);
    --ox-text:#0f172a;
    --ox-text-muted:#64748b;
    --ox-text-sub:#94a3b8;
    --ox-well:#f1f5f9;
    --ox-shadow:0 12px 32px -12px rgba(0,0,0,.1),0 2px 6px rgba(0,0,0,.04);
    --ox-grid:rgba(0,0,0,.04);
  }
}

html,body{
  background:var(--ox-bg);color:var(--ox-text);
  font-family:var(--ox-font);font-size:13px;line-height:1.5;min-height:100%;
}
body{padding:14px 14px 20px;max-width:580px;margin:0 auto}

/* ── Shell (main card) ─────────────────────────────────── */
.shell{
  border-radius:18px;overflow:hidden;
  border:1px solid rgba(var(--ox-primary-rgb),.12);
  background:linear-gradient(180deg,rgba(var(--ox-primary-rgb),.05),transparent 40%),var(--ox-panel);
  box-shadow:var(--ox-shadow);
  position:relative;
}
/* Top shine line */
.shell::after{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(var(--ox-primary-rgb),.55),transparent);
  pointer-events:none;
}

/* ── Initiative Hero ───────────────────────────────────── */
.hero{padding:18px 20px 14px}
.eyebrow{
  display:flex;align-items:center;gap:7px;
  font-family:var(--ox-mono);font-size:.56rem;font-weight:700;
  letter-spacing:.16em;text-transform:uppercase;color:var(--ox-text-muted);
  margin-bottom:10px;
}
.live-dot{
  width:7px;height:7px;border-radius:50%;flex-shrink:0;
  background:var(--ox-primary);
  box-shadow:0 0 14px rgba(var(--ox-primary-rgb),.55);
  animation:ldot 2.2s ease-in-out infinite;
}
.live-dot.done{animation:none;background:var(--ox-success);box-shadow:0 0 10px rgba(var(--ox-success-rgb),.5)}
.live-dot.error{animation:none;background:var(--ox-danger);box-shadow:none}
@keyframes ldot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.68)}}

.hero-title{
  font-size:clamp(15px,3.5vw,20px);font-weight:700;
  letter-spacing:-.03em;color:var(--ox-text);line-height:1.2;
  word-break:break-word;
}
.hero-meta{
  display:flex;align-items:center;gap:8px;
  margin-top:10px;flex-wrap:wrap;
}
.status-pill{
  display:inline-flex;align-items:center;gap:6px;
  padding:4px 12px;border-radius:999px;
  font-family:var(--ox-mono);font-size:.6rem;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;
  border:1px solid rgba(var(--ox-primary-rgb),.22);
  background:rgba(var(--ox-primary-rgb),.1);
  color:var(--ox-primary);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
}
.status-pill.done{
  border-color:rgba(var(--ox-success-rgb),.22);
  background:rgba(var(--ox-success-rgb),.1);
  color:var(--ox-success);
}
.s-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.status-pill:not(.done) .s-dot{animation:sdot .8s ease-in-out infinite;box-shadow:0 0 5px currentColor}
@keyframes sdot{0%,100%{opacity:1}50%{opacity:.3}}

/* Progress bar */
.prog-wrap{
  height:2px;background:rgba(255,255,255,.06);border-radius:2px;
  margin-top:12px;overflow:hidden;
}
@media(prefers-color-scheme:light){.prog-wrap{background:rgba(0,0,0,.08)}}
.prog-fill{
  height:100%;background:var(--ox-primary);border-radius:2px;width:0%;
  transition:width .5s cubic-bezier(.4,0,.2,1);
  box-shadow:0 0 8px rgba(var(--ox-primary-rgb),.5);
}

/* ── WBS Section ───────────────────────────────────────── */
.wbs-wrap{border-top:1px solid var(--ox-border)}
.wbs-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 20px;
}
.wbs-label{
  font-family:var(--ox-mono);font-size:.54rem;font-weight:700;
  letter-spacing:.16em;text-transform:uppercase;color:var(--ox-text-sub);
}
.wbs-count{
  font-family:var(--ox-mono);font-size:.6rem;font-weight:600;
  color:var(--ox-text-muted);letter-spacing:.04em;
}

/* ── Skeleton ──────────────────────────────────────────── */
.skeleton{display:flex;flex-direction:column;gap:8px;padding:12px 16px 14px}
.sk-card{
  height:72px;border-radius:10px;
  background:linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.08) 50%,rgba(255,255,255,.04) 75%);
  background-size:200% 100%;animation:shimmer 1.5s ease infinite;
}
@media(prefers-color-scheme:light){
  .sk-card{background:linear-gradient(90deg,rgba(0,0,0,.05) 25%,rgba(0,0,0,.09) 50%,rgba(0,0,0,.05) 75%);background-size:200% 100%}
}
.sk-card:nth-child(2){opacity:.7}
.sk-card:nth-child(3){opacity:.5}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── Workstream Stack ──────────────────────────────────── */
.ws-stack{
  display:flex;flex-direction:column;gap:8px;
  padding:10px 14px 14px;
}

/* ── Workstream Card ───────────────────────────────────── */
.ws-card{
  border-radius:12px;overflow:hidden;
  border:1px solid var(--ox-border);
  background:var(--ox-card);
  position:relative; /* needed for scan-line pseudo */
  opacity:0;transform:translateY(10px);
  transition:opacity .3s cubic-bezier(.16,1,.3,1),
             transform .3s cubic-bezier(.16,1,.3,1),
             border-color .3s ease,
             box-shadow .4s ease;
}
.ws-card.show{opacity:1;transform:translateY(0)}

/* Active-receive: domain-colored glow + accent pulse */
.ws-card.active-receive{
  border-color:rgba(var(--ws-rgb,var(--ox-primary-rgb)),.28);
  box-shadow:
    0 0 0 1px rgba(var(--ws-rgb,var(--ox-primary-rgb)),.06) inset,
    0 8px 28px -8px rgba(var(--ws-rgb,var(--ox-primary-rgb)),.14),
    0 16px 40px -20px rgba(0,0,0,.5);
}
/* Animated scan-line sweep across the active card */
.ws-card.active-receive::before{
  content:'';position:absolute;
  left:0;right:0;height:50%;
  background:linear-gradient(180deg,rgba(var(--ws-rgb,var(--ox-primary-rgb)),.07),transparent);
  animation:scan-sweep 1.6s ease-in-out infinite;
  pointer-events:none;z-index:0;
}
@keyframes scan-sweep{
  0%{top:-50%;opacity:1}
  70%{opacity:.5}
  100%{top:110%;opacity:0}
}
/* Pulse the domain-colored accent while receiving */
.ws-card.active-receive .ws-card-accent{
  animation:accent-pulse 1.2s ease-in-out infinite;
}
@keyframes accent-pulse{0%,100%{opacity:1}50%{opacity:.38}}

/* Domain-colored top accent bar */
.ws-card-accent{
  height:2px;
  background:linear-gradient(90deg,rgb(var(--ws-rgb,var(--ox-primary-rgb))),transparent 70%);
  position:relative;z-index:1;
}

/* Card header row */
.ws-head{
  display:flex;align-items:center;gap:7px;
  padding:9px 12px 8px;position:relative;z-index:1;
}
.ws-num{
  font-family:var(--ox-mono);font-size:.58rem;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;
  padding:2px 7px;border-radius:999px;
  background:rgba(var(--ws-rgb,var(--ox-primary-rgb)),.12);
  border:1px solid rgba(var(--ws-rgb,var(--ox-primary-rgb)),.22);
  color:rgb(var(--ws-rgb,var(--ox-primary-rgb)));
  flex-shrink:0;white-space:nowrap;
}
.ws-title{
  flex:1;min-width:0;
  font-size:12px;font-weight:600;color:var(--ox-text);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.ws-domain{
  font-family:var(--ox-mono);font-size:.54rem;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;
  color:var(--ox-text-sub);flex-shrink:0;white-space:nowrap;
}

/* Divider below card header */
.ws-body{border-top:1px solid var(--ox-border)}

/* ── Milestone Rows ────────────────────────────────────── */
.ms-row{
  display:flex;align-items:flex-start;gap:8px;
  padding:7px 12px;
  border-bottom:1px solid rgba(255,255,255,.03);
  opacity:0;transform:translateX(-6px);
  transition:opacity .2s ease,transform .2s ease;
}
.ms-row.show{opacity:1;transform:translateX(0)}
@media(prefers-color-scheme:light){.ms-row{border-bottom-color:rgba(0,0,0,.04)}}
.ms-icon{
  width:18px;height:18px;border-radius:5px;flex-shrink:0;margin-top:1px;
  display:inline-flex;align-items:center;justify-content:center;
  font-family:var(--ox-mono);font-size:.58rem;font-weight:800;letter-spacing:0;
  background:rgba(var(--ox-warn-rgb),.14);
  border:1px solid rgba(var(--ox-warn-rgb),.24);
  color:var(--ox-warn);
  box-shadow:0 2px 6px -2px rgba(var(--ox-warn-rgb),.3);
}
.ms-title{flex:1;min-width:0;font-size:11.5px;font-weight:500;color:var(--ox-text);line-height:1.4}

/* ── Task Rows ─────────────────────────────────────────── */
.task-row{
  display:flex;align-items:center;gap:7px;
  padding:5px 12px 5px 20px;
  opacity:0;transform:translateX(-4px);
  transition:opacity .18s ease,transform .18s ease;
}
.task-row.show{opacity:1;transform:translateX(0)}
.task-dot{
  width:6px;height:6px;border-radius:50%;flex-shrink:0;
  background:rgba(255,255,255,.22);
  border:1px solid rgba(255,255,255,.1);
}
@media(prefers-color-scheme:light){.task-dot{background:rgba(0,0,0,.18);border-color:rgba(0,0,0,.08)}}
.task-title{flex:1;min-width:0;font-size:11px;color:var(--ox-text-muted);line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Completion Banner ─────────────────────────────────── */
.banner{
  display:none;margin:0 14px 12px;padding:12px 14px;border-radius:10px;
  background:linear-gradient(135deg,rgba(var(--ox-primary-rgb),.1),rgba(var(--ox-primary-rgb),.04));
  border:1px solid rgba(var(--ox-primary-rgb),.22);
  position:relative;overflow:hidden;
}
.banner::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(var(--ox-primary-rgb),.6),transparent);
}
.banner.show{display:flex;align-items:flex-start;gap:10px;animation:bpop .35s cubic-bezier(.16,1,.3,1)}
@keyframes bpop{0%{opacity:0;transform:translateY(6px) scale(.98)}100%{opacity:1;transform:none}}
.banner-icon{flex-shrink:0;color:var(--ox-primary);margin-top:1px}
.banner-body{flex:1;min-width:0}
.banner-title{display:block;font-weight:700;font-size:12px;color:var(--ox-text);margin-bottom:3px}
.banner-link{
  color:var(--ox-primary);text-decoration:none;font-size:11px;font-family:var(--ox-mono);
  letter-spacing:.02em;display:inline-flex;align-items:center;gap:3px;
}
.banner-link:hover{text-decoration:underline}

/* ── Footer ────────────────────────────────────────────── */
.foot{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 20px 14px;
  border-top:1px solid var(--ox-border);
  flex-wrap:wrap;gap:8px;
  margin-top:2px;
}
.foot-meta{
  font-family:var(--ox-mono);font-size:.58rem;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;color:var(--ox-text-sub);
}
.foot-link{
  font-family:var(--ox-mono);font-size:.62rem;font-weight:600;
  letter-spacing:.03em;color:var(--ox-primary);text-decoration:none;
  display:inline-flex;align-items:center;gap:4px;
  padding:5px 11px;border-radius:7px;
  border:1px solid rgba(var(--ox-primary-rgb),.22);
  background:rgba(var(--ox-primary-rgb),.07);
  transition:background .15s,border-color .15s;white-space:nowrap;
}
.foot-link:hover{background:rgba(var(--ox-primary-rgb),.14);border-color:rgba(var(--ox-primary-rgb),.32)}

/* ── Error state ───────────────────────────────────────── */
.err-banner{
  display:none;margin:0 14px 12px;padding:10px 14px;border-radius:8px;
  background:rgba(244,63,94,.06);border:1px solid rgba(244,63,94,.2);
  font-size:11px;color:#fb7185;line-height:1.4;font-family:var(--ox-mono);
}
.err-banner.show{display:block}

/* ── Item flash: teal glow on arrival ─────────────────── */
@keyframes item-appear{
  0%  {background:rgba(var(--ox-primary-rgb),.09);
       box-shadow:inset 3px 0 0 rgba(var(--ox-primary-rgb),.55)}
  100%{background:transparent;box-shadow:none}
}
.ms-row.flash,.task-row.flash{animation:item-appear .65s ease-out}

/* ── Shell: subtle border pulse while streaming ────────── */
@keyframes stream-pulse{
  0%,100%{border-color:rgba(var(--ox-primary-rgb),.12)}
  50%    {border-color:rgba(var(--ox-primary-rgb),.28)}
}
.shell.streaming{animation:stream-pulse 2.4s ease-in-out infinite}

/* ── Shell done celebration ────────────────────────────── */
@keyframes done-pulse{
  0%  {border-color:rgba(var(--ox-primary-rgb),.12);
       box-shadow:var(--ox-shadow)}
  35% {border-color:rgba(var(--ox-success-rgb),.5);
       box-shadow:var(--ox-shadow),
                  0 0 0 2px rgba(var(--ox-success-rgb),.1),
                  0 0 56px -8px rgba(var(--ox-success-rgb),.22)}
  100%{border-color:rgba(var(--ox-success-rgb),.22);
       box-shadow:var(--ox-shadow),
                  0 0 0 1px rgba(var(--ox-success-rgb),.05)}
}
.shell.done{animation:done-pulse 1.5s cubic-bezier(.16,1,.3,1) forwards}
</style>
</head>
<body>
<div class="shell">

  <!-- Initiative hero -->
  <div class="hero">
    <div class="eyebrow">
      <div class="live-dot" id="ldot"></div>
      <span id="etext">INITIATIVE SCAFFOLDED</span>
    </div>
    <div class="hero-title" id="heroTitle">${title}</div>
    <div class="hero-meta">
      <span class="status-pill" id="statusPill">
        <span class="s-dot"></span>
        <span id="statusText">BUILDING…</span>
      </span>
    </div>
    <div class="prog-wrap"><div class="prog-fill" id="prog"></div></div>
  </div>

  <!-- WBS section -->
  <div class="wbs-wrap">
    <div class="wbs-header">
      <span class="wbs-label">WORK BREAKDOWN STRUCTURE</span>
      <span class="wbs-count" id="wbsCount"></span>
    </div>

    <!-- Skeleton (while connecting) -->
    <div class="skeleton" id="skeleton">
      <div class="sk-card"></div>
      <div class="sk-card"></div>
      <div class="sk-card"></div>
    </div>

    <!-- Live workstream cards -->
    <div class="ws-stack" id="wsStack" style="display:none"></div>
  </div>

  <!-- Completion banner -->
  <div class="banner" id="banner">
    <svg class="banner-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/>
      <path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="banner-body">
      <strong class="banner-title" id="bannerTitle">Initiative created</strong>
      <span id="bannerSub"></span>
    </div>
  </div>

  <div class="err-banner" id="errBanner"></div>

  <!-- Footer -->
  <div class="foot">
    <span class="foot-meta" id="footMeta">SYNCING…</span>
    ${safeLiveUrl
      ? `<a class="foot-link" href="${safeLiveUrl}" target="_blank" rel="noopener">Open Live View ↗</a>`
      : '<span id="footLinkSlot"></span>'}
  </div>
</div>

<script>
(function(){
  var SESSION_ID = ${JSON.stringify(sessionId)};
  var STREAM_URL = ${JSON.stringify(streamUrl)};
  var LIVE_URL   = ${JSON.stringify(liveUrl ?? '')};

  /* ── DOM refs ── */
  var shell      = document.querySelector('.shell');
  var ldot       = document.getElementById('ldot');
  var etext      = document.getElementById('etext');
  var heroTitle  = document.getElementById('heroTitle');
  var statusPill = document.getElementById('statusPill');
  var statusText = document.getElementById('statusText');
  var prog       = document.getElementById('prog');
  var wbsCount   = document.getElementById('wbsCount');
  var skeleton   = document.getElementById('skeleton');
  var wsStack    = document.getElementById('wsStack');
  var banner     = document.getElementById('banner');
  var bannerTitle = document.getElementById('bannerTitle');
  var bannerSub  = document.getElementById('bannerSub');
  var errBanner  = document.getElementById('errBanner');
  var footMeta   = document.getElementById('footMeta');
  var footLinkSlot = document.getElementById('footLinkSlot');

  /* ── State ── */
  var entityCount   = 0;
  var totalExpected = 0;
  var wsCount       = 0;   /* workstream counter (WS 1, WS 2…) */
  var isDone        = false;
  var lastEventTs   = 0;
  var retryDelay    = 1000;
  var es            = null;

  /* Current workstream card + its body element */
  var curWsCard   = null; /* the .ws-card element currently receiving entities */
  var curWsBody   = null; /* its .ws-body element */
  var curMsRow    = null; /* last milestone row (unused for now but kept for future indent) */

  /* Domain → CSS rgb variable name */
  var DOMAIN_RGB = {
    engineering: '6,182,212',
    product:     '22,163,74',
    marketing:   '249,115,22',
    design:      '236,72,153',
    sales:       '168,85,247',
    operations:  '245,158,11',
    ops:         '245,158,11',
    orchestration:'0,201,167',
  };

  function domainRgb(d) {
    return DOMAIN_RGB[(d||'').toLowerCase()] || '0,201,167';
  }

  /* ── Helpers ── */
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function setProgress(pct) {
    prog.style.width = Math.min(100, Math.round(pct)) + '%';
  }
  function showStack() {
    skeleton.style.display = 'none';
    wsStack.style.display = 'flex';
  }
  function resetAll() {
    wsStack.innerHTML = '';
    entityCount = 0;
    totalExpected = 0;
    wsCount = 0;
    curWsCard = null;
    curWsBody = null;
    curMsRow = null;
    wbsCount.textContent = '';
    setProgress(2);
    showStack();
    if (shell) { shell.classList.remove('streaming'); shell.classList.remove('done'); }
  }
  function animateIn(el) {
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { el.classList.add('show'); });
    });
  }
  function flashItem(el) {
    /* Brief teal glow + left-edge stripe on new rows */
    el.classList.add('flash');
    el.addEventListener('animationend', function() {
      el.classList.remove('flash');
    }, { once: true });
  }

  /* ── Entity builders ── */
  function addInitiative(entity) {
    heroTitle.textContent = entity.title || entity.name || 'Initiative';
  }

  function addWorkstream(entity) {
    wsCount++;
    var domain = ((entity.metadata && (entity.metadata.domain || entity.metadata.agent_domain)) || entity.domain || '').toLowerCase();
    var rgb    = domainRgb(domain);
    var label  = entity.title || entity.name || 'Workstream';

    var card = document.createElement('div');
    card.className = 'ws-card';
    card.style.cssText = '--ws-rgb:' + rgb;

    /* Top accent bar */
    var accent = document.createElement('div');
    accent.className = 'ws-card-accent';
    card.appendChild(accent);

    /* Header */
    var head = document.createElement('div');
    head.className = 'ws-head';
    head.innerHTML =
      '<span class="ws-num">WS ' + wsCount + '</span>' +
      '<span class="ws-title">' + esc(label) + '</span>' +
      (domain ? '<span class="ws-domain">' + esc(domain.toUpperCase()) + '</span>' : '');
    card.appendChild(head);

    /* Body (milestones + tasks will go here) */
    var body = document.createElement('div');
    body.className = 'ws-body';
    card.appendChild(body);

    /* Remove receive-pulse from previous card */
    if (curWsCard) curWsCard.classList.remove('active-receive');

    wsStack.appendChild(card);
    animateIn(card);
    card.classList.add('active-receive');

    curWsCard = card;
    curWsBody = body;
    curMsRow  = null;
  }

  function addMilestone(entity) {
    var label = entity.title || entity.name || 'Milestone';
    var target = curWsBody || wsStack;

    var row = document.createElement('div');
    row.className = 'ms-row';
    row.innerHTML =
      '<span class="ms-icon">M</span>' +
      '<span class="ms-title">' + esc(label) + '</span>';

    target.appendChild(row);
    animateIn(row);
    setTimeout(function() { flashItem(row); }, 60);
    curMsRow = row;
  }

  function addTask(entity) {
    var label  = entity.title || entity.name || 'Task';
    var target = curWsBody || wsStack;

    var row = document.createElement('div');
    row.className = 'task-row';
    row.innerHTML =
      '<span class="task-dot"></span>' +
      '<span class="task-title">' + esc(label) + '</span>';

    target.appendChild(row);
    animateIn(row);
    setTimeout(function() { flashItem(row); }, 60);
  }

  function addEntity(entityType, entity) {
    switch (entityType) {
      case 'initiative':  addInitiative(entity); break;
      case 'workstream':  addWorkstream(entity); break;
      case 'milestone':   addMilestone(entity);  break;
      case 'task':
      default:            addTask(entity);        break;
    }
  }

  /* ── Event handlers ── */
  function onSessionStart(data) {
    if (data.title) heroTitle.textContent = data.title;
    etext.textContent = 'INITIATIVE SCAFFOLDED';
    statusText.textContent = 'BUILDING…';
    statusPill.classList.remove('done');
    resetAll();
    ldot.className = 'live-dot';
  }

  function onEntityCreated(data) {
    entityCount++;
    totalExpected = data.total || totalExpected;
    /* Start shell pulse on very first entity */
    if (entityCount === 1 && shell) shell.classList.add('streaming');
    addEntity(data.entityType || 'task', data.entity || {});
    var pct = totalExpected > 0 ? 5 + (entityCount / totalExpected) * 85 : 50;
    setProgress(pct);
    wbsCount.textContent = entityCount + ' / ' + (totalExpected || '?');
  }

  function onComplete(data) {
    isDone = true;
    setProgress(100);
    if (curWsCard) curWsCard.classList.remove('active-receive');
    /* Shell celebration: swap streaming pulse for success glow */
    if (shell) { shell.classList.remove('streaming'); shell.classList.add('done'); }
    ldot.className = 'live-dot done';
    etext.textContent = 'INITIATIVE SCAFFOLDED';
    var total = data.totalEntities || entityCount;
    statusText.textContent = total + ' ENTITIES';
    statusPill.classList.add('done');
    wbsCount.textContent = total + ' / ' + total;
    footMeta.textContent = 'SYNCED';

    bannerTitle.textContent = total + ' entities created successfully';
    var liveLink = data.liveUrl || LIVE_URL;
    if (liveLink) {
      bannerSub.innerHTML = '<a class="banner-link" href="' + esc(liveLink) + '" target="_blank" rel="noopener">Open live view ↗</a>';
    }
    banner.classList.add('show');

    /* Inject footer link if not already hardcoded */
    if (footLinkSlot && liveLink) {
      var a = document.createElement('a');
      a.className = 'foot-link';
      a.href = liveLink;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open Live View ↗';
      footLinkSlot.replaceWith(a);
      footLinkSlot = null;
    }

    if (es) { try { es.close(); } catch(_){} }
  }

  function onError(data) {
    ldot.className = 'live-dot error';
    statusText.textContent = 'ERROR';
    errBanner.textContent = 'Error: ' + (data.error || 'scaffold failed');
    errBanner.classList.add('show');
    if (es) { try { es.close(); } catch(_){} }
  }

  function handleEvent(data) {
    if (data.ts) lastEventTs = data.ts;
    switch (data.type) {
      case 'session.start':     return onSessionStart(data);
      case 'entity.created':    return onEntityCreated(data);
      case 'scaffold.complete': return onComplete(data);
      case 'scaffold.error':    return onError(data);
    }
  }

  /* ── SSE with exponential backoff ── */
  function connect() {
    if (isDone) return;
    if (es) { try { es.close(); } catch(_){} }
    var url = STREAM_URL + (lastEventTs ? '?since=' + lastEventTs : '');

    if (entityCount === 0) {
      skeleton.style.display = 'flex';
      wsStack.style.display = 'none';
      statusText.textContent = 'CONNECTING…';
    } else {
      statusText.textContent = 'RECONNECTING…';
    }

    es = new EventSource(url);

    es.onopen = function() {
      ldot.className = 'live-dot';
      statusText.textContent = entityCount > 0 ? 'RESUMING…' : 'BUILDING…';
      footMeta.textContent = 'LIVE';
      retryDelay = 1000;
    };

    es.onmessage = function(ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch(_) { return; }
      handleEvent(data);
    };

    es.onerror = function() {
      if (isDone) return;
      try { es.close(); } catch(_) {}
      var wait = Math.round(retryDelay / 1000);
      statusText.textContent = 'PAUSED ' + wait + 's…';
      footMeta.textContent = 'RECONNECTING…';
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
