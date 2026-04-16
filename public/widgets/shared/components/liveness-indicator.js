/**
 * OrgX shared: breathing-dot liveness indicator.
 *
 * A 6px dot that "inhales" (expands) when new data lands and "exhales"
 * (shrinks) on idle. When the feed disconnects, the dot pauses and a
 * "last sync" label becomes visible. When healthy, no text is shown.
 *
 * Surveillance-grade UX: the user always knows if the widget is stale
 * without ever being told it's fine.
 *
 * Usage (classic script):
 *   <div data-liveness></div>
 *   const live = OrgxLiveness.attach(el, { onReconnect: ... });
 *   live.pulse();       // data landed
 *   live.disconnect();  // feed dropped
 *   live.reconnect();   // feed back
 */
(function (global) {
  'use strict';

  const STYLES_INJECTED = '__orgx_liveness_styles__';

  function ensureStyles() {
    if (document.getElementById(STYLES_INJECTED)) return;
    const style = document.createElement('style');
    style.id = STYLES_INJECTED;
    style.textContent = `
      .ox-liveness {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-family: var(--ox-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 0.62rem;
        color: var(--ox-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .ox-liveness__dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ox-primary);
        box-shadow: 0 0 6px rgba(var(--ox-primary-rgb), 0.55);
        animation: oxLivenessBreathe 2400ms ease-in-out infinite;
        flex-shrink: 0;
      }
      .ox-liveness.is-paused .ox-liveness__dot {
        animation: none;
        opacity: 0.35;
        background: var(--ox-text-muted);
        box-shadow: none;
      }
      .ox-liveness.is-pulsed .ox-liveness__dot {
        animation: oxLivenessPulse 360ms ease-out 1, oxLivenessBreathe 2400ms ease-in-out infinite 360ms;
      }
      .ox-liveness__label {
        display: none;
      }
      .ox-liveness.is-paused .ox-liveness__label {
        display: inline;
      }
      @keyframes oxLivenessBreathe {
        0%, 100% { transform: scale(1); opacity: 0.85; }
        50% { transform: scale(1.3); opacity: 1; }
      }
      @keyframes oxLivenessPulse {
        0% { transform: scale(1); }
        40% { transform: scale(1.7); }
        100% { transform: scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .ox-liveness__dot { animation: none !important; }
        .ox-liveness.is-pulsed .ox-liveness__dot { opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  function formatRelative(ts) {
    const delta = Math.max(0, Date.now() - ts);
    const sec = Math.round(delta / 1000);
    if (sec < 60) return sec + 's ago';
    const min = Math.round(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.round(min / 60);
    return hr + 'h ago';
  }

  function attach(hostEl, opts) {
    ensureStyles();
    const host = typeof hostEl === 'string' ? document.querySelector(hostEl) : hostEl;
    if (!host) throw new Error('OrgxLiveness.attach: host element not found');

    host.classList.add('ox-liveness');
    host.innerHTML = '<span class="ox-liveness__dot" aria-hidden="true"></span><span class="ox-liveness__label"></span>';
    const label = host.querySelector('.ox-liveness__label');

    let lastSync = Date.now();
    let pulseTimer = null;
    let labelTimer = null;

    function updateLabel() {
      if (host.classList.contains('is-paused')) {
        label.textContent = 'offline · last sync ' + formatRelative(lastSync);
      }
    }

    function pulse() {
      lastSync = Date.now();
      host.classList.remove('is-paused', 'is-pulsed');
      // reflow so the pulsed animation retriggers
      void host.offsetWidth;
      host.classList.add('is-pulsed');
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => host.classList.remove('is-pulsed'), 400);
    }

    function disconnect() {
      host.classList.add('is-paused');
      updateLabel();
      if (labelTimer) clearInterval(labelTimer);
      labelTimer = setInterval(updateLabel, 30_000);
    }

    function reconnect() {
      host.classList.remove('is-paused');
      if (labelTimer) { clearInterval(labelTimer); labelTimer = null; }
      if (opts && typeof opts.onReconnect === 'function') opts.onReconnect();
      pulse();
    }

    function destroy() {
      if (pulseTimer) clearTimeout(pulseTimer);
      if (labelTimer) clearInterval(labelTimer);
      host.classList.remove('ox-liveness', 'is-paused', 'is-pulsed');
      host.innerHTML = '';
    }

    return { pulse, disconnect, reconnect, destroy };
  }

  /**
   * Auto-mount when the widget is loaded with ?live=true in the URL
   * (or data-widget-live="true" on <html>). Finds the first element
   * matching the given selectors (or a default kicker target) and
   * attaches the breathing dot. No-op otherwise.
   *
   * @param {{ selectors?: string[], pollMs?: number, marker?: string }} [opts]
   */
  function autoMount(opts) {
    ensureStyles();
    const params = new URLSearchParams(
      (typeof window !== 'undefined' && window.location && window.location.search) || ''
    );
    const flagLive =
      params.get('live') === 'true' ||
      (typeof document !== 'undefined' &&
        document.documentElement &&
        document.documentElement.getAttribute('data-widget-live') === 'true');
    if (!flagLive) return null;

    const selectors = (opts && opts.selectors) || [
      '[data-live-mount]',
      '.widget-kicker',
      '.ox-eyebrow',
      '.widget-hero-copy',
    ];
    let host = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { host = el; break; }
    }
    if (!host) return null;

    const marker = (opts && opts.marker) || 'Live';
    const mount = document.createElement('span');
    mount.className = 'ox-liveness-autoMount';
    mount.setAttribute('data-live-auto', 'true');
    mount.style.marginLeft = '10px';
    mount.style.verticalAlign = 'middle';
    host.appendChild(mount);

    const wrap = document.createElement('span');
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';

    const dotHost = document.createElement('span');
    const label = document.createElement('span');
    label.textContent = marker;
    label.style.fontFamily = 'var(--ox-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
    label.style.fontSize = '0.58rem';
    label.style.fontWeight = '700';
    label.style.letterSpacing = '0.08em';
    label.style.textTransform = 'uppercase';
    label.style.color = 'var(--ox-text-muted)';

    wrap.appendChild(dotHost);
    wrap.appendChild(label);
    mount.appendChild(wrap);

    const live = attach(dotHost);
    // Demo cadence when no MCP host is present — pulse every N ms so
    // the indicator visibly breathes against real traffic in dev.
    const pollMs = (opts && opts.pollMs) || 4500;
    if (typeof window !== 'undefined' && !window.openai) {
      setTimeout(() => live.pulse(), 120);
      setInterval(() => live.pulse(), pollMs);
    } else {
      live.pulse();
    }
    return live;
  }

  const api = Object.freeze({ attach, autoMount });
  if (typeof global !== 'undefined') global.OrgxLiveness = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // Run autoMount on DOMContentLoaded so any widget that loads this
  // script automatically opts into the ?live=true flow.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => autoMount());
    } else {
      setTimeout(() => autoMount(), 0);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
