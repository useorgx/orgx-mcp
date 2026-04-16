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

  const api = Object.freeze({ attach });
  if (typeof global !== 'undefined') global.OrgxLiveness = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
