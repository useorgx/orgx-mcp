/**
 * OrgX panel host: which app the panel is inside, and what kind of device.
 *
 * The panel is one document for every MCP Apps host: ChatGPT's sidebar and
 * threads, Claude on the desktop and on a phone, and any other host that
 * renders ui:// resources. Copy and layout both need to know where they are:
 * "Ask ChatGPT" is wrong inside Claude, and a phone wants safe-area padding,
 * swipe, and a way to go full screen that a sidebar never does.
 *
 * Sources, in the order they are trusted:
 *   1. window.openai             -> ChatGPT (the Apps SDK bridge).
 *   2. ui/initialize hostInfo    -> the host names itself (captured from the
 *                                   parent's response; the SDK keeps it private).
 *   3. host context userAgent    -> MCP Apps hosts may send their own UA.
 *   4. the browser's userAgent   -> an app web view can carry the app's name.
 *   5. ?host= and ?platform=     -> the local preview only (gallery or demo).
 *
 * Platform comes from the host context (web | desktop | mobile), then from
 * device capabilities (touch without hover), then from the browser (coarse
 * pointer and a phone-sized viewport). Safe-area insets and the display mode
 * come from the host context when it carries them.
 *
 *   OrgXPanelHost.name()        -> 'ChatGPT' | 'Claude' | 'Cursor' | … | null
 *   OrgXPanelHost.kind()        -> 'chatgpt' | 'claude' | 'cursor' | 'vscode' | 'unknown'
 *   OrgXPanelHost.chat()        -> the host's name, or 'the chat'
 *   OrgXPanelHost.assistant()   -> the host's name, or 'the assistant'
 *   OrgXPanelHost.ask()         -> 'Ask ChatGPT' | 'Ask Claude' | 'Ask in chat'
 *   OrgXPanelHost.settings()    -> 'ChatGPT settings' | 'Claude settings' | 'the app’s settings'
 *   OrgXPanelHost.fill(text)    -> replaces {host}, {chat}, {assistant}, {settings}
 *   OrgXPanelHost.platform()    -> 'web' | 'desktop' | 'mobile'
 *   OrgXPanelHost.isMobile()    -> platform is 'mobile'
 *   OrgXPanelHost.touch()       -> the device is touch-first (no hover)
 *   OrgXPanelHost.displayMode() -> 'inline' | 'fullscreen' | 'pip'
 *   OrgXPanelHost.canFullscreen() -> the host offers fullscreen and we are not in it
 *   OrgXPanelHost.safeArea()    -> { top, right, bottom, left }
 *   OrgXPanelHost.apply(context) -> read a host context; sets data-* and CSS vars
 *   OrgXPanelHost.onChange(fn)  -> called after anything above changes
 *   OrgXPanelHost.haptic(kind)  -> a short vibration on touch devices ('tap' | 'success' | 'warn')
 */
(function attachPanelHost(global) {
  'use strict';
  if (global.OrgXPanelHost) return;

  var NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', cursor: 'Cursor', vscode: 'VS Code', codex: 'Codex', gemini: 'Gemini', goose: 'Goose', unknown: null };
  var state = {
    kind: 'unknown',
    kindSource: null,
    hostInfo: null,
    platform: null,
    platformSource: null,
    touch: null,
    hover: null,
    displayMode: null,
    modes: [],
    safe: { top: 0, right: 0, bottom: 0, left: 0 },
    context: null,
  };
  var listeners = [];
  var doc = global.document;
  var params = null;
  try { params = new URLSearchParams(global.location.search); } catch (_) { params = null; }
  var preview = Boolean(params && (params.get('gallery') === 'true' || params.get('demo') === 'true'));

  function kindOf(text) {
    var s = String(text || '').toLowerCase();
    if (!s) return 'unknown';
    if (/chatgpt|openai/.test(s)) return 'chatgpt';
    if (/claude|anthropic/.test(s)) return 'claude';
    if (/cursor/.test(s)) return 'cursor';
    if (/vscode|visual studio code|copilot/.test(s)) return 'vscode';
    if (/codex/.test(s)) return 'codex';
    if (/gemini/.test(s)) return 'gemini';
    if (/goose/.test(s)) return 'goose';
    return 'unknown';
  }

  function emit() {
    listeners.slice().forEach(function call(fn) {
      try { fn(snapshot()); } catch (error) { if (global.console && console.error) console.error('[OrgX Panel] host listener failed:', error); }
    });
  }

  function setKind(kind, source) {
    if (kind === 'unknown' || kind === state.kind) return false;
    state.kind = kind;
    state.kindSource = source;
    paint();
    return true;
  }

  /** Who we are inside, from the strongest source available right now. */
  function detect() {
    if (preview && params.get('host')) { setKind(kindOf(params.get('host')), 'preview'); return; }
    if (global.openai) { setKind('chatgpt', 'openai'); return; }
    if (state.hostInfo && state.hostInfo.name) { if (setKind(kindOf(state.hostInfo.name), 'hostInfo')) return; }
    if (state.context && state.context.userAgent) { if (setKind(kindOf(state.context.userAgent), 'context')) return; }
    try {
      var ua = global.navigator && global.navigator.userAgent;
      // A browser UA mentions ChatGPT or Claude only inside that app's web view.
      if (ua && /chatgpt|claude/i.test(ua)) setKind(kindOf(ua), 'userAgent');
    } catch (_) { /* no navigator */ }
  }

  /** The ui/initialize response names the host; only the parent window is trusted. */
  function onMessage(event) {
    if (!event || event.source !== global.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
    var result = data.result;
    if (!result || typeof result !== 'object' || !result.hostInfo || typeof result.hostInfo !== 'object') return;
    var name = typeof result.hostInfo.name === 'string' ? result.hostInfo.name : '';
    if (!name) return;
    state.hostInfo = { name: name, version: typeof result.hostInfo.version === 'string' ? result.hostInfo.version : null };
    var before = state.kind;
    detect();
    if (state.kind !== before) emit();
  }
  if (global.addEventListener && global.parent && global.parent !== global) global.addEventListener('message', onMessage);

  function inferPlatform() {
    if (preview && params.get('platform')) return [params.get('platform'), 'preview'];
    var c = state.context;
    if (c && (c.platform === 'web' || c.platform === 'desktop' || c.platform === 'mobile')) return [c.platform, 'context'];
    if (state.touch === true && state.hover === false) return ['mobile', 'capabilities'];
    try {
      var coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
      var noHover = global.matchMedia && global.matchMedia('(hover: none)').matches;
      var narrow = (global.innerWidth || 0) > 0 && (global.innerWidth || 0) < 700;
      if (coarse && noHover && narrow) return ['mobile', 'media'];
    } catch (_) { /* no matchMedia */ }
    return ['web', 'default'];
  }

  function inferTouch() {
    if (state.touch !== null) return state.touch;
    try { return Boolean(global.matchMedia && global.matchMedia('(hover: none) and (pointer: coarse)').matches); } catch (_) { return false; }
  }

  /** Read one host context (initial or changed). Unknown fields are ignored. */
  function apply(context) {
    if (context && typeof context === 'object') state.context = Object.assign({}, state.context || {}, context);
    var c = state.context || {};
    var caps = c.deviceCapabilities && typeof c.deviceCapabilities === 'object' ? c.deviceCapabilities : {};
    if (typeof caps.touch === 'boolean') state.touch = caps.touch;
    if (typeof caps.hover === 'boolean') state.hover = caps.hover;
    if (c.displayMode === 'inline' || c.displayMode === 'fullscreen' || c.displayMode === 'pip') state.displayMode = c.displayMode;
    if (Array.isArray(c.availableDisplayModes)) state.modes = c.availableDisplayModes.filter(function valid(m) { return m === 'inline' || m === 'fullscreen' || m === 'pip'; });
    // The local preview can pretend the host offers modes: ?modes=inline,fullscreen&display=inline
    if (preview && params.get('modes')) state.modes = params.get('modes').split(',');
    if (preview && params.get('display')) state.displayMode = params.get('display');
    var s = c.safeAreaInsets;
    if (s && typeof s === 'object') {
      state.safe = {
        top: Math.max(0, Number(s.top) || 0), right: Math.max(0, Number(s.right) || 0),
        bottom: Math.max(0, Number(s.bottom) || 0), left: Math.max(0, Number(s.left) || 0),
      };
    }
    var p = inferPlatform();
    state.platform = p[0]; state.platformSource = p[1];
    detect();
    paint();
    emit();
  }

  /** What the DOM carries so CSS can follow: data-host, data-platform, data-touch, data-display-mode, safe-area vars. */
  function paint() {
    if (!doc || !doc.documentElement) return;
    var html = doc.documentElement;
    html.setAttribute('data-host', state.kind);
    if (state.platform) html.setAttribute('data-platform', state.platform);
    html.setAttribute('data-touch', inferTouch() ? 'true' : 'false');
    if (state.displayMode) html.setAttribute('data-display-mode', state.displayMode); else html.removeAttribute('data-display-mode');
    html.style.setProperty('--pn-safe-top', state.safe.top + 'px');
    html.style.setProperty('--pn-safe-right', state.safe.right + 'px');
    html.style.setProperty('--pn-safe-bottom', state.safe.bottom + 'px');
    html.style.setProperty('--pn-safe-left', state.safe.left + 'px');
  }

  function name() { return NAMES[state.kind] || null; }
  function chat() { return name() || 'the chat'; }
  function assistant() { return name() || 'the assistant'; }
  function ask() { return name() ? 'Ask ' + name() : 'Ask in chat'; }
  function settings() { return name() ? name() + ' settings' : 'the app’s settings'; }
  function fill(text) {
    return String(text == null ? '' : text)
      .replace(/\{host\}/g, chat()).replace(/\{chat\}/g, chat())
      .replace(/\{assistant\}/g, assistant()).replace(/\{settings\}/g, settings())
      .replace(/\{Host\}/g, name() || 'The assistant').replace(/\{Chat\}/g, name() || 'The chat');
  }
  function snapshot() {
    return {
      kind: state.kind, name: name(), platform: state.platform || 'web', touch: inferTouch(),
      displayMode: state.displayMode, modes: state.modes.slice(), safe: state.safe,
    };
  }
  function canFullscreen() {
    return state.modes.indexOf('fullscreen') !== -1 && state.displayMode !== 'fullscreen';
  }
  function reducedMotion() {
    try { return Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  /** A short vibration where the device has one; never on the desktop, never under reduced motion. */
  function haptic(kind) {
    if (!inferTouch() || reducedMotion()) return false;
    var nav = global.navigator;
    if (!nav || typeof nav.vibrate !== 'function') return false;
    var pattern = kind === 'success' ? [10, 40, 18] : kind === 'warn' ? [30] : [8];
    try { return Boolean(nav.vibrate(pattern)); } catch (_) { return false; }
  }

  // First paint from what is known before any host context arrives.
  apply(null);

  global.OrgXPanelHost = {
    name: name, kind: function kind() { return state.kind; }, chat: chat, assistant: assistant, ask: ask, settings: settings, fill: fill,
    platform: function platform() { return state.platform || 'web'; },
    isMobile: function isMobile() { return state.platform === 'mobile'; },
    touch: inferTouch,
    displayMode: function displayMode() { return state.displayMode; },
    canFullscreen: canFullscreen,
    safeArea: function safeArea() { return state.safe; },
    apply: apply,
    onChange: function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
    haptic: haptic,
    snapshot: snapshot,
    /** Tests and the preview: feed a host name as if the ui/initialize response carried it. */
    _setHostInfo: function setHostInfo(info) { state.hostInfo = info || null; var before = state.kind; detect(); if (state.kind !== before) emit(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
