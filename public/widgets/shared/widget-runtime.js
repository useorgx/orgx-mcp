(function installOrgXWidgetRuntime(global) {
  'use strict';

  if (global.OrgXWidgetRuntime) return;

  var protocol = null;
  var bridge = null;
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
    if (result && result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    if (result && Array.isArray(result.content)) {
      for (var index = 0; index < result.content.length; index += 1) {
        var item = result.content[index];
        if (!item || item.type !== 'text' || !item.text) continue;
        try {
          return JSON.parse(item.text);
        } catch (_) {
          if (plainTextObject) return { text: item.text };
        }
      }
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

  function createResultGate() {
    var newestObservedAt = null;
    var newestLifecycleRank = 0;
    var arrival = 0;
    return {
      accept: function accept(raw) {
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
      return extractStructuredWidgetData(result, true);
    });
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
      if (data.error) pending.reject(new Error(getErrorMessage(data.error, 'Host request failed')));
      else pending.resolve(data.result);
      return;
    }
    if (
      (data.method === 'ui/notifications/tool-result' ||
        data.method === 'notifications/message') &&
      data.params &&
      this.toolResultCallback
    ) {
      this.toolResultCallback(extractStructuredWidgetData(data.params));
    }
  };

  LegacyBridge.prototype.destroy = function destroy() {
    global.removeEventListener('message', this.handleMessage);
  };

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
    this.app.ontoolresult = function onToolResult(result) {
      if (self.toolResultCallback) {
        self.toolResultCallback(extractStructuredWidgetData(result));
      }
    };
    this.app.onhostcontextchanged = applyHostContext;
    await this.app.connect();
    this.connected = true;
    try {
      applyHostContext(this.app.getHostContext());
    } catch (_) {
      // Host context is optional.
    }
  };

  McpAppsSDKBridge.prototype.callServerTool = async function callServerTool(params) {
    await this.connect();
    var result = await this.app.callServerTool(params);
    return extractStructuredWidgetData(result, true);
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

  function initWidget(options) {
    var render = options.render;
    var getData = options.getData || extractStructuredWidgetData;
    var currentData = null;
    var resultGate = createResultGate();
    var activeProtocol = getProtocol();
    document.documentElement.setAttribute('data-protocol', activeProtocol);

    if (activeProtocol === 'chatgpt') {
      applyTheme(global.openai && global.openai.theme, 'host');
      var initialOutput = global.openai && global.openai.toolOutput;
      if (initialOutput !== null && initialOutput !== undefined && resultGate.accept(initialOutput)) {
        currentData = getData(initialOutput);
      }
      render(currentData);
      observeChatGPTSize();
      global.addEventListener(
        'openai:set_globals',
        function onOpenAIGlobals(event) {
          var globals = event.detail && event.detail.globals;
          if (!globals) return;
          if (globals.theme !== undefined) applyTheme(globals.theme, 'host');
          if (globals.toolOutput === undefined) return;
          if (!resultGate.accept(globals.toolOutput)) return;
          // A host may briefly publish null while it rehydrates. Keep the
          // last known result visible instead of replacing it with an empty
          // or loading-looking card.
          if (globals.toolOutput !== null || currentData === null) {
            currentData = getData(globals.toolOutput);
            render(currentData);
          }
          reportSize();
        },
        { passive: true }
      );
    } else if (activeProtocol === 'mcp-apps-sdk' || activeProtocol === 'mcp-apps') {
      render(null);
      var activeBridge = getBridge(activeProtocol === 'mcp-apps-sdk');
      activeBridge.toolResultCallback = function onToolResult(result) {
        if (!resultGate.accept(result)) return;
        currentData = getData(result);
        render(currentData);
      };
      activeBridge.connect().catch(function onConnectionFailure(error) {
        console.error('[OrgX Widget] Host connection failed:', error);
      });
    } else {
      render(null);
    }

    return { getData: function getCurrentData() { return currentData; } };
  }

  function callTool(name, args) {
    var activeProtocol = getProtocol();
    if (activeProtocol === 'chatgpt') {
      if (!global.openai || !global.openai.callTool) return Promise.resolve(null);
      return global.openai.callTool(name, args || {});
    }
    if (activeProtocol === 'mcp-apps-sdk' || activeProtocol === 'mcp-apps') {
      return getBridge(activeProtocol === 'mcp-apps-sdk').callServerTool({
        name: name,
        arguments: args || {},
      });
    }
    return Promise.resolve(null);
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

  function resetForTests() {
    if (bridge && bridge.destroy) bridge.destroy();
    bridge = null;
    protocol = null;
  }

  var runtime = {
    LegacyBridge: LegacyBridge,
    McpAppsSDKBridge: McpAppsSDKBridge,
    callTool: callTool,
    detectProtocol: detectProtocol,
    applyTheme: applyTheme,
    extractStructuredWidgetData: extractStructuredWidgetData,
    extractResultTimestamp: extractResultTimestamp,
    extractLifecycleRank: extractLifecycleRank,
    getErrorMessage: getErrorMessage,
    getTheme: getTheme,
    getWidgetSessionId: getWidgetSessionId,
    initWidget: initWidget,
    openWidgetLink: openWidgetLink,
    persistWidgetState: persistWidgetState,
    reportSize: reportSize,
    requestDisplayMode: requestDisplayMode,
    sendFollowUpMessage: sendFollowUpMessage,
    updateModelContext: updateModelContext,
    __resetForTests: resetForTests,
  };

  global.OrgXWidgetRuntime = runtime;
  global.callTool = callTool;
  global.initWidget = initWidget;
  global.openWidgetLink = openWidgetLink;
})(window);
