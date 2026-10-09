/**
 * OrgX panel first-use tour.
 *
 * Six numbered steps over the person's own panel: the spotlight moves across
 * real controls (switching tabs underneath), each step leads with what they
 * get, then one way to get more from it, with a small looping visual built
 * from panel pieces. The overlay lives on <body> so panel re-renders never
 * remove it. Step 2's press is a practice: the controller routes it here and
 * nothing is sent.
 *
 *   var tour = OrgXPanelTour.create({ root, go, onEnd, announce });
 *   tour.start(); tour.refresh(); tour.active(); tour.practice(footerEl);
 *   OrgXPanelTour.seen() / .markSeen()
 *
 * Phone (under 760px): the card is a sheet on the side away from the
 * target, the target's own pane scrolls into the open area (never the
 * frame), swipe moves between steps, buttons stay 44px.
 */
(function attachPanelTour(global) {
  'use strict';
  if (global.OrgXPanelTour) return;
  /** Host-aware copy: {host}, {Host}, {assistant}, {settings} name the app the panel is inside. */
  function fill(text) { var H = global.OrgXPanelHost; return H ? H.fill(text) : String(text).replace(/\{(?:host|chat)\}/g, 'the chat').replace(/\{(?:Host|Chat)\}/g, 'The assistant').replace(/\{assistant\}/g, 'the assistant').replace(/\{settings\}/g, 'the app’s settings'); }

  var KEY = 'orgx.panel.tour.v1';
  var seenInMemory = false;

  function seen() {
    try { if (global.localStorage && global.localStorage.getItem(KEY) === 'done') return true; } catch (_) { /* memory only */ }
    return seenInMemory;
  }
  function markSeen() {
    seenInMemory = true;
    try { if (global.localStorage) global.localStorage.setItem(KEY, 'done'); } catch (_) { /* memory only */ }
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function map(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function mark(size) { return global.OrgXPanelBrand ? global.OrgXPanelBrand.mark(size, 'pn-v-logo') : ''; }
  function av(agent) {
    var identity = global.OrgXAgentIdentity;
    return identity && identity.avatar ? identity.avatar({ agent: agent, name: agent, size: 'inline' }) : '';
  }

  var VIS = {
    welcome: function () {
      return '<div class="pn-v-orbit"><span class="pn-v-ring"></span>' + mark(44) + '<div class="pn-v-sats">' +
        ['xandy', 'eli', 'pace', 'dana'].map(function sat(k, i) { return '<span class="pn-v-sat" style="--a:' + (i * 90 + 20) + 'deg"><span>' + av(k) + '</span></span>'; }).join('') + '</div></div>';
    },
    queue: function () {
      return '<div class="pn-v-q"><div class="r a">' + av('eli') + '<i></i><b></b></div><div class="r b">' + av('orion') + '<i></i><b></b></div><div class="r red">' + av('xandy') + '<i></i><b></b></div></div>';
    },
    decide: function () {
      return '<div class="pn-v-net"><span class="lab">Decide here</span><span class="pill">Approve</span><span class="undo"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--ox-ring-track)" stroke-width="2"/><circle class="arc" cx="8" cy="8" r="6" fill="none" stroke="var(--ox-warning)" stroke-width="2" stroke-linecap="round"/></svg>Undo</span><span class="tap"></span></div>';
    },
    ask: function () {
      return '<div class="pn-v-read"><div class="card"><i></i><i></i><i></i><i></i></div><span class="link"></span><div class="bub"><span></span><span></span><span></span><em class="lock">You decide</em></div></div>';
    },
    work: function () {
      return '<div class="pn-v-lanes"><div class="ln"><small>Blocked</small>' + ['pace', 'dana', 'eli', 'orion'].map(function ag(k, i) {
        return '<span class="ag" style="--i:' + i + '">' + av(k) + '<i></i></span>';
      }).join('') + '</div><div class="ln run"><small>Running</small></div></div>';
    },
    done: function () {
      return '<div class="pn-v-rc"><div class="seg4">' + [0, 1, 2, 3].map(function s(i) { return '<i style="--i:' + i + '"></i>'; }).join('') + '</div><div class="lines"><i></i><i></i></div><span class="seal">✓</span></div>';
    },
    launch: function () {
      return '<div class="pn-v-ping"><span class="bell"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg></span><span class="msg">' + av('xandy') + '<span><b>Plan ready</b> · 3 agents queued</span></span></div>';
    },
    ready: function () {
      return '<div class="pn-v-ready">' + mark(52) + '<span class="ck">✓</span>' +
        [['18px', '14px', '#facc15', '0s'], ['92px', '10px', '#4ade80', '.5s'], ['100px', '62px', '#14b8a6', '1s'], ['12px', '64px', 'var(--ox-primary)', '1.4s']].map(function sp(p) {
          return '<span class="sp" style="left:' + p[0] + ';top:' + p[1] + ';--c:' + p[2] + ';--d:' + p[3] + '"></span>';
        }).join('') + '</div>';
    },
  };

  var STEPS = [
    { id: 'welcome', tab: 'needs', vis: 'welcome', eyebrow: 'Welcome to OrgX', next: 'Show me',
      title: 'Decide agent work without leaving {host}',
      body: 'OrgX keeps your agents’ decisions, progress and proof in one place. This panel brings the part that needs you into {host}, so work doesn’t wait on you.',
      tip: 'Six short steps, about a minute. It uses your own workspace, and nothing you press during the tour is sent.' },
    { id: 'queue', tab: 'needs', vis: 'queue', target: ['ox-attention-line', '.pn-list .row', '.queue .row'],
      title: 'See what needs you, ranked by what it holds up',
      body: 'Red means work is stopped until you answer. Decisions are sorted by urgency, then by what they block, then by age.',
      tip: 'Clear the red ones first. Agents keep working on everything else.' },
    { id: 'decide', tab: 'needs', vis: 'decide', target: ['.pn-detail .actions', '.packet .actions'], practice: true,
      title: 'Decide in one press, recorded under your name',
      body: 'Approve or send back right here. OrgX records it on the decision with your name, and the agent continues or reworks it.',
      try: 'Press the main button now. During the tour nothing is sent.', tryOk: 'That’s the step you’ll see. Nothing was sent.',
      tip: 'When OrgX needs more than a click, like a credential, the button opens the decision in OrgX instead.' },
    { id: 'ask', tab: 'needs', vis: 'ask', target: ['.pn-asks'],
      title: 'Let {assistant} do the reading',
      body: 'Ask for the risk or the cost of waiting. {Host} reads the decision through OrgX. Only you can approve it.',
      tip: 'Beside a chat, the answer lands in that chat. From the sidebar, it opens a new one.' },
    { id: 'work', tab: 'work', vis: 'work', target: ['.pn-work'],
      title: 'Watch the work move',
      body: 'In progress shows what your agents are running and what is blocked, live from OrgX.',
      tip: 'Approving a blocking decision is usually what moves a row from Blocked to Running.' },
    { id: 'done', tab: 'done', vis: 'done', target: ['.pn-done .pn-view-head', '.pn-done-sum', '.pn-rcs', '.pn-history'],
      title: 'Every decision leaves a receipt',
      body: 'Done keeps what you settled since opening the panel, each with what OrgX recorded.',
      tip: 'Your full history is one tap away: Decision history and the work ledger in OrgX.' },
    { id: 'launch', tab: 'done', vis: 'launch', target: ['.pn-done .pn-launch'],
      title: 'Start new work with a sentence',
      body: 'Each prompt shows the exact words it sends. {Host} turns them into OrgX actions: planning, starting an initiative, handing work to an agent.',
      tip: 'Type the same kind of sentence anywhere in {host}, for example “What should I do next in OrgX?”' },
    { id: 'ready', tab: 'needs', vis: 'ready', eyebrow: 'Ready', finish: true,
      title: 'You’re set',
      body: 'Your most urgent decision is open. Replay this tour any time from ? in the header.',
      tip: 'OrgX never acts on a prompt without your approval where it matters.' },
  ];

  function create(opts) {
    var root = opts.root;
    var state = { el: null, i: 0, done: {}, swipe: null, timer: 0 };

    function narrow() { return (global.innerWidth || 0) < 760; }
    /** How much of the view the host's own chrome covers (ChatGPT's title bar and composer on a phone). */
    function safe() {
      var H = global.OrgXPanelHost;
      var s = H && H.safeArea ? H.safeArea() : null;
      return s || { top: 0, right: 0, bottom: 0, left: 0 };
    }
    function rect(selectors) {
      var box = null;
      (selectors || []).forEach(function each(sel) {
        var nodes = Array.prototype.slice.call(root.querySelectorAll(sel), 0, /\.row$/.test(sel) ? 3 : 1);
        nodes.forEach(function add(n) {
          var r = n.getBoundingClientRect();
          if (!r.width || !r.height) return;
          box = box ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom };
        });
      });
      if (!box) return null;
      var pad = 4;
      return { x: box.l - pad, y: box.t - pad, w: box.r - box.l + pad * 2, h: box.b - box.t + pad * 2 };
    }
    function scrollIntoOpen(selectors) {
      var first = null;
      (selectors || []).some(function find(sel) { first = root.querySelector(sel); return Boolean(first); });
      if (!first) return;
      var pane = first.closest('.pn-detail, .pn-list') || global.document.scrollingElement;
      if (!pane) return;
      var sa = safe();
      var pr = pane === global.document.scrollingElement ? { top: sa.top, height: global.innerHeight - sa.top - sa.bottom } : pane.getBoundingClientRect();
      var tr = first.getBoundingClientRect();
      var delta = (tr.top - pr.top) - Math.max(0, (pr.height - tr.height) / 3);
      if (Math.abs(delta) > 4) pane.scrollTop += delta;
    }
    function place() {
      if (!state.el) return;
      var st = STEPS[state.i];
      var W = global.innerWidth, H = global.innerHeight;
      var dim = state.el.querySelector('.pn-tour-dim'), ring = state.el.querySelector('.pn-tour-ring'), card = state.el.querySelector('.pn-coach');
      var sa = safe();
      // The open view: what the host's own bars do not cover.
      var top = sa.top, bottom = H - sa.bottom, open = bottom - top;
      var r = st.target ? rect(st.target) : null;
      if (r) { r.x = Math.max(4, r.x); r.y = Math.max(top + 4, r.y); r.w = Math.min(W - r.x - 4, r.w); r.h = Math.max(0, Math.min(bottom - r.y - 4, r.h)); }
      card.style.left = card.style.top = card.style.bottom = card.style.maxHeight = '';
      if (narrow()) {
        var below = r ? r.y + r.h / 2 > top + open / 2 : false;
        card.style.maxHeight = Math.max(240, open - 24 - (r ? Math.min(r.h, 160) + 20 : 0)) + 'px';
        if (!r || below) card.style.top = (top + 8) + 'px'; else card.style.bottom = (sa.bottom + 8) + 'px';
        if (r) {
          var ch = card.offsetHeight;
          var freeTop = below ? top + ch + 18 : top + 4, freeBot = below ? bottom - 4 : bottom - ch - 18;
          r.y = Math.max(r.y, freeTop); r.h = Math.max(0, Math.min(r.h, freeBot - r.y));
        }
      } else {
        var cw = card.offsetWidth, chh = card.offsetHeight, x, y;
        if (!r) { x = (W - cw) / 2; y = Math.max(top + 16, top + (open - chh) / 2); }
        else if (W - (r.x + r.w) >= cw + 24) { x = r.x + r.w + 16; y = r.y; }
        else if (r.x >= cw + 24) { x = r.x - cw - 16; y = r.y; }
        else { x = Math.min(Math.max(16, r.x), W - cw - 16); y = r.y + r.h + 12 + chh < bottom ? r.y + r.h + 12 : Math.max(top + 16, r.y - chh - 12); }
        card.style.left = Math.round(Math.max(16, Math.min(x, W - cw - 16))) + 'px';
        card.style.top = Math.round(Math.max(top + 16, Math.min(y, bottom - chh - 16))) + 'px';
      }
      var hole = r && r.h > 0 ? 'M' + r.x + ' ' + r.y + 'h' + r.w + 'v' + r.h + 'h-' + r.w + 'Z' : 'M' + W / 2 + ' ' + H / 2 + 'h0v0h0Z';
      dim.style.clipPath = "path(evenodd, 'M0 0H" + W + 'V' + H + 'H0Z ' + hole + "')";
      ring.style.opacity = r && r.h > 0 ? '1' : '0';
      if (r) { ring.style.left = r.x + 'px'; ring.style.top = r.y + 'px'; ring.style.width = r.w + 'px'; ring.style.height = r.h + 'px'; }
    }
    function draw() {
      var st = STEPS[state.i], n = STEPS.length, i = state.i;
      var card = state.el.querySelector('.pn-coach');
      card.classList.toggle('is-center', !st.target);
      var steps = n - 2;
      var eyebrow = st.eyebrow || 'Step ' + i + ' of ' + steps;
      var tryHtml = st.try ? '<p class="pn-try' + (state.done[i] ? ' is-ok' : '') + '"><i aria-hidden="true">✓</i><span>' + esc(fill(state.done[i] ? st.tryOk : st.try)) + '</span></p>' : '';
      card.innerHTML = '<div class="pn-coach-in"><div class="pn-vis" aria-hidden="true">' + VIS[st.vis]() + '</div>' +
        '<span class="pn-coach-e">' + esc(eyebrow) + '</span><h2 class="pn-coach-t" id="pn-coach-t">' + esc(fill(st.title)) + '</h2>' +
        '<p class="pn-coach-b">' + esc(fill(st.body)) + '</p>' + tryHtml +
        '<p class="pn-coach-tip"><b>' + (i === 0 || st.finish ? 'Good to know' : 'Get more from it') + '</b>' + esc(fill(st.tip)) + '</p>' +
        '<div class="pn-coach-ft"><span class="pn-pips" aria-hidden="true">' + STEPS.slice(1, n - 1).map(function pip(_, k) { var at = k + 1; return '<i class="' + (at === i ? 'on' : at < i || st.finish ? 'past' : '') + '"></i>'; }).join('') + '</span>' +
        (st.finish ? '' : '<button type="button" class="pn-coach-skip" data-tour="skip">Skip</button>') +
        (i > 0 && !st.finish ? '<button type="button" class="secondary-btn" data-tour="back">Back</button>' : '') +
        '<button type="button" class="primary-btn pn-coach-next" data-tour="next">' + esc(st.finish ? 'Start deciding' : st.next || 'Next') + '</button></div></div>';
      card.scrollTop = 0;
      place();
      if (!narrow()) { var nb = card.querySelector('[data-tour="next"]'); if (nb) nb.focus({ preventScroll: true }); }
      if (opts.announce) opts.announce(fill(st.title));
    }
    function go(i) {
      state.i = Math.max(0, Math.min(STEPS.length - 1, i));
      var st = STEPS[state.i];
      if (opts.go) opts.go(st.tab);
      global.setTimeout(function afterRender() {
        if (!state.el) return;
        scrollIntoOpen(st.target);
        draw();
      }, 30);
    }
    function onClick(event) {
      var b = event.target.closest('[data-tour]');
      if (!b) return;
      var what = b.getAttribute('data-tour');
      if (what === 'next') { if (STEPS[state.i].finish) end('finished'); else go(state.i + 1); }
      else if (what === 'back') go(state.i - 1);
      else if (what === 'skip') end('skipped');
    }
    function onKey(event) {
      if (!state.el) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end('skipped'); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); if (STEPS[state.i].finish) end('finished'); else go(state.i + 1); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); go(state.i - 1); }
    }
    function onDown(event) { if (event.target.closest('.pn-coach') && !event.target.closest('button')) state.swipe = { x: event.clientX, y: event.clientY }; }
    function onUp(event) {
      if (!state.swipe) return;
      var dx = event.clientX - state.swipe.x, dy = event.clientY - state.swipe.y;
      state.swipe = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx < 0) { if (!STEPS[state.i].finish) go(state.i + 1); } else go(state.i - 1); }
    }
    function onResize() { place(); }
    function start() {
      if (state.el) return;
      var el = global.document.createElement('div');
      el.className = 'pn-tour';
      el.innerHTML = '<div class="pn-tour-dim"></div><div class="pn-tour-ring" aria-hidden="true"></div><div class="pn-coach" role="dialog" aria-modal="true" aria-labelledby="pn-coach-t"></div>';
      global.document.body.appendChild(el);
      state.el = el; state.done = {};
      el.addEventListener('click', onClick);
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerup', onUp);
      global.document.addEventListener('keydown', onKey, true);
      global.addEventListener('resize', onResize);
      go(0);
    }
    function end(reason) {
      if (!state.el) return;
      global.clearTimeout(state.timer);
      state.el.remove(); state.el = null;
      global.document.removeEventListener('keydown', onKey, true);
      global.removeEventListener('resize', onResize);
      markSeen();
      if (opts.onEnd) opts.onEnd(reason || 'closed');
    }
    /** The practice press: show the held step on the footer, then put it back. */
    function practice(footer) {
      if (!state.el || !STEPS[state.i].practice || !footer) return;
      var stepAt = state.i;
      var prev = { state: footer.getAttribute('state'), heading: footer.getAttribute('heading'), detail: footer.getAttribute('detail') };
      footer.setAttribute('state', 'saving');
      footer.setAttribute('heading', 'Practice: recording your approval');
      footer.setAttribute('detail', 'nothing is sent during the tour');
      global.clearTimeout(state.timer);
      state.timer = global.setTimeout(function revert() {
        if (footer.isConnected) {
          Object.keys(prev).forEach(function put(k) { if (prev[k] === null) footer.removeAttribute(k); else footer.setAttribute(k, prev[k]); });
        }
        state.done[stepAt] = true;
        if (state.el && state.i === stepAt) draw();
      }, 2200);
    }
    return {
      start: start,
      end: end,
      practice: practice,
      refresh: function refresh() { if (state.el) place(); },
      active: function active() { return Boolean(state.el); },
      isPractice: function isPractice() { return Boolean(state.el && STEPS[state.i].practice); },
    };
  }

  global.OrgXPanelTour = { create: create, seen: seen, markSeen: markSeen, STEPS: STEPS };
})(typeof window !== 'undefined' ? window : globalThis);
