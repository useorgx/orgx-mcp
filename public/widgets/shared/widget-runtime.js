(function installOrgXWidgetRuntime(global) {
  'use strict';

  if (global.OrgXWidgetRuntime) return;

  // Last input on <html> (same tracker and guard as interaction-kit.js):
  // widget-theme.css hides focus rings after a pointer press.
  (function (doc) {
    if (!doc || doc.__oxInput) return;
    doc.__oxInput = 1;
    var set = function (m) { doc.documentElement.setAttribute('data-ox-input', m); };
    doc.addEventListener('pointerdown', function () { set('pointer'); }, true);
    doc.addEventListener('keydown', function (e) { if (!e.metaKey && !e.ctrlKey && !e.altKey) set('keyboard'); }, true);
  })(global.document || null);

  var protocol = null;
  var bridge = null;
  var hostLocale = null;
  var hostTimeZone = null;
  var chatGptActionsFallback = false;
  var explicitTheme = null;
  var themeSource = 'system';

  function normalizeTheme(value) {
    return value === 'dark' || value === 'light' ? value : null;
  }

  function getUrlTheme() {
    try {
      return normalizeTheme(new URLSearchParams(global.location.search).get('theme'));
    } catch (_) {
      return null;
    }
  }

  function applyTheme(value, source) {
    var theme = normalizeTheme(value);
    if (!theme) return null;
    if (explicitTheme && source !== 'url') {
      theme = explicitTheme;
      source = 'url';
    }
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-source', source || 'system');
    document.documentElement.style.colorScheme = theme;
    themeSource = source || 'system';
    return theme;
  }

  function getTheme() {
    return normalizeTheme(document.documentElement.getAttribute('data-theme'));
  }

  function resolveInitialTheme() {
    explicitTheme = getUrlTheme();
    if (explicitTheme) return applyTheme(explicitTheme, 'url');

    var chatGptTheme = normalizeTheme(global.openai && global.openai.theme);
    if (chatGptTheme) return applyTheme(chatGptTheme, 'host');

    var declaredTheme = getTheme();
    if (declaredTheme) return applyTheme(declaredTheme, 'document');

    var prefersDark =
      typeof global.matchMedia === 'function' &&
      global.matchMedia('(prefers-color-scheme: dark)').matches;
    return applyTheme(prefersDark ? 'dark' : 'light', 'system');
  }

  resolveInitialTheme();

  if (typeof global.matchMedia === 'function') {
    var colorSchemeQuery = global.matchMedia('(prefers-color-scheme: dark)');
    var onColorSchemeChange = function onColorSchemeChange(event) {
      if (explicitTheme || themeSource === 'host') return;
      applyTheme(event.matches ? 'dark' : 'light', 'system');
    };
    if (colorSchemeQuery.addEventListener) {
      colorSchemeQuery.addEventListener('change', onColorSchemeChange);
    } else if (colorSchemeQuery.addListener) {
      colorSchemeQuery.addListener(onColorSchemeChange);
    }
  }

  function detectProtocol() {
    // The gallery embeds fixture pages in an iframe. Explicit gallery mode
    // must stay deterministic and never wait for a host tool-result bridge.
    // Real ChatGPT/MCP embeds do not carry this query flag, so their protocol
    // detection remains unchanged.
    try {
      var params = new URLSearchParams(global.location.search);
      if (params.get('gallery') === 'true') return 'standalone';
    } catch (_) {
      // Keep normal protocol detection if URL parsing is unavailable.
    }
    if (global.openai) return 'chatgpt';
    if (global.McpApps && global.McpApps.App && global.parent !== global) {
      return 'mcp-apps-sdk';
    }
    if (global.parent && global.parent !== global) return 'mcp-apps';
    return 'standalone';
  }

  function getProtocol() {
    if (!protocol) protocol = detectProtocol();
    return protocol;
  }

  function extractStructuredWidgetData(result, plainTextObject) {
    if (result && result.isError === true) {
      var decoded = extractStructuredWidgetData(Object.assign({}, result, { isError: false }), true);
      var decodedError = decoded && typeof decoded === 'object' ? (decoded.error || decoded) : null;
      var failure = { ok: false, error: getErrorMessage(decoded, 'The tool request failed. Try the request again.') };
      if (decodedError && typeof decodedError === 'object' && typeof decodedError.code === 'string') {
        failure.code = decodedError.code;
      }
      // Refusal details a widget acts on (for example a decision's current widget_actions).
      if (decodedError && typeof decodedError === 'object' && decodedError.details && typeof decodedError.details === 'object') {
        failure.details = decodedError.details;
      }
      return failure;
    }
    if (result && result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    if (result && Array.isArray(result.content)) {
      var firstText = null;
      for (var index = 0; index < result.content.length; index += 1) {
        var item = result.content[index];
        if (!item || item.type !== 'text' || !item.text) continue;
        if (firstText === null) firstText = item.text;
        try {
          return JSON.parse(item.text);
        } catch (_) {
          // A host may prepend a summary before the structured JSON block.
        }
      }
      if (plainTextObject && firstText !== null) return { text: firstText };
    }
    if (typeof result === 'string') {
      try {
        return JSON.parse(result);
      } catch (_) {
        return plainTextObject ? { text: result } : result;
      }
    }
    return result;
  }

  // Search shares a template with decision history and recommendations. The
  // host can deliver their payload directly, as MCP JSON, or inside the
  // standard {ok, data, summary} envelope. Keep this specific to search:
  // other templates intentionally read their own `data` property.
  function extractSearchWidgetData(result) {
    var value = extractStructuredWidgetData(result, true);
    for (var depth = 0; depth < 5; depth += 1) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) break;
      if (value.ok === false || value.error || value.isError === true) return value;
      if (Array.isArray(value.results) || Array.isArray(value.decisions) ||
          Array.isArray(value.recommendations) || value.next_action) return value;
      var groups = value.results_by_type;
      if (groups && typeof groups === 'object' && !Array.isArray(groups) &&
          Object.keys(groups).every(function(kind) { return Array.isArray(groups[kind]); })) {
        var rows = [];
        Object.keys(groups).forEach(function(kind) {
          groups[kind].forEach(function(row) {
            if (row && typeof row === 'object' && !Array.isArray(row)) {
              rows.push(Object.assign({}, row, { type: typeof row.type === 'string' ? row.type : kind.replace(/s$/, '') }));
            }
          });
        });
        return Object.assign({}, value, { results: rows });
      }
      if (value._meta && value._meta['orgx/searchPayload']) {
        value = value._meta['orgx/searchPayload'];
        continue;
      }
      if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
        value = extractStructuredWidgetData(value.data, true);
        continue;
      }
      var nested = value.result || value.output || value.toolOutput;
      if (nested && nested !== value) {
        value = extractStructuredWidgetData(nested, true);
        continue;
      }
      break;
    }
    return value;
  }

  function toolFailureError(data) {
    var error = new Error(getErrorMessage(data.error || data, 'The tool request failed.'));
    error.code = (data.error && typeof data.error === 'object' && data.error.code) || data.code || 'tool_failed';
    var details = (data.error && typeof data.error === 'object' && data.error.details) || data.details;
    if (details && typeof details === 'object') error.details = details;
    error.result = data;
    return error;
  }

  function unpackToolResult(result) {
    var data = extractStructuredWidgetData(result, true);
    if (data && data.ok === false) throw toolFailureError(data);
    return data;
  }

  // Hosts can replay a previous tool result while a fresh result is still
  // arriving. Accepting that replay makes a card jump backwards (for example
  // from completed to running). Prefer the newest server timestamp when one
  // is present, while preserving arrival order for payloads that cannot carry
  // a timestamp.
  function extractResultTimestamp(value, depth) {
    if (value === null || value === undefined || (depth || 0) > 4) return null;
    if (global.OrgXWidgetState && global.OrgXWidgetState.observedAt) {
      var shared = global.OrgXWidgetState.observedAt(value);
      if (shared !== null) return shared;
    }
    if (typeof value !== 'object') return null;
    var fields = [
      'observed_at', 'observedAt', 'updated_at', 'updatedAt', 'last_synced_at',
      'lastSyncedAt', 'refreshed_at', 'refreshedAt', 'generated_at', 'generatedAt',
      'last_heartbeat_at', 'lastHeartbeatAt', 'completed_at', 'completedAt'
    ];
    var latest = null;
    for (var i = 0; i < fields.length; i += 1) {
      var candidate = value[fields[i]];
      if (typeof candidate === 'number' && isFinite(candidate)) {
        var numeric = candidate < 100000000000 ? candidate * 1000 : candidate;
        latest = latest === null ? numeric : Math.max(latest, numeric);
      }
      if (typeof candidate === 'string' && candidate.trim()) {
        var parsed = Date.parse(candidate);
        if (isFinite(parsed)) latest = latest === null ? parsed : Math.max(latest, parsed);
      }
    }
    if (latest !== null) return latest;
    var nested = value.structuredContent || value.result || value.output || value.toolOutput;
    return nested && nested !== value ? extractResultTimestamp(nested, (depth || 0) + 1) : null;
  }

  function extractLifecycleRank(value, depth) {
    if (value === null || value === undefined || (depth || 0) > 4) return 0;
    var raw = null;
    if (typeof value === 'object') {
      var fields = ['status', 'state', 'phase', 'execution_status', 'executionState'];
      for (var i = 0; i < fields.length; i += 1) {
        if (typeof value[fields[i]] === 'string' && value[fields[i]].trim()) {
          raw = value[fields[i]].toLowerCase().replace(/[^a-z0-9]+/g, '_');
          break;
        }
      }
      if (!raw) {
        var nested = value.structuredContent || value.result || value.output || value.toolOutput;
        return nested && nested !== value ? extractLifecycleRank(nested, (depth || 0) + 1) : 0;
      }
    } else if (typeof value === 'string') {
      raw = value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    }
    if (['done', 'complete', 'completed', 'approved', 'shipped', 'resolved', 'success'].indexOf(raw) !== -1) return 5;
    if (['failed', 'error', 'cancelled', 'canceled'].indexOf(raw) !== -1) return 4;
    if (['blocked', 'at_risk', 'waiting', 'needs_input', 'needs_review'].indexOf(raw) !== -1) return 3;
    if (['running', 'active', 'executing', 'in_progress', 'working'].indexOf(raw) !== -1) return 2;
    if (['queued', 'pending', 'not_started', 'todo', 'backlog'].indexOf(raw) !== -1) return 1;
    return 0;
  }

  function createResultGate(getScope) {
    var newestObservedAt = null;
    var newestLifecycleRank = 0;
    var newestScope;
    var arrival = 0;
    return {
      accept: function accept(raw) {
        // Timestamp ordering is meaningful only within the same declared scope.
        var scope = getScope ? getScope(extractStructuredWidgetData(raw, true)) : undefined;
        if (scope !== undefined && scope !== newestScope) {
          newestScope = scope;
          newestObservedAt = null;
          newestLifecycleRank = 0;
        }
        var nextObservedAt = extractResultTimestamp(raw, 0);
        if (
          nextObservedAt !== null &&
          newestObservedAt !== null &&
          (nextObservedAt < newestObservedAt ||
            (nextObservedAt === newestObservedAt && extractLifecycleRank(raw, 0) < newestLifecycleRank))
        ) {
          return false;
        }
        if (nextObservedAt !== null) {
          newestObservedAt = nextObservedAt;
          newestLifecycleRank = extractLifecycleRank(raw, 0);
        }
        arrival += 1;
        return arrival > 0;
      },
      getObservedAt: function getObservedAt() { return newestObservedAt; }
    };
  }

  function getErrorMessage(value, fallback) {
    var seen = [];

    function read(candidate, depth) {
      if (candidate === null || candidate === undefined || depth > 4) return '';
      if (typeof candidate === 'string') return candidate.trim();
      if (typeof candidate === 'number' || typeof candidate === 'boolean') {
        return String(candidate);
      }
      if (Array.isArray(candidate)) {
        return candidate
          .map(function readEntry(entry) { return read(entry, depth + 1); })
          .filter(Boolean)
          .join('; ');
      }
      if (typeof candidate !== 'object' || seen.indexOf(candidate) !== -1) return '';
      seen.push(candidate);

      var fields = ['message', 'detail', 'reason', 'description', 'error', 'title', 'code'];
      for (var index = 0; index < fields.length; index += 1) {
        var message = read(candidate[fields[index]], depth + 1);
        if (message) return message;
      }
      return '';
    }

    return read(value, 0) || (typeof fallback === 'string' ? fallback : '');
  }

  function applyHostContext(context) {
    if (!context) return;
    // MCP Apps hosts report the viewer's locale and time zone here; the time
    // formatter prefers them over the browser's.
    if (typeof context.locale === 'string' && context.locale) hostLocale = context.locale;
    if (typeof context.timeZone === 'string' && context.timeZone) hostTimeZone = context.timeZone;
    if (context.theme && global.McpApps && global.McpApps.applyDocumentTheme) {
      global.McpApps.applyDocumentTheme(context.theme);
    }
    if (context.theme) applyTheme(context.theme, 'host');
    if (!global.McpApps) return;
    if (context.styles && context.styles.variables && global.McpApps.applyHostStyleVariables) {
      global.McpApps.applyHostStyleVariables(context.styles.variables);
    }
    if (
      context.styles &&
      context.styles.css &&
      context.styles.css.fonts &&
      global.McpApps.applyHostFonts
    ) {
      global.McpApps.applyHostFonts(context.styles.css.fonts);
    }
  }

  // Tool input seen, no result yet: initWidget({ onToolInput }) or getToolCallState().
  var toolCallState = { inputSeen: false, resultSeen: false, inputAt: null, resultAt: null };
  var toolInputListeners = [];

  function markToolInput() {
    if (toolCallState.inputSeen) return;
    toolCallState.inputSeen = true;
    toolCallState.inputAt = Date.now();
    var snapshot = getToolCallState();
    toolInputListeners.slice().forEach(function notify(listener) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[OrgX Widget] Tool input listener failed:', error);
      }
    });
  }

  function markToolResult() {
    if (toolCallState.resultSeen) return;
    toolCallState.resultSeen = true;
    toolCallState.resultAt = Date.now();
  }

  function getToolCallState() {
    return {
      inputSeen: toolCallState.inputSeen,
      resultSeen: toolCallState.resultSeen,
      awaitingResult: toolCallState.inputSeen && !toolCallState.resultSeen,
      inputAt: toolCallState.inputAt,
      resultAt: toolCallState.resultAt,
    };
  }

  function LegacyBridge() {
    this.pending = new Map();
    this.nextId = 1;
    this.toolResultCallback = null;
    this.handleMessage = this.handleMessage.bind(this);
    global.addEventListener('message', this.handleMessage);
  }

  LegacyBridge.prototype.connect = function connect() {
    global.parent.postMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      '*'
    );
    return Promise.resolve();
  };

  LegacyBridge.prototype.request = function request(method, params) {
    var self = this;
    return new Promise(function sendRequest(resolve, reject) {
      var id = self.nextId;
      self.nextId += 1;
      self.pending.set(id, { resolve: resolve, reject: reject });
      global.parent.postMessage(
        { jsonrpc: '2.0', id: id, method: method, params: params },
        '*'
      );
      global.setTimeout(function rejectTimedOutRequest() {
        if (!self.pending.has(id)) return;
        self.pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 30000);
    });
  };

  LegacyBridge.prototype.callServerTool = function callServerTool(params) {
    return this.request('tools/call', params).then(function normalize(result) {
      return unpackToolResult(result);
    });
  };

  LegacyBridge.prototype.callServerToolRaw = function callServerToolRaw(params) {
    return this.request('tools/call', params);
  };

  LegacyBridge.prototype.openLink = function openLink(url) {
    return this.request('ui/open-link', { url: url });
  };

  LegacyBridge.prototype.updateModelContext = function updateModelContext(payload) {
    return this.request('ui/update-model-context', payload);
  };

  LegacyBridge.prototype.requestDisplayMode = function requestDisplayMode(mode) {
    return this.request('ui/request-display-mode', { mode: mode });
  };

  LegacyBridge.prototype.handleMessage = function handleMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.id != null && this.pending.has(data.id)) {
      var pending = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) {
        var hostError = new Error(getErrorMessage(data.error, 'Host request failed'));
        hostError.raw = rawErrorText(data.error);
        pending.reject(hostError);
      }
      else pending.resolve(data.result);
      return;
    }
    if (data.method === 'ui/notifications/tool-input') {
      markToolInput();
      return;
    }
    if (
      (data.method === 'ui/notifications/tool-result' ||
        data.method === 'notifications/message') &&
      data.params &&
      this.toolResultCallback
    ) {
      markToolResult();
      rememberResultMeta(data.params);
      this.toolResultCallback(extractStructuredWidgetData(data.params));
    }
  };

  LegacyBridge.prototype.destroy = function destroy() {
    global.removeEventListener('message', this.handleMessage);
  };

  // Opt-in host-context listeners (initWidget options.onHostContext). Widgets
  // that do not pass one see no change.
  var hostContextListeners = [];

  function notifyHostContext(app) {
    if (!hostContextListeners.length) return;
    var context = null;
    try {
      context = app && app.getHostContext ? app.getHostContext() : null;
    } catch (_) {
      context = null;
    }
    hostContextListeners.slice().forEach(function callListener(listener) {
      try {
        listener(context, app);
      } catch (error) {
        console.error('[OrgX Widget] Host context listener failed:', error);
      }
    });
  }

  function McpAppsSDKBridge() {
    this.app = null;
    this.connected = false;
    this.connectPromise = null;
    this.toolResultCallback = null;
  }

  McpAppsSDKBridge.prototype.connect = function connect() {
    var self = this;
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal().catch(function clearFailedConnection(error) {
      self.connectPromise = null;
      self.app = null;
      throw error;
    });
    return this.connectPromise;
  };

  McpAppsSDKBridge.prototype.connectInternal = async function connectInternal() {
    var self = this;
    this.app = new global.McpApps.App({
      name: 'OrgX Widget',
      version: '2.0.0',
    });
    this.app.ontoolinput = function onToolInput() {
      markToolInput();
    };
    this.app.ontoolresult = function onToolResult(result) {
      markToolResult();
      rememberResultMeta(result);
      if (self.toolResultCallback) {
        self.toolResultCallback(extractStructuredWidgetData(result));
      }
    };
    this.app.onhostcontextchanged = function onHostContextChanged(params) {
      applyHostContext(params);
      notifyHostContext(self.app);
    };
    await this.app.connect();
    this.connected = true;
    try {
      applyHostContext(this.app.getHostContext());
    } catch (_) {
      // Host context is optional.
    }
    notifyHostContext(this.app);
  };

  McpAppsSDKBridge.prototype.callServerTool = async function callServerTool(params) {
    await this.connect();
    var result = await this.app.callServerTool(params);
    return unpackToolResult(result);
  };

  McpAppsSDKBridge.prototype.callServerToolRaw = async function callServerToolRaw(params) {
    await this.connect();
    return this.app.callServerTool(params);
  };

  McpAppsSDKBridge.prototype.openLink = async function openLink(url) {
    await this.connect();
    return this.app.openLink({ url: url });
  };

  McpAppsSDKBridge.prototype.updateModelContext = async function updateModelContext(payload) {
    await this.connect();
    return this.app.updateModelContext(payload);
  };

  McpAppsSDKBridge.prototype.requestDisplayMode = async function requestDisplayMode(mode) {
    await this.connect();
    return this.app.requestDisplayMode({ mode: mode });
  };

  McpAppsSDKBridge.prototype.getHostContext = function getHostContext() {
    return this.app && this.app.getHostContext ? this.app.getHostContext() : null;
  };

  McpAppsSDKBridge.prototype.destroy = function destroy() {
    if (this.app && this.app.close) this.app.close();
    this.app = null;
    this.connected = false;
    this.connectPromise = null;
  };

  function getBridge(preferSDK) {
    if (!bridge) {
      bridge = preferSDK || (global.McpApps && global.McpApps.App)
        ? new McpAppsSDKBridge()
        : new LegacyBridge();
    }
    return bridge;
  }

  function reportSize() {
    if (getProtocol() === 'chatgpt' && global.openai && global.openai.setWidgetHeight) {
      global.openai.setWidgetHeight({ height: document.body.scrollHeight });
    }
  }

  function observeChatGPTSize() {
    if (getProtocol() !== 'chatgpt') return;
    reportSize();
    if (typeof ResizeObserver === 'undefined') return;
    var frame = 0;
    var observer = new ResizeObserver(function onResize() {
      if (frame) global.cancelAnimationFrame(frame);
      frame = global.requestAnimationFrame(reportSize);
    });
    observer.observe(document.documentElement);
    observer.observe(document.body);
  }

  /**
   * Attach the live control-flow panel when a payload carries a subscription
   * grant and the widget opted in via `options.live`.
   *
   * This lives in initWidget because initWidget is the one place every widget
   * already routes its payload through. Doing it per widget meant each one
   * re-implementing the same mount/attach/guard dance, which is how the live
   * surfaces drifted apart before. Resolved lazily: live-store.js loads after
   * this file, and a widget without it simply stays static.
   */
  function maybeAttachLive(options, data, state) {
    if (!options.live || state.attached) return;
    var grant = data && data.live;
    if (!grant || !grant.streamUrl) return;
    var store = global.OrgXLiveStore;
    if (!store || !store.attachLiveFeed) return;

    state.attached = store.attachLiveFeed({
      widget: options.live.widget || grant.feedType,
      grant: grant,
      emptyLabel: options.live.emptyLabel,
      maxRows: options.live.maxRows,
      onSelect: options.live.onSelect,
      mount: function mount() {
        return store.ensureLiveMount(options.live.anchor, 'liveFlow');
      },
    });
    return state.attached;
  }

  // Opt-in (options.bridge === 'mcp-apps-sdk'): prefer the official MCP Apps
  // bridge even when window.openai exists, so a widget can read MCP Apps host
  // context (for example OpenAI extension fields). Every other widget keeps
  // the ChatGPT bridge whenever window.openai exists.
  function canUseSdkBridge() {
    return Boolean(global.McpApps && global.McpApps.App && global.parent && global.parent !== global);
  }

  function initWidget(options) {
    var render = options.render;
    var getData = options.getData || extractStructuredWidgetData;
    var currentData = null;
    var resultGate = createResultGate(options.resultScope);
    var liveState = { attached: null };
    var activeProtocol = getProtocol();
    var chatGptFallback = false;
    if (options.bridge === 'mcp-apps-sdk' && activeProtocol === 'chatgpt' && canUseSdkBridge()) {
      protocol = 'mcp-apps-sdk';
      activeProtocol = protocol;
      chatGptFallback = true;
    }
    if (typeof options.onHostContext === 'function') {
      hostContextListeners.push(options.onHostContext);
    }
    if (typeof options.onToolInput === 'function') {
      toolInputListeners.push(options.onToolInput);
    }
    document.documentElement.setAttribute('data-protocol', activeProtocol);

    function showDataAvailability(decoded) {
      if (options.dataAvailabilityNotice === false) return;
      var records = [decoded, decoded && decoded.data];
      var degraded = records.some(function isPartial(record) {
        return record && (record.degraded === true ||
          (Array.isArray(record.degraded) && record.degraded.length > 0));
      });
      var notice = document.getElementById('orgx-data-availability');
      if (!degraded) {
        if (notice) notice.remove();
        return;
      }
      if (!notice) {
        notice = document.createElement('section');
        notice.id = 'orgx-data-availability';
        notice.className = 'widget-data-availability';
        notice.setAttribute('role', 'status');
        var title = document.createElement('strong');
        title.textContent = 'Data may be incomplete';
        var detail = document.createElement('p');
        detail.textContent = 'Some source data is unavailable. Treat counts and summaries as partial until the next successful refresh.';
        notice.appendChild(title);
        notice.appendChild(detail);
      }
      document.body.prepend(notice);
    }

    function receiveResult(result) {
      if (result === null && document.getElementById('orgx-tool-error')) return;
      if (!resultGate.accept(result)) return;
      var decoded = extractStructuredWidgetData(result, true);
      var failure = decoded && typeof decoded === 'object' && decoded.ok === false;
      var alert = document.getElementById('orgx-tool-error');
      if (failure && typeof options.onFailure === 'function' && options.onFailure(decoded) === true) {
        // The widget renders this failure itself (opt-in).
        reportSize();
        return;
      }
      if (failure) {
        var notice = document.getElementById('orgx-data-availability');
        if (notice) notice.remove();
        if (!alert) {
          alert = document.createElement('section');
          alert.id = 'orgx-tool-error';
          alert.className = 'widget-tool-error';
          alert.setAttribute('role', 'alert');
          var title = document.createElement('strong');
          title.textContent = 'Request failed';
          alert.appendChild(title);
          alert.appendChild(document.createElement('p'));
        }
        // Never print a raw host payload: the same contract as callTool.
        alert.querySelector('p').textContent = normalizeToolError(toolFailureError(decoded)).message;
        // Renderers replace their own content. An initial failure must never
        // look like a successful empty result or remain a loading skeleton.
        // Preserve the last data internally so a subsequent success recovers.
        Array.prototype.forEach.call(document.body.children, function hideContent(child) {
          if (child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE' && child !== alert && !child.hidden) {
            child.setAttribute('data-orgx-error-hidden', 'true');
            child.hidden = true;
          }
        });
        document.body.prepend(alert);
        reportSize();
        return;
      }
      if (alert) alert.remove();
      Array.prototype.forEach.call(document.querySelectorAll('[data-orgx-error-hidden]'), function restoreContent(child) {
        child.hidden = false;
        child.removeAttribute('data-orgx-error-hidden');
      });
      if (result !== null || currentData === null) {
        currentData = getData(result);
        render(currentData);
        maybeAttachLive(options, currentData, liveState);
        showDataAvailability(decoded);
      }
      reportSize();
    }

    var chatGptStarted = false;
    function startChatGPT() {
      if (chatGptStarted) return;
      chatGptStarted = true;
      applyTheme(global.openai && global.openai.theme, 'host');
      var initialOutput = global.openai && global.openai.toolOutput;
      if (initialOutput !== null && initialOutput !== undefined) markToolResult();
      else if (global.openai && global.openai.toolInput) markToolInput();
      if (initialOutput !== null && initialOutput !== undefined || options.getData) receiveResult(initialOutput);
      else render(null);
      observeChatGPTSize();
      global.addEventListener(
        'openai:set_globals',
        function onOpenAIGlobals(event) {
          var globals = event.detail && event.detail.globals;
          if (!globals) return;
          if (globals.theme !== undefined) applyTheme(globals.theme, 'host');
          if (globals.toolInput !== undefined && globals.toolInput !== null) markToolInput();
          if (globals.toolOutput === undefined) {
            if (options.getData && globals.toolResponseMetadata !== undefined) {
              receiveResult(global.openai && global.openai.toolOutput);
            }
            return;
          }
          // A host may briefly publish null while it rehydrates. Keep the
          // last known result visible instead of replacing it with an empty
          // or loading-looking card.
          if (globals.toolOutput !== null) markToolResult();
          receiveResult(globals.toolOutput);
        },
        { passive: true }
      );
    }

    if (activeProtocol === 'chatgpt') {
      startChatGPT();
    } else if (activeProtocol === 'mcp-apps-sdk' || activeProtocol === 'mcp-apps') {
      render(null);
      // Some ChatGPT clients deliver globals but never complete the SDK
      // handshake; others deliver only SDK notifications. Observe both.
      if (chatGptFallback && options.observeChatGPTGlobals === true) {
        chatGptActionsFallback = true;
        startChatGPT();
      }
      var activeBridge = getBridge(activeProtocol === 'mcp-apps-sdk');
      activeBridge.toolResultCallback = function onToolResult(result) {
        receiveResult(result);
      };
      activeBridge.connect().catch(function onConnectionFailure(error) {
        console.error('[OrgX Widget] Host connection failed:', error);
        if (!chatGptFallback || !global.openai) return;
        // The opted-in SDK bridge could not connect: fall back to ChatGPT.
        if (activeBridge.destroy) activeBridge.destroy();
        bridge = null;
        protocol = 'chatgpt';
        document.documentElement.setAttribute('data-protocol', 'chatgpt');
        startChatGPT();
      });
    } else {
      render(null);
    }

    return {
      getData: function getCurrentData() { return currentData; },
      getLiveFeed: function getLiveFeed() { return liveState.attached; },
    };
  }

  // An action only counts as done when the host returns a result that is not
  // a failure. A missing host bridge is a failure, never a silent success.
  function hostUnavailableError(name) {
    var error = new Error(TOOL_ERROR_COPY.host_unavailable);
    error.code = 'host_unavailable';
    error.tool = name;
    return error;
  }

  /* ------------------------------------------------------ tool errors -- */
  // callTool/callToolResult reject with Error { code, message, details }:
  // message is always human, raw host text only in details.raw. Codes:
  // tool_unavailable (host lacks the tool, e.g. ChatGPT's "MCP Resource not
  // found"), network, host_unavailable, tool_failed; any other code is the
  // OrgX server's refusal, unchanged.
  var TOOL_ERROR_COPY = {
    tool_unavailable: 'Refresh the OrgX app in ChatGPT settings to load the current tools, or open this work in OrgX.',
    network: 'Couldn\u2019t reach OrgX. Check the connection and try again.',
    host_unavailable: 'This view cannot act here. Open it in ChatGPT, Claude, or OrgX to continue.',
    tool_failed: 'That didn\u2019t go through. Try again, or open it in OrgX.',
  };
  var TOOL_ERROR_CODES = ['tool_unavailable', 'network', 'host_unavailable', 'tool_failed'];
  var GENERIC_TOOL_ERROR_CODES = { tool_failed: true, tool_execution_failed: true };
  var TOOL_UNAVAILABLE_PATTERN = /resource not found|\btool\b[^.\n]{0,120}\bnot found\b|unknown tool|no such tool|\btool\b[^.\n]{0,60}\b(?:is )?not (?:available|enabled|allowed|registered)\b|\btool\b[^.\n]{0,60}\bdisabled\b|not in the (?:imported )?tool list/i;
  var NETWORK_PATTERN = /failed to fetch|networkerror|network ?error|network request failed|load failed|fetch failed|timed out|\btimeout\b|\becon(?:nreset|nrefused|naborted)\b|enotfound|socket hang up|connection (?:reset|refused|closed|lost)|\boffline\b|bad gateway|gateway time-?out|service unavailable|\b50[234]\b/i;

  function rawErrorText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    // Duck-typed: errors may come from another realm (the host frame).
    if (typeof value === 'object' && typeof value.message === 'string') {
      var parts = [value.message];
      if (value.raw && typeof value.raw === 'string') parts.push(value.raw);
      return parts.filter(Boolean).join(' ');
    }
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }

  // Host text is often a JSON body (it rendered as a lone "{"); read it first.
  function readableHostText(text) {
    var trimmed = String(text || '').trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        var parsed = JSON.parse(trimmed);
        var said = getErrorMessage(parsed, '');
        if (said) return said;
      } catch (_) {
        // Truncated JSON: classify the raw text as-is.
      }
    }
    return trimmed;
  }

  function looksRaw(message) {
    var text = String(message || '').trim();
    return !text || /^[\[{<]/.test(text) || text.length > 300 || /\n/.test(text);
  }

  function classifyHostText(text) {
    var readable = readableHostText(text) + ' ' + String(text || '');
    if (TOOL_UNAVAILABLE_PATTERN.test(readable)) return 'tool_unavailable';
    if (NETWORK_PATTERN.test(readable)) return 'network';
    return null;
  }

  function normalizeToolError(error, toolName) {
    if (error && error.orgxNormalized === true) return error;
    var raw = rawErrorText(error).slice(0, 2000);
    var incomingCode = error && typeof error.code === 'string' ? error.code : '';
    var details = error && error.details && typeof error.details === 'object' ? Object.assign({}, error.details) : {};
    var code;
    var message;
    if (incomingCode && !GENERIC_TOOL_ERROR_CODES[incomingCode]) {
      // Server refusal (or host_unavailable): keep the code; replace only raw text.
      code = incomingCode;
      message = error.message;
      if (looksRaw(message)) {
        if (raw) details.raw = raw;
        message = TOOL_ERROR_COPY[code] || TOOL_ERROR_COPY.tool_failed;
      }
    } else {
      code = classifyHostText(raw) || 'tool_failed';
      if (code === 'tool_failed' && error && error.message && !looksRaw(error.message) && !TOOL_UNAVAILABLE_PATTERN.test(error.message)) {
        // An unclassified failure the server already worded for people.
        message = error.message;
      } else {
        message = TOOL_ERROR_COPY[code];
        if (raw) details.raw = raw;
      }
    }
    var normalized = new Error(message);
    normalized.code = code;
    normalized.details = details;
    normalized.tool = toolName || (error && error.tool) || null;
    if (error && error.status !== undefined) normalized.status = error.status;
    if (error && error.statusCode !== undefined) normalized.statusCode = error.statusCode;
    if (error && error.result !== undefined) normalized.result = error.result;
    Object.defineProperty(normalized, 'orgxNormalized', { value: true });
    return normalized;
  }

  // A host error body resolved as a result ({"detail": ...}) is a failure.
  function hostErrorBody(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    if (result.structuredContent !== undefined || Array.isArray(result.content)) return null;
    if (typeof result.detail === 'string' && Object.keys(result).length <= 2) return result.detail;
    return null;
  }

  function rejectToolFailure(result) {
    var hostDetail = hostErrorBody(result);
    if (hostDetail !== null) {
      var hostError = new Error(hostDetail);
      hostError.raw = JSON.stringify(result);
      throw hostError;
    }
    var data = extractStructuredWidgetData(result, true);
    if (data && data.ok === false) throw toolFailureError(data);
    return result;
  }

  // Current widgets call the explicit operation catalog directly.
  var TOOL_ALIASES = {};

  function resolveToolCall(name, args) {
    return { name: name, args: args || {} };
  }

  // Result `_meta` is handed to the widget only, never to the model. Widgets
  // read approval tokens from it (see getToolResponseMetadata).
  var lastResultMeta = null;
  var receivedResultMeta = false;
  var lastObservedToolSurface = null;

  function rememberResultMeta(result) {
    receivedResultMeta = true;
    // Authority belongs to this result. A result without metadata grants no authority.
    lastResultMeta = result && typeof result === 'object' && result._meta && typeof result._meta === 'object'
      ? result._meta : null;
    lastObservedToolSurface = lastResultMeta && lastResultMeta['orgx/toolSurface'] || null;
  }

  function getToolResponseMetadata(key) {
    var meta = null;
    if (getProtocol() === 'chatgpt') {
      meta = global.openai && global.openai.toolResponseMetadata;
    } else {
      meta = receivedResultMeta ? lastResultMeta : (global.openai && global.openai.toolResponseMetadata);
    }
    if (!meta || typeof meta !== 'object') return null;
    return key ? (meta[key] === undefined ? null : meta[key]) : meta;
  }

  var WIDGET_TOOL_CHOICES = {
    operation_status: ['orgx_get_operation_status'],
    receipt_list: ['orgx_list_work_receipts'],
    receipt_detail: ['orgx_get_work_receipt'],
    workspace_select: ['orgx_widget_select_workspace'],
  };

  function getToolSurface() {
    var surface = lastObservedToolSurface || getToolResponseMetadata('orgx/toolSurface');
    if (!surface || surface.contract_version !== 'orgx-mcp-operations/1' ||
        !Array.isArray(surface.tools) || !surface.widget_tools || typeof surface.widget_tools !== 'object') return null;
    return surface;
  }

  // Metadata confirms that the connection imported the current operation.
  // Server scopes and signed tokens still decide authority.
  function getWidgetToolName(operation) {
    var choices = WIDGET_TOOL_CHOICES[operation];
    var surface = getToolSurface();
    if (!choices || !surface) return null;
    var name = surface.widget_tools[operation];
    return choices.indexOf(name) !== -1 && surface.tools.indexOf(name) !== -1 ? name : null;
  }

  function callWidgetRead(name, args) {
    var operation = ['operation_status', 'receipt_list', 'receipt_detail'].filter(function matches(key) {
      return WIDGET_TOOL_CHOICES[key][0] === name;
    })[0];
    if (!operation) return Promise.reject(hostUnavailableError(name));
    var surface = getToolSurface();
    if (surface && !getWidgetToolName(operation)) return Promise.reject(hostUnavailableError(operation));
    return callToolResultExact(name, args);
  }

  function callWidgetToolResult(name, args) {
    if (name !== 'orgx_widget_select_workspace') return Promise.reject(hostUnavailableError(name));
    var selected = getWidgetToolName('workspace_select');
    if (!selected) {
      var stale = new Error('Refresh the OrgX app in ChatGPT settings, then try again.');
      stale.code = 'tool_unavailable';
      return Promise.reject(stale);
    }
    var input = { workspace_id: args && args.workspace_id };
    // Choose the known contract before dispatch. A failed write is never retried as another tool.
    return callToolResultExact(selected, input);
  }

  var reportedSearchEvents = {};
  function reportSearchWidgetEvent(code) {
    if (['rendered', 'response_timeout', 'incomplete_response', 'tool_error', 'page_error'].indexOf(code) === -1 || reportedSearchEvents[code]) return;
    var meta = getToolResponseMetadata('orgx/widgetDiagnostics');
    if (!meta || typeof meta.grant !== 'string' || typeof meta.endpoint !== 'string' || !global.fetch) return;
    // Only the configured MCP origins may receive the scoped telemetry grant.
    if (!/^https:\/\/mcp(?:-staging)?\.useorgx\.com\/telemetry\/search-widget$/.test(meta.endpoint)) return;
    reportedSearchEvents[code] = true;
    global.fetch(meta.endpoint, {
      method: 'POST', credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant: meta.grant, code: code, protocol: getProtocol() }),
    }).catch(function () { /* reporting must not break search */ });
  }

  // Starts the host call; a synchronous throw from the host becomes a rejection.
  function attemptHostCall(start) {
    try {
      return Promise.resolve(start());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function callTool(name, args) {
    var call = resolveToolCall(name, args);
    var normalize = function normalize(error) { throw normalizeToolError(error, name); };
    var activeProtocol = getProtocol();
    if (activeProtocol === 'chatgpt' || (chatGptActionsFallback && (!bridge || !bridge.connected) && global.openai && global.openai.callTool)) {
      if (!global.openai || !global.openai.callTool) return Promise.reject(hostUnavailableError(name));
      return attemptHostCall(function () { return global.openai.callTool(call.name, call.args); })
        .then(rejectToolFailure)
        .catch(normalize);
    }
    if (activeProtocol === 'mcp-apps-sdk' || activeProtocol === 'mcp-apps') {
      return attemptHostCall(function () {
        return getBridge(activeProtocol === 'mcp-apps-sdk').callServerTool({
          name: call.name,
          arguments: call.args,
        });
      }).then(rejectToolFailure).catch(normalize);
    }
    return Promise.reject(hostUnavailableError(name));
  }

  // Like callTool, but resolves to { data, meta } so a widget can read the
  // widget-only result _meta (approval tokens) of a refresh it started.
  function callToolResult(name, args) {
    var call = resolveToolCall(name, args);
    return callToolResultExact(call.name, call.args, name);
  }

  function callToolResultExact(name, args, reportedName) {
    var call = { name: name, args: args || {} };
    var normalize = function normalize(error) { throw normalizeToolError(error, reportedName || name); };
    var activeProtocol = getProtocol();
    var finish = function finish(result) {
      rejectToolFailure(result);
      var meta = result && typeof result === 'object' && result._meta && typeof result._meta === 'object'
        ? result._meta
        : null;
      if (meta && meta['orgx/toolSurface']) lastObservedToolSurface = meta['orgx/toolSurface'];
      return { data: extractStructuredWidgetData(result, true), meta: meta };
    };
    if (activeProtocol === 'chatgpt') {
      if (!global.openai || !global.openai.callTool) return Promise.reject(hostUnavailableError(name));
      return attemptHostCall(function () { return global.openai.callTool(call.name, call.args); })
        .then(finish)
        .catch(normalize);
    }
    if (activeProtocol === 'mcp-apps-sdk' || activeProtocol === 'mcp-apps') {
      return attemptHostCall(function () {
        return getBridge(activeProtocol === 'mcp-apps-sdk').callServerToolRaw({
          name: call.name,
          arguments: call.args,
        });
      }).then(finish).catch(normalize);
    }
    return Promise.reject(hostUnavailableError(name));
  }

  // The connected MCP Apps App instance, or null (ChatGPT, legacy, standalone).
  function getApp() {
    return bridge && bridge.app && bridge.connected ? bridge.app : null;
  }

  function openWidgetLink(url, event) {
    if (!url) return false;
    var activeProtocol = getProtocol();
    if (activeProtocol === 'standalone') return true;
    if (event && event.preventDefault) event.preventDefault();
    if (activeProtocol === 'chatgpt') {
      if (global.openai && global.openai.openExternal) {
        global.openai.openExternal({ url: url });
      }
      return false;
    }
    getBridge(activeProtocol === 'mcp-apps-sdk').openLink(url).catch(function openFallback() {
      try {
        global.open(url, '_blank', 'noopener,noreferrer');
      } catch (_) {
        // The host owns link recovery inside the sandbox.
      }
    });
    return false;
  }

  function updateModelContext(payload) {
    var activeProtocol = getProtocol();
    if (activeProtocol === 'chatgpt') {
      if (global.openai && global.openai.updateModelContext) {
        return Promise.resolve(global.openai.updateModelContext(payload));
      }
      return Promise.resolve(null);
    }
    if (activeProtocol === 'mcp-apps-sdk' || activeProtocol === 'mcp-apps') {
      return getBridge(activeProtocol === 'mcp-apps-sdk').updateModelContext(payload);
    }
    return Promise.resolve(null);
  }

  function getWidgetSessionId() {
    if (global.openai && global.openai.widgetSessionId) {
      return global.openai.widgetSessionId;
    }
    if (bridge && bridge.getHostContext) {
      var context = bridge.getHostContext();
      return context && (context.widgetSessionId || context.sessionId) || null;
    }
    return null;
  }

  function persistWidgetState(state) {
    if (global.openai && global.openai.setWidgetState) {
      return Promise.resolve(global.openai.setWidgetState(state));
    }
    return Promise.resolve(null);
  }

  function sendFollowUpMessage(prompt) {
    if (global.openai && global.openai.sendFollowUpMessage) {
      return Promise.resolve(global.openai.sendFollowUpMessage({ prompt: prompt }));
    }
    return Promise.resolve(null);
  }

  function requestDisplayMode(mode) {
    var activeProtocol = getProtocol();
    if (activeProtocol === 'chatgpt') {
      if (global.openai && global.openai.requestDisplayMode) {
        return Promise.resolve(global.openai.requestDisplayMode({ mode: mode }));
      }
      return Promise.resolve(null);
    }
    if (activeProtocol === 'mcp-apps-sdk' || activeProtocol === 'mcp-apps') {
      return getBridge(activeProtocol === 'mcp-apps-sdk').requestDisplayMode(mode);
    }
    return Promise.resolve(null);
  }

  /* ------------------------------------------------------------ time -- */
  /*
   * One formatter for every time a widget shows. Absolute times and dates use
   * the viewer's locale (ChatGPT's window.openai.locale, then the MCP Apps
   * host context, then navigator.language) and the browser's time zone (or the
   * host's), so en-US reads "5:05 PM" and en-GB / de-DE read "17:05".
   * Relative phrases ("2m ago", "Yesterday") follow the widgets' UI language,
   * English, so a sentence never mixes two languages.
   */
  var MINUTE = 60000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;
  var formatterCache = {};

  function viewerLocale() {
    var candidates = [
      global.openai && global.openai.locale,
      hostLocale,
      global.navigator && global.navigator.language,
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (typeof value !== 'string' || !value) continue;
      try {
        // Validate: an unsupported tag throws; "en_US" style is normalized.
        return Intl.getCanonicalLocales(value.replace(/_/g, '-'))[0];
      } catch (_) {
        // Try the next source.
      }
    }
    return 'en-US';
  }

  function viewerTimeZone() {
    if (hostTimeZone) return hostTimeZone;
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch (_) {
      return undefined;
    }
  }

  function dateFormatter(options) {
    var locale = viewerLocale();
    var zone = viewerTimeZone();
    var key = locale + '|' + zone + '|' + JSON.stringify(options);
    if (!formatterCache[key]) {
      var resolved = Object.assign({}, options);
      if (zone) resolved.timeZone = zone;
      try {
        formatterCache[key] = new Intl.DateTimeFormat(locale, resolved);
      } catch (_) {
        delete resolved.timeZone;
        formatterCache[key] = new Intl.DateTimeFormat(locale, resolved);
      }
    }
    return formatterCache[key];
  }

  /** Date, epoch ms (or seconds), ISO string -> Date; null when unparseable. */
  function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    var date;
    if (value instanceof Date) date = new Date(value.getTime());
    else if (typeof value === 'number') date = new Date(value < 1e11 ? value * 1000 : value);
    else if (typeof value === 'string') date = new Date(/^\d+$/.test(value) ? Number(value) : value);
    else return null;
    return Number.isFinite(date.getTime()) ? date : null;
  }

  /** The calendar day (in the viewer's zone) as YYYY-MM-DD, for day comparisons. */
  function dayKey(date) {
    var parts = dateFormatter({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    var get = function (type) {
      for (var i = 0; i < parts.length; i += 1) if (parts[i].type === type) return parts[i].value;
      return '';
    };
    return get('year') + '-' + get('month') + '-' + get('day');
  }

  function daysBetween(date, now) {
    var a = dayKey(date).split('-');
    var b = dayKey(now).split('-');
    return Math.round((Date.UTC(+b[0], +b[1] - 1, +b[2]) - Date.UTC(+a[0], +a[1] - 1, +a[2])) / DAY);
  }

  function nowDate(options) {
    return (options && toDate(options.now)) || new Date();
  }

  /** "5:05 PM" (en-US), "17:05" (en-GB, de-DE). */
  function formatClock(value) {
    var date = toDate(value);
    if (!date) return '';
    // 24-hour locales pad the hour ("09:30"); 12-hour ones do not ("9:30 AM").
    var cycle = dateFormatter({ hour: 'numeric', minute: '2-digit' }).resolvedOptions().hourCycle;
    var hour = cycle === 'h23' || cycle === 'h24' ? '2-digit' : 'numeric';
    return dateFormatter({ hour: hour, minute: '2-digit' }).format(date);
  }

  /** "Oct 2" (this year), "Oct 2, 2025" (other years); "2 Oct", "2. Okt." in other locales. */
  function formatDay(value, options) {
    var date = toDate(value);
    if (!date) return '';
    var sameYear = dayKey(date).slice(0, 4) === dayKey(nowDate(options)).slice(0, 4);
    return dateFormatter(sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }

  /**
   * Absolute, as short as reads unambiguously: today "5:05 PM", yesterday
   * "Yesterday, 5:05 PM", this year "Oct 2, 5:05 PM", older "Oct 2, 2025".
   */
  function formatWhen(value, options) {
    var date = toDate(value);
    if (!date) return '';
    var now = nowDate(options);
    var days = daysBetween(date, now);
    if (days === 0) return formatClock(date);
    if (days === 1) return 'Yesterday, ' + formatClock(date);
    if (dayKey(date).slice(0, 4) !== dayKey(now).slice(0, 4)) return formatDay(date, options);
    return formatDay(date, options) + ', ' + formatClock(date);
  }

  /**
   * Relative: "Just now", "2m ago", "3h ago", "Yesterday", "4d ago", then the
   * date ("Oct 2"). Future times read "in 5m", "Tomorrow", "in 3d".
   * options.inline lower-cases a leading word for mid-sentence use
   * ("updated yesterday"); options.now pins the clock (tests).
   */
  function formatRelative(value, options) {
    var date = toDate(value);
    if (!date) return '';
    var now = nowDate(options);
    var diff = now.getTime() - date.getTime();
    var future = diff < 0;
    var abs = Math.abs(diff);
    var days = daysBetween(date, now);
    var text;
    if (abs < 45 * 1000) text = 'Just now';
    else if (abs < HOUR) text = unit(Math.max(1, Math.round(abs / MINUTE)), 'm', future);
    else if (abs < DAY && (days === 0 || abs < 6 * HOUR)) text = unit(Math.round(abs / HOUR), 'h', future);
    else if (days === 1) text = 'Yesterday';
    else if (days === -1) text = 'Tomorrow';
    else if (Math.abs(days) < 7) text = unit(Math.abs(days), 'd', future);
    else text = formatDay(date, options);
    if (options && options.inline && /^(Just|Yesterday|Tomorrow)/.test(text)) {
      text = text.charAt(0).toLowerCase() + text.slice(1);
    }
    return text;
  }

  function unit(count, suffix, future) {
    return future ? 'in ' + count + suffix : count + suffix + ' ago';
  }

  /** Full date and time for title attributes and screen readers. */
  function formatFull(value) {
    var date = toDate(value);
    return date
      ? dateFormatter({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date)
      : '';
  }

  /** "synced just now", "synced 4m ago", "synced 5:05 PM", "synced yesterday, 5:05 PM". */
  function formatSynced(value, options) {
    var date = toDate(value);
    if (!date) return '';
    var age = nowDate(options).getTime() - date.getTime();
    var label = age >= 0 && age < HOUR ? formatRelative(date, Object.assign({}, options, { inline: true })) : formatWhen(date, options);
    return 'synced ' + (/^Yesterday/.test(label) ? 'y' + label.slice(1) : label);
  }

  /**
   * <time datetime title> markup. mode: "relative" (default), "when",
   * "clock", "day" or "synced". The title carries the full local date and time.
   */
  function timeHtml(value, mode, options) {
    var date = toDate(value);
    if (!date) return '';
    var fns = { relative: formatRelative, when: formatWhen, clock: formatClock, day: formatDay, synced: formatSynced };
    var label = (fns[mode] || formatRelative)(date, options);
    return '<time datetime="' + date.toISOString() + '" title="' + escapeAttr(formatFull(date)) + '">' + escapeAttr(label) + '</time>';
  }

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return '&#' + c.charCodeAt(0) + ';';
    });
  }

  var time = {
    locale: viewerLocale,
    timeZone: viewerTimeZone,
    toDate: toDate,
    clock: formatClock,
    day: formatDay,
    when: formatWhen,
    relative: formatRelative,
    synced: formatSynced,
    full: formatFull,
    html: timeHtml,
  };

  /* ----------------------------------------------------------- links -- */
  /*
   * One link builder for every OrgX URL a widget shows. Every output matches a
   * real route in the OrgX app (tests/widgetLinks.spec.ts checks each against
   * tests/fixtures/orgx-app-routes.json, generated from the app tree by
   * scripts/generate-app-routes.mjs). Base: https://useorgx.com (ORGX_ORIGIN).
   */
  var ORGX_ORIGIN = 'https://useorgx.com';
  var LINK_ORIGINS = ['https://useorgx.com', 'https://www.useorgx.com', 'https://mcp.useorgx.com'];
  var AGENT_SLUGS = ['pace', 'eli', 'mark', 'sage', 'orion', 'dana', 'xandy'];

  function cleanId(value) {
    if (value === null || value === undefined) return '';
    var text = String(value).trim();
    return text && text !== 'undefined' && text !== 'null' ? text : '';
  }

  function orgxUrl(path, query) {
    var url = ORGX_ORIGIN + path;
    var parts = [];
    if (query) {
      Object.keys(query).forEach(function (key) {
        var value = cleanId(query[key]);
        if (value) parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      });
    }
    return parts.length ? url + '?' + parts.join('&') : url;
  }

  function seg(id) {
    return encodeURIComponent(cleanId(id));
  }

  function agentSlug(value) {
    var identity = global.OrgXAgentIdentity;
    var key = identity && identity.resolveAgentKey ? identity.resolveAgentKey(value) : null;
    if (key) return key;
    var slug = cleanId(value).toLowerCase();
    return AGENT_SLUGS.indexOf(slug) !== -1 ? slug : '';
  }

  var links = {
    origin: ORGX_ORIGIN,
    /** Command: what needs you now (optionally in a workspace). */
    command: function (options) {
      return orgxUrl('/command', { center: options && options.center });
    },
    /** A goal (objective) on the goals page. */
    goal: function (id, options) {
      return orgxUrl('/goals', { objective: id, center: options && options.center });
    },
    /** Initiative detail; no id -> the initiatives index. */
    initiative: function (id) {
      return cleanId(id) ? orgxUrl('/initiatives/' + seg(id)) : orgxUrl('/initiatives');
    },
    /**
     * Live view. With an initiative: its execution room, optionally focused on
     * a workstream, task, decision or artifact. Without one there is no live
     * room to open: the legacy mission-control view is built around a single
     * initiative and renders an empty graph. So the focus picks its own page
     * (task, run, workstream, milestone) and otherwise Runs, which lists what
     * needs you, what is running and what finished across the workspace.
     */
    live: function (initiativeId, focus) {
      focus = focus || {};
      if (cleanId(initiativeId)) {
        return orgxUrl('/live/' + seg(initiativeId), {
          workstream: focus.workstream,
          task: focus.task,
          decision: focus.decision,
          artifact: focus.artifact,
        });
      }
      if (cleanId(focus.task)) return orgxUrl('/tasks/' + seg(focus.task));
      if (cleanId(focus.run)) return orgxUrl('/runs/' + seg(focus.run));
      if (cleanId(focus.workstream)) return orgxUrl('/workstreams/' + seg(focus.workstream));
      if (cleanId(focus.milestone)) return orgxUrl('/milestones/' + seg(focus.milestone));
      return orgxUrl('/runs');
    },
    /** In the initiative's live room when known, else the workstream page. */
    workstream: function (id, options) {
      if (!cleanId(id)) return links.live(options && options.initiativeId);
      if (options && cleanId(options.initiativeId)) return links.live(options.initiativeId, { workstream: id });
      return orgxUrl('/workstreams/' + seg(id));
    },
    /** The milestone page (the live room has no milestone focus). */
    milestone: function (id) {
      return cleanId(id) ? orgxUrl('/milestones/' + seg(id)) : orgxUrl('/initiatives');
    },
    /** In the initiative's live room when known, else the task page. */
    task: function (id, options) {
      if (!cleanId(id)) return links.live(options && options.initiativeId);
      if (options && cleanId(options.initiativeId)) return links.live(options.initiativeId, { task: id });
      return orgxUrl('/tasks/' + seg(id));
    },
    /** The decision page; no id -> the decisions queue (pending by default). */
    decision: function (id) {
      return cleanId(id) ? orgxUrl('/decisions/' + seg(id)) : links.decisions();
    },
    decisions: function (options) {
      return orgxUrl('/decisions', { status: (options && options.status) || 'pending' });
    },
    artifact: function (id) {
      return cleanId(id) ? orgxUrl('/artifacts/' + seg(id)) : orgxUrl('/workspace-hub');
    },
    run: function (id) {
      return cleanId(id) ? orgxUrl('/runs/' + seg(id)) : orgxUrl('/runs');
    },
    /** The agent's desk (/command/agents/eli); unknown agents -> the roster. */
    agent: function (keyOrName) {
      var slug = agentSlug(keyOrName);
      return slug ? orgxUrl('/command/agents/' + slug) : orgxUrl('/command/agents');
    },
    /**
     * OrgX has no plan-session page. A plan with an initiative opens that
     * initiative; otherwise mission control carries the session id.
     */
    planSession: function (id, options) {
      if (options && cleanId(options.initiativeId)) return links.initiative(options.initiativeId);
      return links.live(null, { session: id });
    },
    /**
     * OrgX has no search page: decisions search in the decisions queue,
     * everything else opens Command (its palette searches the workspace).
     */
    search: function (query, options) {
      var type = options && options.type;
      if (type === 'decision' && cleanId(query)) return orgxUrl('/decisions', { status: 'all', search: query });
      return links.command();
    },
    /**
     * The work ledger for a workspace and window. Without `center` the page
     * falls back to the browser's active workspace and a 30-day window, which
     * need not be what the widget showed.
     */
    workLedger: function (options) {
      return orgxUrl('/work-ledger', { center: options && options.center, range: options && options.range });
    },
    /** Dispatch on an entity type ("task", "Workstream", "agent_run", ...). */
    entity: function (type, id, options) {
      var kind = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
      switch (kind) {
        case 'initiative':
          return links.initiative(id);
        case 'objective':
        case 'goal':
          return links.goal(id, options);
        case 'workspace':
        case 'command_center':
          return links.command({ center: id });
        case 'workstream':
          return links.workstream(id, options);
        case 'milestone':
          return links.milestone(id);
        case 'task':
          return links.task(id, options);
        case 'decision':
          return links.decision(id);
        case 'artifact':
          return links.artifact(id);
        case 'run':
        case 'agent_run':
          return links.run(id);
        case 'agent':
          return links.agent(id);
        case 'plan':
        case 'plan_session':
          return links.planSession(id, options);
        default:
          return options && cleanId(options.initiativeId) ? links.live(options.initiativeId) : links.command();
      }
    },
    normalize: normalizeLink,
    open: function (url, event) {
      var target = normalizeLink(url);
      if (!target) {
        if (event && event.preventDefault) event.preventDefault();
        return false;
      }
      return openWidgetLink(target, event);
    },
    /** href/target/rel attributes for an <a> fallback that the runtime routes through the host. */
    attrs: function (url) {
      var target = normalizeLink(url);
      return target
        ? 'href="' + escapeAttr(target) + '" target="_blank" rel="noopener noreferrer" data-ox-link'
        : '';
    },
  };

  /**
   * Make a server- or payload-provided URL safe and current: relative OrgX
   * paths resolve against useorgx.com; only OrgX origins (and GitHub) pass;
   * legacy shapes that no longer reach the right page are rewritten
   * (/settings/agents?agent=, /planning/sessions/, /agents/runs/,
   * /initiatives/:id?focus=decisions&decision=, /live/:id?milestone= and
   * ?artifactId=). Returns '' for anything else.
   */
  function normalizeLink(url) {
    var raw = cleanId(url);
    if (!raw) return '';
    var parsed;
    try {
      if (/^\/[^/\\]/.test(raw)) parsed = new URL(raw, ORGX_ORIGIN);
      else parsed = new URL(raw);
    } catch (_) {
      return '';
    }
    if (parsed.protocol !== 'https:') return '';
    if (parsed.origin === 'https://github.com') return parsed.toString();
    if (LINK_ORIGINS.indexOf(parsed.origin) === -1) return '';
    if (parsed.origin === 'https://mcp.useorgx.com') return parsed.toString();
    var path = parsed.pathname.replace(/\/+$/, '') || '/';
    var q = parsed.searchParams;
    var match;
    if (path === '/settings/agents') return links.agent(q.get('agent'));
    if ((match = path.match(/^\/planning\/sessions\/([^/]+)$/))) return links.planSession(decodeURIComponent(match[1]));
    if (path === '/planning') return links.live();
    if ((match = path.match(/^\/agents\/runs\/([^/]+)$/))) return links.run(decodeURIComponent(match[1]));
    if ((match = path.match(/^\/initiatives\/([^/]+)$/)) && q.get('decision')) return links.decision(q.get('decision'));
    if ((match = path.match(/^\/live\/([^/]+)$/))) {
      if (q.get('milestone')) return links.milestone(q.get('milestone'));
      if (q.get('artifactId')) return links.artifact(q.get('artifactId'));
    }
    return ORGX_ORIGIN + path + (parsed.search || '') + (parsed.hash || '');
  }

  // Anchors marked data-ox-link (links.attrs) and <ox-agent-card> "Open in
  // OrgX" links open through the host: window.openai.openExternal in ChatGPT,
  // ui/open-link in MCP Apps hosts; the plain <a> is the standalone fallback.
  // The installed runtime (one per page; tests may reinstall it).
  function currentRuntime() {
    return global.OrgXWidgetRuntime || { links: links, openWidgetLink: openWidgetLink };
  }
  if (global.document && !global.document.__oxLinks) {
    global.document.__oxLinks = 1;
    global.document.addEventListener('click', function onLinkClick(event) {
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey) return;
      var anchor = event.target && event.target.closest ? event.target.closest('a[data-ox-link]') : null;
      if (anchor) currentRuntime().links.open(anchor.getAttribute('href'), event);
    });
    global.document.addEventListener('ox-open', function onCardOpen(event) {
      // A widget that routes ox-open itself (and cancels it) has handled it.
      if (event.defaultPrevented) return;
      var href = event.detail && event.detail.href;
      if (!href) return;
      var rt = currentRuntime();
      var target = rt.links.normalize(href);
      if (!target) {
        event.preventDefault();
        return;
      }
      if (rt.openWidgetLink(target, event) === false) event.preventDefault();
    });
  }

  /* ---------------------------------------------------------- motion -- */
  /*
   * Expand / collapse without layout jank: the panel animates height and
   * opacity (Web Animations, compositor-friendly opacity, one height
   * animation) and ends on `hidden` so collapsed content leaves the
   * accessibility tree and the tab order. Reduced motion, or no Web
   * Animations, switches instantly. The trigger's aria-expanded follows.
   */
  function prefersReducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  function setExpanded(panel, open, trigger) {
    if (!panel) return Promise.resolve();
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.setAttribute('data-ox-expanded', open ? 'true' : 'false');
    var running = panel.__oxExpand;
    if (running) running.cancel();
    var isOpen = !panel.hidden;
    if (isOpen === !!open && !running) return Promise.resolve();
    if (prefersReducedMotion() || typeof panel.animate !== 'function') {
      panel.hidden = !open;
      reportSize();
      return Promise.resolve();
    }
    var from = panel.hidden ? 0 : panel.getBoundingClientRect().height;
    panel.hidden = false;
    var to = open ? panel.scrollHeight : 0;
    var previousOverflow = panel.style.overflow;
    panel.style.overflow = 'hidden';
    var animation = panel.animate(
      [
        { height: from + 'px', opacity: open ? 0 : 1 },
        { height: to + 'px', opacity: open ? 1 : 0 },
      ],
      { duration: Math.min(320, 160 + Math.abs(to - from) * 0.25), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
    panel.__oxExpand = animation;
    return new Promise(function settle(resolve) {
      var done = function (finished) {
        if (panel.__oxExpand === animation) panel.__oxExpand = null;
        panel.style.overflow = previousOverflow;
        if (finished && !open) panel.hidden = true;
        reportSize();
        resolve();
      };
      animation.onfinish = function () { done(true); };
      animation.oncancel = function () { done(false); };
    });
  }

  /** Toggle a disclosure: the panel is document.getElementById(trigger's aria-controls) unless given. */
  function toggleExpanded(trigger, panel) {
    var target = panel || (trigger && global.document.getElementById(trigger.getAttribute('aria-controls') || ''));
    var open = trigger ? trigger.getAttribute('aria-expanded') !== 'true' : !!(target && target.hidden);
    return setExpanded(target, open, trigger);
  }

  /*
   * Clamp / unclamp a block that shows a max-height preview ("Show full
   * section", "All evidence"): the height animates from the clamped preview to
   * the full content and back instead of snapping, and reduced motion (or no
   * Web Animations) switches instantly. The element carries
   * data-ox-clamped="true|false" for the widget's CSS (a fade, a max-height);
   * options:
   *   expandedClass  class toggled on while unclamped (for existing CSS)
   *   max            clamp height in px, set inline while clamped
   *   beyond         elements past the clamp: inert and hidden from assistive
   *                  tech while clamped, so the preview's tab order is honest
   *   instant        apply without animating (first render, re-render)
   * The trigger's aria-expanded follows (expanded = not clamped).
   */
  function setClamped(element, clamped, trigger, options) {
    if (!element) return Promise.resolve();
    var o = options || {};
    clamped = !!clamped;
    if (trigger) trigger.setAttribute('aria-expanded', clamped ? 'false' : 'true');
    var running = element.__oxClamp;
    if (running) running.cancel();
    var from = element.getBoundingClientRect().height;
    element.setAttribute('data-ox-clamped', clamped ? 'true' : 'false');
    if (o.expandedClass) element.classList.toggle(o.expandedClass, !clamped);
    if (o.max != null) element.style.maxHeight = clamped ? Number(o.max) + 'px' : '';
    Array.prototype.forEach.call(o.beyond || [], function hide(item) {
      if (clamped) {
        item.setAttribute('inert', '');
        item.setAttribute('aria-hidden', 'true');
      } else {
        item.removeAttribute('inert');
        item.removeAttribute('aria-hidden');
      }
    });
    var to = element.getBoundingClientRect().height;
    if (o.instant || prefersReducedMotion() || typeof element.animate !== 'function' || Math.abs(to - from) < 1) {
      reportSize();
      return Promise.resolve();
    }
    var previousOverflow = element.style.overflow;
    element.style.overflow = 'hidden';
    // max-height: none during the animation, so a CSS clamp can't cut it short.
    var animation = element.animate(
      [
        { height: from + 'px', maxHeight: 'none' },
        { height: to + 'px', maxHeight: 'none' },
      ],
      { duration: Math.min(320, 160 + Math.abs(to - from) * 0.25), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
    element.__oxClamp = animation;
    return new Promise(function settle(resolve) {
      var done = function () {
        if (element.__oxClamp === animation) element.__oxClamp = null;
        element.style.overflow = previousOverflow;
        reportSize();
        resolve();
      };
      animation.onfinish = done;
      animation.oncancel = done;
    });
  }

  /** Cross-fade a container's state change (loading -> loaded, pending -> settled). */
  function enterState(element) {
    if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return;
    element.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], {
      duration: 180,
      easing: 'ease-out',
    });
  }

  var motion = {
    reduced: prefersReducedMotion,
    setExpanded: setExpanded,
    setClamped: setClamped,
    toggle: toggleExpanded,
    enter: enterState,
  };

  function resetForTests() {
    if (bridge && bridge.destroy) bridge.destroy();
    bridge = null;
    protocol = null;
    lastResultMeta = null;
    receivedResultMeta = false;
    lastObservedToolSurface = null;
    hostLocale = null;
    hostTimeZone = null;
    formatterCache = {};
    hostContextListeners = [];
    toolInputListeners = [];
    toolCallState = { inputSeen: false, resultSeen: false, inputAt: null, resultAt: null };
    reportedSearchEvents = {};
  }

  var runtime = {
    LegacyBridge: LegacyBridge,
    McpAppsSDKBridge: McpAppsSDKBridge,
    callTool: callTool,
    callToolResult: callToolResult,
    callWidgetRead: callWidgetRead,
    callWidgetToolResult: callWidgetToolResult,
    detectProtocol: detectProtocol,
    applyTheme: applyTheme,
    extractStructuredWidgetData: extractStructuredWidgetData,
    extractSearchWidgetData: extractSearchWidgetData,
    extractResultTimestamp: extractResultTimestamp,
    extractLifecycleRank: extractLifecycleRank,
    getApp: getApp,
    getErrorMessage: getErrorMessage,
    normalizeToolError: normalizeToolError,
    TOOL_ERROR_CODES: TOOL_ERROR_CODES.slice(),
    TOOL_ALIASES: TOOL_ALIASES,
    getTheme: getTheme,
    getToolResponseMetadata: getToolResponseMetadata,
    getToolSurface: getToolSurface,
    getWidgetToolName: getWidgetToolName,
    getToolCallState: getToolCallState,
    getWidgetSessionId: getWidgetSessionId,
    initWidget: initWidget,
    openWidgetLink: openWidgetLink,
    persistWidgetState: persistWidgetState,
    reportSize: reportSize,
    reportSearchWidgetEvent: reportSearchWidgetEvent,
    requestDisplayMode: requestDisplayMode,
    sendFollowUpMessage: sendFollowUpMessage,
    updateModelContext: updateModelContext,
    time: time,
    links: links,
    motion: motion,
    __resetForTests: resetForTests,
  };

  global.OrgXWidgetRuntime = runtime;
  global.callTool = callTool;
  global.initWidget = initWidget;
  global.openWidgetLink = openWidgetLink;
  global.OrgXTime = time;
  global.OrgXLinks = links;
})(window);
