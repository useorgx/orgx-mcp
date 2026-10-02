/*
 * OrgX shim for the OpenAI MCP Apps extensions the panel uses.
 *
 * Source: @openai/mcp-extensions 0.1.0 (dist/app/deep-link.js,
 * dist/app/model-context.js, dist/app/extensions.js). That package needs
 * @modelcontextprotocol/ext-apps ^1.7.5; this repo pins 1.1.2, so instead of
 * depending on it this file speaks the same wire contract over the App the
 * shared runtime already connects:
 *
 * - Deep links: the host puts `openai/deepLink` in the MCP Apps host context,
 *   either `{ url }` or the older `{ path: string[], query: [k, v][] }`
 *   (normalized to `/a/b?k=v`, as the package does). Read on connect and on
 *   every host-context change.
 * - Model context: the host advertises `openai/modelContext` under
 *   hostCapabilities.experimental (the package's check). ext-apps 1.1.2 strips
 *   unknown experimental keys while parsing ui/initialize, so this file also
 *   reads the raw initialize result from the message channel, and accepts the
 *   standard `hostCapabilities.updateModelContext` capability. Updates use the
 *   standard `ui/update-model-context` request (App.updateModelContext); the
 *   result `_meta['openai/modelContext'].updateId` identifies the update. The
 *   current shared context is `openai/modelContext` in the host context:
 *   `{ content?, structuredContent?, updateId } | null`.
 *
 * Every capability is undefined when the host does not offer it; callers
 * render the matching control only when it is defined, never disabled.
 *
 * Model context is written only by ShareController.share() / stop(), which
 * the panel calls from a click. Nothing here writes on load, refresh or
 * restore.
 */
(function installOrgXOpenAIExtensions(global) {
  'use strict';

  if (global.OrgXOpenAIExtensions) return;

  var DEEP_LINK_KEY = 'openai/deepLink';
  var MODEL_CONTEXT_KEY = 'openai/modelContext';
  var UPDATE_MODEL_CONTEXT_METHOD = 'ui/update-model-context';
  var SELECTION_SCHEMA = 'orgx.selection.v1';
  var ALLOWED_ORIGINS = ['https://useorgx.com', 'https://www.useorgx.com'];
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var TITLE_MAX = 120;
  var URGENCIES = ['low', 'medium', 'high', 'critical'];

  // --- Raw host capabilities -------------------------------------------------
  // Captured from the ui/initialize response before the SDK parses (and
  // strips) it. Only the parent window is trusted.
  var rawHostCapabilities = null;

  function onMessage(event) {
    if (!event || event.source !== global.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;
    var result = data.result;
    if (result && typeof result === 'object' && result.hostCapabilities && typeof result.hostCapabilities === 'object') {
      rawHostCapabilities = result.hostCapabilities;
    }
  }

  if (global.addEventListener && global.parent && global.parent !== global) {
    global.addEventListener('message', onMessage);
  }

  function getRawHostCapabilities() {
    return rawHostCapabilities;
  }

  // --- Deep links -------------------------------------------------------------

  function normalizeDeepLinkState(state) {
    if (!state || typeof state !== 'object') return undefined;
    if (typeof state.url === 'string') return { url: state.url };
    if (Array.isArray(state.path) && Array.isArray(state.query)) {
      var path = state.path.filter(function isString(part) { return typeof part === 'string'; });
      var search = new URLSearchParams(
        state.query.filter(function isPair(pair) {
          return Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string';
        })
      ).toString();
      return { url: '/' + path.map(encodeURIComponent).join('/') + (search ? '?' + search : '') };
    }
    return undefined;
  }

  /**
   * Allowlist (docs/design/devday-plugin-extensions.md §4.2):
   *   origin exactly https://useorgx.com or https://www.useorgx.com, and path
   *   /decisions/{uuid}, /initiatives/{uuid}?decision={uuid} or /live/{uuid}.
   * A host-relative path ("/decisions/{uuid}") resolves against
   * https://useorgx.com; protocol-relative and every other form is rejected.
   * Returns { type, id, initiativeId? } or null (caller falls back silently).
   */
  function parsePanelDeepLink(raw) {
    if (typeof raw !== 'string') return null;
    var text = raw.trim();
    if (!text || text.length > 2048) return null;
    var url;
    try {
      if (text.charAt(0) === '/') {
        if (text.charAt(1) === '/' || text.charAt(1) === '\\') return null;
        url = new URL(text, ALLOWED_ORIGINS[0]);
      } else {
        url = new URL(text);
      }
    } catch (_) {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (ALLOWED_ORIGINS.indexOf(url.origin) === -1) return null;

    var segments = url.pathname.split('/');
    if (segments.length !== 3 || segments[0] !== '') return null;
    var kind = segments[1];
    var id = segments[2];
    if (!UUID_RE.test(id)) return null;
    id = id.toLowerCase();
    var decisionParams = url.searchParams.getAll('decision');

    if (kind === 'decisions') {
      if (decisionParams.length) return null;
      return { type: 'decision', id: id };
    }
    if (kind === 'initiatives') {
      if (decisionParams.length !== 1 || !UUID_RE.test(decisionParams[0])) return null;
      return { type: 'decision', id: decisionParams[0].toLowerCase(), initiativeId: id };
    }
    if (kind === 'live') {
      if (decisionParams.length) return null;
      return { type: 'initiative', id: id };
    }
    return null;
  }

  // --- Selection payloads (Share with chat) ------------------------------------

  function clip(value, max) {
    var text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/"/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    var chars = Array.from(text);
    if (chars.length <= max) return text;
    return chars.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…';
  }

  function canonicalUrl(value) {
    if (typeof value !== 'string' || value.trim().charAt(0) === '/') return null;
    return parsePanelDeepLink(value) ? new URL(value.trim()).toString() : null;
  }

  /**
   * The redacted, facts-only payload for one decision (spec §4.2). Nothing
   * but the title, state, urgency, canonical link and ids: no evidence, notes,
   * names, costs, tokens, other items or instructions.
   */
  function buildSelectionContext(input) {
    var item = input && input.item;
    if (!item || typeof item.id !== 'string' || !UUID_RE.test(item.id)) return null;
    var workspaceId = input.workspaceId;
    if (typeof workspaceId !== 'string' || !workspaceId) return null;
    var urgency = URGENCIES.indexOf(item.urgency) === -1 ? 'medium' : item.urgency;
    var url = canonicalUrl(item.url);
    var sharedAt = typeof input.sharedAt === 'string' ? input.sharedAt : new Date().toISOString();
    var text =
      'OrgX item: decision "' + clip(item.title, TITLE_MAX) + '" — pending, ' + urgency + '.' +
      (url ? ' ' + url : '');
    return {
      content: [{ type: 'text', text: text }],
      structuredContent: {
        schema: SELECTION_SCHEMA,
        workspace_id: workspaceId,
        entity: { type: 'decision', id: item.id.toLowerCase(), version: String(item.version || '') },
        url: url,
        shared_at: sharedAt,
      },
    };
  }

  /** "Stop sharing": replaces the shared item with a no-selection payload. */
  function buildClearedContext(input) {
    var workspaceId = input && typeof input.workspaceId === 'string' ? input.workspaceId : null;
    return {
      content: [{ type: 'text', text: 'OrgX: no item is shared from the panel.' }],
      structuredContent: {
        schema: SELECTION_SCHEMA,
        workspace_id: workspaceId,
        entity: null,
        url: null,
        shared_at: input && typeof input.clearedAt === 'string' ? input.clearedAt : new Date().toISOString(),
      },
    };
  }

  /**
   * Read a restored shared selection as a hint only.
   * Returns null (nothing usable), { status: 'mismatch' } (another schema's
   * or another workspace's selection: never shown as selected) or
   * { status: 'match', entity: { type, id, version } }.
   */
  function readSharedSelection(current, workspaceId) {
    if (!current || typeof current !== 'object') return null;
    var structured = current.structuredContent;
    if (!structured || typeof structured !== 'object') return null;
    if (structured.schema !== SELECTION_SCHEMA) return null;
    var entity = structured.entity;
    if (!entity) return null;
    if (!workspaceId || structured.workspace_id !== workspaceId) return { status: 'mismatch' };
    if (entity.type !== 'decision' || typeof entity.id !== 'string' || !UUID_RE.test(entity.id)) {
      return { status: 'mismatch' };
    }
    return {
      status: 'match',
      entity: { type: 'decision', id: entity.id.toLowerCase(), version: String(entity.version || '') },
    };
  }

  // --- Capabilities over an ext-apps App ---------------------------------------

  function hostContext(app) {
    try {
      return app && typeof app.getHostContext === 'function' ? app.getHostContext() || null : null;
    } catch (_) {
      return null;
    }
  }

  function hostCapabilities(app) {
    try {
      return app && typeof app.getHostCapabilities === 'function' ? app.getHostCapabilities() || null : null;
    } catch (_) {
      return null;
    }
  }

  function hasModelContextCapability(app) {
    var raw = rawHostCapabilities;
    if (raw && raw.experimental && raw.experimental[MODEL_CONTEXT_KEY] != null) return true;
    var parsed = hostCapabilities(app);
    if (parsed && parsed.experimental && parsed.experimental[MODEL_CONTEXT_KEY] != null) return true;
    return Boolean(parsed && parsed.updateModelContext != null);
  }

  /**
   * Returns { deepLink, modelContext }; each is undefined when unsupported.
   * deepLink is defined only while the host context carries openai/deepLink.
   */
  function createExtensions(app) {
    if (!app) return { deepLink: undefined, modelContext: undefined };
    var context = hostContext(app);
    var deepLink = context && context[DEEP_LINK_KEY] !== undefined
      ? {
          getCurrent: function getCurrent() {
            var current = hostContext(app);
            return normalizeDeepLinkState(current && current[DEEP_LINK_KEY]);
          },
        }
      : undefined;
    var modelContext = hasModelContextCapability(app) && typeof app.updateModelContext === 'function'
      ? {
          getCurrent: function getCurrent() {
            var current = hostContext(app);
            if (!current || !(MODEL_CONTEXT_KEY in current)) return undefined;
            var state = current[MODEL_CONTEXT_KEY];
            if (state === null) return null;
            return state && typeof state === 'object' ? state : undefined;
          },
          update: function update(params) {
            return Promise.resolve(app.updateModelContext(params)).then(function readUpdateId(result) {
              var meta = result && result._meta && result._meta[MODEL_CONTEXT_KEY];
              return meta && typeof meta.updateId === 'string' ? { updateId: meta.updateId } : undefined;
            });
          },
        }
      : undefined;
    return { deepLink: deepLink, modelContext: modelContext };
  }

  /**
   * The only writer of model context. share() and stop() are meant to be
   * called from a click handler; constructing the controller, reading the
   * current context and refreshing never call update().
   */
  function createShareController(options) {
    var modelContext = options && options.modelContext;
    var now = (options && options.now) || function nowIso() { return new Date().toISOString(); };
    var shared = null;
    return {
      get shared() { return shared; },
      share: function share(item, workspaceId) {
        if (!modelContext) return Promise.reject(new Error('Sharing is not available here.'));
        var payload = buildSelectionContext({ item: item, workspaceId: workspaceId, sharedAt: now() });
        if (!payload) return Promise.reject(new Error('This item cannot be shared.'));
        return modelContext.update(payload).then(function remember(result) {
          shared = { id: payload.structuredContent.entity.id, version: payload.structuredContent.entity.version, workspaceId: workspaceId };
          return result;
        });
      },
      stop: function stop(workspaceId) {
        if (!modelContext) return Promise.reject(new Error('Sharing is not available here.'));
        return modelContext.update(buildClearedContext({ workspaceId: workspaceId, clearedAt: now() })).then(function clear(result) {
          shared = null;
          return result;
        });
      },
      /** Adopt a restored selection without writing anything. */
      restore: function restore(selection, workspaceId) {
        shared = selection && selection.status === 'match'
          ? { id: selection.entity.id, version: selection.entity.version, workspaceId: workspaceId }
          : null;
      },
    };
  }

  global.OrgXOpenAIExtensions = {
    DEEP_LINK_KEY: DEEP_LINK_KEY,
    MODEL_CONTEXT_KEY: MODEL_CONTEXT_KEY,
    UPDATE_MODEL_CONTEXT_METHOD: UPDATE_MODEL_CONTEXT_METHOD,
    SELECTION_SCHEMA: SELECTION_SCHEMA,
    buildClearedContext: buildClearedContext,
    buildSelectionContext: buildSelectionContext,
    createExtensions: createExtensions,
    createShareController: createShareController,
    getRawHostCapabilities: getRawHostCapabilities,
    normalizeDeepLinkState: normalizeDeepLinkState,
    parsePanelDeepLink: parsePanelDeepLink,
    readSharedSelection: readSharedSelection,
    __onMessageForTests: onMessage,
    __resetForTests: function resetForTests() { rawHostCapabilities = null; },
  };
})(window);
