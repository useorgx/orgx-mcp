(function(f){"use strict";const p="__orgx_liveness_styles__";function x(){if(document.getElementById(p))return;const n=document.createElement("style");n.id=p,n.textContent=`
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
    `,document.head.appendChild(n)}function h(n){const r=Math.max(0,Date.now()-n),e=Math.round(r/1e3);if(e<60)return e+"s ago";const a=Math.round(e/60);if(a<60)return a+"m ago";if(window.OrgXTime)return window.OrgXTime.relative(n,{inline:!0});const o=Math.round(a/60);return o<24?o+"h ago":Math.round(o/24)+"d ago"}function v(n,r){x();const e=typeof n=="string"?document.querySelector(n):n;if(!e)throw new Error("OrgxLiveness.attach: host element not found");e.classList.add("ox-liveness"),e.innerHTML='<span class="ox-liveness__dot" aria-hidden="true"></span><span class="ox-liveness__label"></span>';const a=e.querySelector(".ox-liveness__label");let o=Date.now(),l=null,t=null;function i(){e.classList.contains("is-paused")&&(a.textContent="offline · last sync "+h(o))}function c(){o=Date.now(),e.classList.remove("is-paused","is-pulsed"),e.offsetWidth,e.classList.add("is-pulsed"),l&&clearTimeout(l),l=setTimeout(()=>e.classList.remove("is-pulsed"),400)}function s(){e.classList.add("is-paused"),i(),t&&clearInterval(t),t=setInterval(i,3e4)}function d(){e.classList.remove("is-paused"),t&&(clearInterval(t),t=null),r&&typeof r.onReconnect=="function"&&r.onReconnect(),c()}function m(){l&&clearTimeout(l),t&&clearInterval(t),e.classList.remove("ox-liveness","is-paused","is-pulsed"),e.innerHTML=""}return{pulse:c,disconnect:s,reconnect:d,destroy:m}}function u(n){if(x(),!(new URLSearchParams(typeof window<"u"&&window.location&&window.location.search||"").get("live")==="true"||typeof document<"u"&&document.documentElement&&document.documentElement.getAttribute("data-widget-live")==="true"))return null;const a=n&&n.selectors||["[data-live-mount]",".widget-kicker",".ox-eyebrow",".widget-hero-copy"];let o=null;for(const w of a){const g=document.querySelector(w);if(g){o=g;break}}if(!o)return null;const l=n&&n.marker||"Live",t=document.createElement("span");t.className="ox-liveness-autoMount",t.setAttribute("data-live-auto","true"),t.style.marginLeft="10px",t.style.verticalAlign="middle",o.appendChild(t);const i=document.createElement("span");i.style.display="inline-flex",i.style.alignItems="center",i.style.gap="6px";const c=document.createElement("span"),s=document.createElement("span");s.textContent=l,s.style.fontFamily="var(--ox-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",s.style.fontSize="0.58rem",s.style.fontWeight="700",s.style.letterSpacing="0.08em",s.style.textTransform="uppercase",s.style.color="var(--ox-text-muted)",i.appendChild(c),i.appendChild(s),t.appendChild(i);const d=v(c),m=n&&n.pollMs||4500;return typeof window<"u"&&!window.openai?(setTimeout(()=>d.pulse(),120),setInterval(()=>d.pulse(),m)):d.pulse(),d}const y=Object.freeze({attach:v,autoMount:u});typeof f<"u"&&(f.OrgxLiveness=y),typeof module<"u"&&module.exports&&(module.exports=y),typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>u()):setTimeout(()=>u(),0))})(typeof window<"u"?window:globalThis);
