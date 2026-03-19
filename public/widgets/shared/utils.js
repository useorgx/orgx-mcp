/**
 * Shared Utilities for ChatGPT App Widgets
 *
 * Per OpenAI Security Guidelines:
 * - All user data must be escaped before rendering
 * - Widgets must handle missing data gracefully
 * - Event listeners should be passive when possible
 */

/**
 * Escapes HTML to prevent XSS attacks
 * CRITICAL: Use this for ALL user-generated content
 *
 * @param {string} str - The string to escape
 * @returns {string} - HTML-safe string
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') str = String(str);

  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Formats a date string to relative time
 *
 * @param {string|Date} dateStr - ISO date string or Date object
 * @returns {string} - Human-readable relative time
 */
export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Formats a date to short format
 *
 * @param {string|Date} dateStr - ISO date string or Date object
 * @returns {string} - Formatted date string
 */
export function formatDate(dateStr) {
  if (!dateStr) return '';

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Gets initials from a name
 *
 * @param {string} name - Full name
 * @returns {string} - 1-2 character initials
 */
export function getInitials(name) {
  if (!name || typeof name !== 'string') return '?';

  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Safely gets nested property from an object
 *
 * @param {object} obj - The object to access
 * @param {string} path - Dot-notation path (e.g., 'user.profile.name')
 * @param {*} defaultValue - Value to return if path not found
 * @returns {*} - The value at path or defaultValue
 */
export function get(obj, path, defaultValue = undefined) {
  if (!obj || typeof obj !== 'object') return defaultValue;

  const keys = path.split('.');
  let result = obj;

  for (const key of keys) {
    if (result === null || result === undefined) return defaultValue;
    result = result[key];
  }

  return result === undefined ? defaultValue : result;
}

/**
 * Creates a debounced function
 *
 * @param {Function} fn - Function to debounce
 * @param {number} ms - Delay in milliseconds
 * @returns {Function} - Debounced function
 */
export function debounce(fn, ms) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), ms);
  };
}

// =============================================================================
// DUAL-PROTOCOL BRIDGE (ChatGPT + MCP Apps)
// =============================================================================

/**
 * Detects which host protocol the widget is running under.
 *
 * @returns {'chatgpt' | 'mcp-apps-sdk' | 'mcp-apps' | 'standalone'}
 */
export function detectProtocol() {
  if (typeof window !== 'undefined' && window.openai) return 'chatgpt';
  // Check if official MCP Apps SDK is loaded (via UMD bundle)
  if (typeof window !== 'undefined' && window.McpApps?.App)
    return 'mcp-apps-sdk';
  // Fallback to custom postMessage bridge if in iframe
  if (
    typeof window !== 'undefined' &&
    window.parent &&
    window.parent !== window
  )
    return 'mcp-apps';
  return 'standalone';
}

/** @type {'chatgpt' | 'mcp-apps' | 'standalone'} */
let _protocol = null;

/** Cached protocol getter */
function getProtocol() {
  if (!_protocol) _protocol = detectProtocol();
  return _protocol;
}

/**
 * MCP Apps postMessage bridge implementing SEP-1865 protocol.
 * Communicates with MCP Apps host (Claude, VS Code, Goose) via postMessage.
 */
class McpAppsBridge {
  constructor() {
    this._pending = new Map();
    this._nextId = 1;
    this._toolResultCallback = null;
    this._handleMessage = this._handleMessage.bind(this);
    window.addEventListener('message', this._handleMessage);
  }

  /** Send notifications/initialized to the host */
  connect() {
    window.parent.postMessage(
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      '*'
    );
  }

  /** @param {Function} cb - callback for tool result data */
  set ontoolresult(cb) {
    this._toolResultCallback = cb;
  }

  /**
   * Call a server-side MCP tool via the host.
   * @param {{ name: string, arguments: object }} params
   * @returns {Promise<object>}
   */
  callServerTool({ name, arguments: args }) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      window.parent.postMessage(
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        },
        '*'
      );
      // Timeout after 30s
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`Tool call ${name} timed out`));
        }
      }, 30000);
    });
  }

  /** @param {MessageEvent} event */
  _handleMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // JSON-RPC response to a pending tool call
    if (data.id != null && this._pending.has(data.id)) {
      const { resolve, reject } = this._pending.get(data.id);
      this._pending.delete(data.id);
      if (data.error) {
        reject(new Error(data.error.message || 'Tool call failed'));
      } else {
        resolve(data.result);
      }
      return;
    }

    // Notification with tool result data from host
    // Support both MCP Apps spec (ui/notifications/tool-result) and legacy format (notifications/message)
    if (
      (data.method === 'ui/notifications/tool-result' ||
        data.method === 'notifications/message') &&
      data.params
    ) {
      if (this._toolResultCallback) {
        // Try to extract structured data from params
        const result = data.params;

        // Priority 1: Check for structuredContent (ChatGPT Apps SDK)
        if (result?.structuredContent) {
          this._toolResultCallback(result.structuredContent);
          return;
        }

        // Priority 2: Try to parse JSON from content array (MCP Apps standard)
        if (result?.content && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (item?.type === 'text' && item?.text) {
              try {
                const parsed = JSON.parse(item.text);
                this._toolResultCallback(parsed);
                return;
              } catch {
                continue;
              }
            }
          }
        }

        // Priority 3: Pass the entire params object
        this._toolResultCallback(result);
      }
    }
  }

  destroy() {
    window.removeEventListener('message', this._handleMessage);
  }
}

/**
 * MCP Apps SDK Bridge using official @modelcontextprotocol/ext-apps App class.
 * This provides spec-compliant communication with MCP Apps hosts (Claude, VS Code, Goose).
 */
class McpAppsSDKBridge {
  constructor() {
    this._app = null;
    this._toolResultCallback = null;
    this._connected = false;
  }

  /**
   * Connect to the MCP Apps host using the official SDK.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._connected) return;

    const { App, applyHostStyleVariables, applyHostFonts } = window.McpApps;

    this._app = new App({
      name: 'OrgX Widget',
      version: '1.0.0',
    });

    // Use the official ontoolresult callback pattern from the SDK
    // This receives tool results pushed by the host
    this._app.ontoolresult = (result) => {
      if (this._toolResultCallback) {
        // Priority 1: Check for structuredContent (ChatGPT Apps SDK)
        if (result?.structuredContent) {
          this._toolResultCallback(result.structuredContent);
          return;
        }

        // Priority 2: Try to parse JSON from content array (MCP Apps standard)
        // Tools return JSON data in the first text content item
        if (result?.content && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (item?.type === 'text' && item?.text) {
              try {
                const data = JSON.parse(item.text);
                // Found valid JSON data
                this._toolResultCallback(data);
                return;
              } catch {
                // Not JSON, try next content item
                continue;
              }
            }
          }
        }

        // Priority 3: Pass the entire result object
        this._toolResultCallback(result);
      }
    };

    // Connect to the host
    await this._app.connect();
    this._connected = true;

    // Apply host styling if available
    try {
      const context = await this._app.getHostContext();
      if (context?.styleVariables) {
        applyHostStyleVariables(context.styleVariables);
      }
      if (context?.fonts) {
        applyHostFonts(context.fonts);
      }
    } catch {
      // Host may not support context, continue without styling
    }
  }

  /** @param {Function} cb - callback for tool result data */
  set ontoolresult(cb) {
    this._toolResultCallback = cb;
  }

  /**
   * Call a server-side MCP tool via the host.
   * @param {{ name: string, arguments: object }} params
   * @returns {Promise<object>}
   */
  async callServerTool({ name, arguments: args }) {
    if (!this._app) {
      throw new Error('SDK bridge not connected');
    }

    const result = await this._app.callTool({
      name,
      arguments: args,
    });

    // Parse result content
    if (result?.content) {
      const textContent = result.content.find((c) => c.type === 'text');
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return { text: textContent.text };
        }
      }
    }

    return result;
  }

  destroy() {
    if (this._app) {
      this._app.close?.();
      this._app = null;
      this._connected = false;
    }
  }
}

/** @type {McpAppsBridge | McpAppsSDKBridge | null} */
let _bridge = null;

/**
 * Get or create the singleton MCP Apps bridge.
 * Prefers official SDK bridge if available, falls back to custom bridge.
 * @param {boolean} useSDK - Force SDK bridge if available
 */
function getBridge(useSDK = false) {
  if (!_bridge) {
    // Use SDK bridge if loaded, otherwise fall back to custom
    if (useSDK || (typeof window !== 'undefined' && window.McpApps?.App)) {
      _bridge = new McpAppsSDKBridge();
    } else {
      _bridge = new McpAppsBridge();
    }
  }
  return _bridge;
}

/**
 * Widget initialization helper
 * Sets up event listening for ChatGPT, MCP Apps SDK, MCP Apps, or standalone mode.
 *
 * @param {object} options - Configuration options
 * @param {Function} options.render - Render function to call when data updates
 * @param {Function} options.getData - Function that extracts data from toolOutput
 * @returns {object} - Object with current data reference
 */
export function initWidget({ render, getData }) {
  const protocol = getProtocol();
  let data;

  if (protocol === 'chatgpt') {
    // ChatGPT path: read window.openai.toolOutput, listen for openai:set_globals
    data = getData(window.openai?.toolOutput);
    render(data);

    window.addEventListener(
      'openai:set_globals',
      (event) => {
        const globals = event.detail?.globals;
        if (globals?.toolOutput) {
          data = getData(globals.toolOutput);
          render(data);
        }
      },
      { passive: true }
    );
  } else if (protocol === 'mcp-apps-sdk') {
    // MCP Apps SDK path: use official SDK bridge
    data = null;
    render(data);

    const bridge = getBridge(true);
    bridge.ontoolresult = (params) => {
      data = getData(params);
      render(data);
    };
    bridge.connect().catch((err) => {
      console.error('[OrgX Widget] Failed to connect SDK bridge:', err);
    });
  } else if (protocol === 'mcp-apps') {
    // MCP Apps path: use custom postMessage bridge
    data = null;
    render(data);

    const bridge = getBridge(false);
    bridge.ontoolresult = (params) => {
      data = getData(params);
      render(data);
    };
    bridge.connect();
  } else {
    // Standalone path: demo mode, just render with null
    data = null;
    render(data);
  }

  return { getData: () => data };
}

/**
 * Call an MCP tool from a widget (e.g., approve/reject decision).
 * Routes to the appropriate protocol.
 *
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {Promise<object|null>}
 */
export function callTool(name, args) {
  const protocol = getProtocol();

  if (protocol === 'chatgpt') {
    return window.openai?.callTool?.(name, args) ?? Promise.resolve(null);
  }

  if (protocol === 'mcp-apps-sdk') {
    return getBridge(true).callServerTool({ name, arguments: args });
  }

  if (protocol === 'mcp-apps') {
    return getBridge(false).callServerTool({ name, arguments: args });
  }

  // Standalone: no-op
  console.warn('[OrgX Widget] callTool unavailable in standalone mode');
  return Promise.resolve(null);
}

/**
 * Creates a loading spinner element
 *
 * @param {string} size - 'sm', 'md', or 'lg'
 * @returns {string} - HTML string for spinner
 */
export function spinner(size = 'md') {
  const sizes = { sm: '14px', md: '20px', lg: '32px' };
  const dimension = sizes[size] || sizes.md;

  return `
    <div 
      class="spinner" 
      role="status" 
      aria-label="Loading"
      style="
        width: ${dimension};
        height: ${dimension};
        border: 2px solid var(--app-color-border);
        border-top-color: var(--app-color-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      "
    >
      <span class="sr-only">Loading...</span>
    </div>
  `;
}

/**
 * Creates a skeleton loading placeholder
 *
 * @param {string} type - 'text', 'card', 'avatar', 'decision-card', 'agent-card', 'search-card'
 * @returns {string} - HTML string for skeleton
 */
export function skeleton(type = 'text') {
  const shimmerStyle = `
    background: linear-gradient(
      90deg,
      var(--app-color-surface-elevated, #f7f7f8) 0%,
      var(--app-color-bg, #ffffff) 50%,
      var(--app-color-surface-elevated, #f7f7f8) 100%
    );
    background-size: 200% 100%;
    animation: shimmer 2.5s infinite ease-in-out;
  `;

  const types = {
    text: `<div class="skeleton skeleton-text" style="${shimmerStyle} height: 1em; width: 100%; border-radius: 4px;"></div>`,
    'text-short': `<div class="skeleton skeleton-text" style="${shimmerStyle} height: 1em; width: 60%; border-radius: 4px;"></div>`,
    card: `<div class="skeleton skeleton-card" style="${shimmerStyle} height: 80px; width: 100%; border-radius: 8px;"></div>`,
    avatar: `<div class="skeleton skeleton-avatar" style="${shimmerStyle} height: 32px; width: 32px; border-radius: 50%;"></div>`,
    badge: `<div class="skeleton skeleton-badge" style="${shimmerStyle} height: 24px; width: 60px; border-radius: 9999px;"></div>`,
    button: `<div class="skeleton skeleton-button" style="${shimmerStyle} height: 36px; width: 100%; border-radius: 8px;"></div>`,

    // Composite skeletons for specific widget types
    'decision-card': `
      <div class="skeleton-decision-card" style="background: var(--app-color-surface, #fff); border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); border-left: 4px solid var(--app-color-border, #e5e5e5);">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <div style="${shimmerStyle} height: 24px; width: 24px; border-radius: 50%;"></div>
          <div style="${shimmerStyle} height: 14px; width: 80px; border-radius: 4px;"></div>
          <div style="margin-left: auto; ${shimmerStyle} height: 12px; width: 60px; border-radius: 4px;"></div>
        </div>
        <div style="${shimmerStyle} height: 14px; width: 100%; border-radius: 4px; margin-bottom: 6px;"></div>
        <div style="${shimmerStyle} height: 14px; width: 75%; border-radius: 4px; margin-bottom: 12px;"></div>
        <div style="display: flex; gap: 8px;">
          <div style="${shimmerStyle} height: 36px; flex: 1; border-radius: 8px;"></div>
          <div style="${shimmerStyle} height: 36px; flex: 1; border-radius: 8px;"></div>
        </div>
      </div>
    `,

    'agent-card': `
      <div class="skeleton-agent-card" style="background: var(--app-color-surface, #fff); border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); display: flex; align-items: center; gap: 12px;">
        <div style="${shimmerStyle} height: 32px; width: 32px; border-radius: 50%;"></div>
        <div style="flex: 1;">
          <div style="${shimmerStyle} height: 14px; width: 100px; border-radius: 4px; margin-bottom: 4px;"></div>
          <div style="${shimmerStyle} height: 12px; width: 150px; border-radius: 4px;"></div>
        </div>
        <div style="${shimmerStyle} height: 24px; width: 60px; border-radius: 9999px;"></div>
      </div>
    `,

    'search-card': `
      <div class="skeleton-search-card" style="background: var(--app-color-surface, #fff); border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <div style="${shimmerStyle} height: 20px; width: 70px; border-radius: 4px;"></div>
          <div style="${shimmerStyle} height: 14px; width: 150px; border-radius: 4px;"></div>
        </div>
        <div style="${shimmerStyle} height: 14px; width: 100%; border-radius: 4px; margin-bottom: 4px;"></div>
        <div style="${shimmerStyle} height: 14px; width: 80%; border-radius: 4px; margin-bottom: 8px;"></div>
        <div style="display: flex; gap: 8px;">
          <div style="${shimmerStyle} height: 20px; width: 70px; border-radius: 4px;"></div>
          <div style="${shimmerStyle} height: 12px; width: 80px; border-radius: 4px;"></div>
        </div>
      </div>
    `,

    'pulse-card': `
      <div class="skeleton-pulse-card" style="background: var(--app-color-surface, #fff); border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
        <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
          <div style="${shimmerStyle} height: 20px; width: 180px; border-radius: 4px;"></div>
          <div style="${shimmerStyle} height: 24px; width: 60px; border-radius: 9999px;"></div>
        </div>
        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
          <div style="${shimmerStyle} height: 14px; width: 80px; border-radius: 4px;"></div>
          <div style="${shimmerStyle} height: 14px; width: 70px; border-radius: 4px;"></div>
          <div style="${shimmerStyle} height: 14px; width: 60px; border-radius: 4px;"></div>
        </div>
        <div style="${shimmerStyle} height: 28px; width: 120px; border-radius: 8px;"></div>
      </div>
    `,
  };

  return types[type] || types.text;
}

/**
 * Renders multiple skeleton cards
 *
 * @param {string} type - Skeleton type
 * @param {number} count - Number of skeletons to render
 * @returns {string} - HTML string
 */
export function skeletonList(type, count = 3) {
  return Array(count)
    .fill(skeleton(type))
    .join('<div style="height: 8px;"></div>');
}

/**
 * Toast notification system
 * Creates and manages toast notifications
 */
export const toast = {
  container: null,

  /**
   * Initialize toast container
   */
  init() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'toast-container';
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', 'Notifications');
    this.container.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      max-width: calc(100% - 32px);
    `;
    document.body.appendChild(this.container);
  },

  /**
   * Show a toast notification
   *
   * @param {object} options - Toast options
   * @param {string} options.message - Message to display
   * @param {string} options.type - 'success', 'error', 'warning', 'info'
   * @param {number} options.duration - Duration in ms (default 3000)
   */
  show({ message, type = 'info', duration = 3000 }) {
    this.init();

    const colors = {
      success: {
        bg: 'var(--app-color-success-bg, #d1fae5)',
        text: 'var(--app-color-success-text, #065f46)',
        icon: '✓',
      },
      error: {
        bg: 'var(--app-color-danger-bg, #fef2f2)',
        text: 'var(--app-color-danger-text, #991b1b)',
        icon: '✕',
      },
      warning: {
        bg: 'var(--app-color-warning-bg, #fef3c7)',
        text: 'var(--app-color-warning-text, #92400e)',
        icon: '!',
      },
      info: {
        bg: 'var(--app-color-surface-elevated, #f7f7f8)',
        text: 'var(--app-color-text, #0d0d0d)',
        icon: 'ℹ',
      },
    };

    const { bg, text, icon } = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = `
      background: ${bg};
      color: ${text};
      padding: 10px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-size: 0.875rem;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: auto;
      animation: toastSlideIn 0.2s ease-out;
      max-width: 320px;
    `;

    toast.innerHTML = `
      <span style="font-size: 1rem; line-height: 1;">${icon}</span>
      <span>${escapeHtml(message)}</span>
    `;

    this.container.appendChild(toast);

    // Auto-dismiss
    setTimeout(() => {
      toast.style.animation = 'toastSlideOut 0.2s ease-in forwards';
      setTimeout(() => toast.remove(), 200);
    }, duration);

    return toast;
  },

  /**
   * Show success toast
   */
  success(message, duration) {
    return this.show({ message, type: 'success', duration });
  },

  /**
   * Show error toast
   */
  error(message, duration) {
    return this.show({ message, type: 'error', duration });
  },

  /**
   * Show warning toast
   */
  warning(message, duration) {
    return this.show({ message, type: 'warning', duration });
  },

  /**
   * Show info toast
   */
  info(message, duration) {
    return this.show({ message, type: 'info', duration });
  },
};

/**
 * CSS keyframes that should be included in widgets using spinner/skeleton/toast
 */
export const animationStyles = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  
  @keyframes toastSlideIn {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  @keyframes toastSlideOut {
    from {
      opacity: 1;
      transform: translateY(0);
    }
    to {
      opacity: 0;
      transform: translateY(20px);
    }
  }
`;

/**
 * ===================================================
 * SDK-Aligned Component Helpers
 * These mirror @openai/apps-sdk-ui React components
 * ===================================================
 */

/**
 * Creates an Avatar component HTML
 * Matches: @openai/apps-sdk-ui/components/Avatar
 *
 * @param {object} options - Avatar options
 * @param {string} options.name - Name for initials fallback
 * @param {string} options.imageUrl - Optional image URL
 * @param {string} options.size - 'xs', 'sm', 'md', 'lg', 'xl' (default: 'md')
 * @param {string} options.color - 'primary', 'secondary', 'success', 'danger', 'warning', 'info'
 * @param {string} options.variant - 'soft' or 'solid' (default: 'soft')
 * @param {boolean} options.interactive - If true, adds hover effects
 * @returns {string} - HTML string
 */
export function avatar({
  name,
  imageUrl,
  size = 'md',
  color = 'secondary',
  variant = 'soft',
  interactive = false,
} = {}) {
  const sizeClass = `avatar-${size}`;
  const colorClass = `avatar-${color}`;
  const variantClass = variant === 'solid' ? 'avatar-solid' : '';
  const interactiveClass = interactive ? 'avatar-interactive' : '';
  const initials = getInitials(name);

  const classes = [
    'avatar',
    sizeClass,
    colorClass,
    variantClass,
    interactiveClass,
  ]
    .filter(Boolean)
    .join(' ');

  if (imageUrl) {
    return `<span class="${classes}"><img src="${escapeHtml(
      imageUrl
    )}" alt="${escapeHtml(name || 'Avatar')}" /></span>`;
  }

  return `<span class="${classes}" aria-label="${escapeHtml(
    name || 'User'
  )}">${escapeHtml(initials)}</span>`;
}

/**
 * Creates a Badge component HTML
 * Matches: @openai/apps-sdk-ui/components/Badge
 *
 * @param {object} options - Badge options
 * @param {string} options.text - Badge text
 * @param {string} options.color - 'primary', 'success', 'danger', 'warning', 'info', 'neutral'
 * @param {string} options.variant - 'soft', 'solid', 'outline' (default: 'soft')
 * @param {string} options.size - 'sm', 'md', 'lg' (default: 'md')
 * @param {boolean} options.dot - Show indicator dot
 * @returns {string} - HTML string
 */
export function badge({
  text,
  color = 'neutral',
  variant = 'soft',
  size = 'md',
  dot = false,
} = {}) {
  const colorClass = `badge-${color}`;
  const variantClass = variant !== 'soft' ? `badge-${variant}` : '';
  const sizeClass = size !== 'md' ? `badge-${size}` : '';
  const dotClass = dot ? 'badge-dot' : '';

  const classes = ['badge', colorClass, variantClass, sizeClass, dotClass]
    .filter(Boolean)
    .join(' ');

  return `<span class="${classes}">${escapeHtml(text)}</span>`;
}

/**
 * Creates a Button component HTML
 * Matches: @openai/apps-sdk-ui/components/Button
 *
 * @param {object} options - Button options
 * @param {string} options.text - Button text
 * @param {string} options.color - 'primary', 'secondary', 'danger', 'success'
 * @param {string} options.variant - 'solid', 'outline', 'ghost' (default: 'solid')
 * @param {string} options.size - 'xs', 'sm', 'md', 'lg' (default: 'md')
 * @param {boolean} options.pill - Pill shape
 * @param {boolean} options.block - Full width
 * @param {boolean} options.loading - Show loading state
 * @param {boolean} options.disabled - Disabled state
 * @param {string} options.icon - Icon HTML (optional, for icon-only button)
 * @param {string} options.onClick - Onclick handler name
 * @returns {string} - HTML string
 */
export function button({
  text,
  color = 'secondary',
  variant = 'solid',
  size = 'md',
  pill = false,
  block = false,
  loading = false,
  disabled = false,
  icon,
  onClick,
} = {}) {
  const colorClass = variant === 'solid' ? `btn-${color}` : `btn-${variant}`;
  const sizeClass = size !== 'md' ? `btn-${size}` : '';
  const pillClass = pill ? 'btn-pill' : '';
  const blockClass = block ? 'btn-block' : '';
  const loadingClass = loading ? 'btn-loading' : '';
  const iconOnlyClass = icon && !text ? 'btn-icon' : '';

  const classes = [
    'btn',
    colorClass,
    sizeClass,
    pillClass,
    blockClass,
    loadingClass,
    iconOnlyClass,
  ]
    .filter(Boolean)
    .join(' ');

  const attrs = [
    `class="${classes}"`,
    disabled || loading ? 'disabled' : '',
    onClick ? `onclick="${onClick}"` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const content = icon && !text ? icon : escapeHtml(text);

  return `<button ${attrs}>${content}</button>`;
}

/**
 * Creates an Alert component HTML
 * Matches: @openai/apps-sdk-ui/components/Alert
 *
 * @param {object} options - Alert options
 * @param {string} options.title - Alert title
 * @param {string} options.description - Alert description
 * @param {string} options.color - 'primary', 'success', 'danger', 'warning', 'info'
 * @param {string} options.variant - 'outline', 'soft', 'solid' (default: 'outline')
 * @param {string} options.icon - Icon HTML (optional)
 * @param {string} options.actions - Actions HTML (optional)
 * @returns {string} - HTML string
 */
export function alert({
  title,
  description,
  color = 'primary',
  variant = 'outline',
  icon,
  actions,
} = {}) {
  const colorClass = `alert-${color}`;
  const variantClass = variant !== 'outline' ? `alert-${variant}` : '';

  const classes = ['alert', colorClass, variantClass].filter(Boolean).join(' ');

  // Default icons based on color
  const defaultIcons = {
    success:
      '<span class="icon icon-md icon-check-circle" style="color: var(--app-color-success);"></span>',
    danger:
      '<span class="icon icon-md icon-alert-circle" style="color: var(--app-color-danger);"></span>',
    warning:
      '<span class="icon icon-md icon-warning" style="color: var(--app-color-warning);"></span>',
    info: '<span class="icon icon-md icon-info" style="color: var(--app-color-info);"></span>',
    primary:
      '<span class="icon icon-md icon-info" style="color: var(--app-color-primary);"></span>',
  };

  const iconHtml = icon !== false ? icon || defaultIcons[color] || '' : '';

  return `
    <div class="${classes}" role="${color === 'danger' ? 'alert' : 'status'}">
      ${iconHtml ? `<div class="alert-icon">${iconHtml}</div>` : ''}
      <div class="alert-content">
        ${title ? `<div class="alert-title">${escapeHtml(title)}</div>` : ''}
        ${
          description
            ? `<div class="alert-description">${escapeHtml(description)}</div>`
            : ''
        }
        ${actions ? `<div class="alert-actions">${actions}</div>` : ''}
      </div>
    </div>
  `.trim();
}

/**
 * Creates an EmptyMessage component HTML
 * Matches: @openai/apps-sdk-ui/components/EmptyMessage
 *
 * @param {object} options - EmptyMessage options
 * @param {string} options.title - Title text
 * @param {string} options.description - Description text
 * @param {string} options.icon - Icon character or HTML (optional)
 * @param {string} options.iconColor - 'secondary', 'danger', 'warning' (default: 'secondary')
 * @param {string} options.actions - Actions HTML (optional)
 * @param {string} options.fill - 'static', 'absolute', 'none' (default: 'static')
 * @returns {string} - HTML string
 */
export function emptyMessage({
  title,
  description,
  icon,
  iconColor = 'secondary',
  actions,
  fill = 'static',
} = {}) {
  const fillClass = fill !== 'static' ? `empty-message-${fill}` : '';
  const iconColorClass =
    iconColor !== 'secondary' ? `empty-message-icon-${iconColor}` : '';

  const classes = ['empty-message', fillClass].filter(Boolean).join(' ');
  const iconClasses = ['empty-message-icon', iconColorClass]
    .filter(Boolean)
    .join(' ');
  const titleColorClass =
    iconColor === 'danger' ? 'empty-message-title-danger' : '';

  return `
    <div class="${classes}">
      ${icon ? `<div class="${iconClasses}">${icon}</div>` : ''}
      ${
        title
          ? `<div class="empty-message-title ${titleColorClass}">${escapeHtml(
              title
            )}</div>`
          : ''
      }
      ${
        description
          ? `<div class="empty-message-description">${escapeHtml(
              description
            )}</div>`
          : ''
      }
      ${actions ? `<div class="empty-message-actions">${actions}</div>` : ''}
    </div>
  `.trim();
}

/**
 * Creates an Indicator component HTML
 *
 * @param {object} options - Indicator options
 * @param {string} options.color - 'success', 'danger', 'warning', 'info', 'neutral'
 * @param {string} options.size - 'sm', 'md', 'lg' (default: 'md')
 * @param {boolean} options.pulse - Animate with pulse
 * @param {boolean} options.loading - Show as loading spinner
 * @returns {string} - HTML string
 */
export function indicator({
  color = 'neutral',
  size = 'md',
  pulse = false,
  loading = false,
} = {}) {
  if (loading) {
    const sizeClass = size !== 'md' ? `indicator-loading-${size}` : '';
    return `<span class="indicator indicator-loading ${sizeClass}" role="status" aria-label="Loading"></span>`;
  }

  const colorClass = `indicator-${color}`;
  const sizeClass = size !== 'md' ? `indicator-${size}` : '';
  const pulseClass = pulse ? 'indicator-pulse' : '';

  const classes = ['indicator', colorClass, sizeClass, pulseClass]
    .filter(Boolean)
    .join(' ');

  return `<span class="${classes}" aria-hidden="true"></span>`;
}

/**
 * Creates ShimmerText component HTML
 * Matches: @openai/apps-sdk-ui/components/ShimmerText
 *
 * @param {object} options - ShimmerText options
 * @param {string} options.text - Text content
 * @param {string} options.tag - HTML tag (default: 'span')
 * @param {boolean} options.idle - Pause animation
 * @returns {string} - HTML string
 */
export function shimmerText({ text, tag = 'span', idle = false } = {}) {
  const idleAttr = idle ? 'data-idle=""' : '';
  return `<${tag} class="shimmer-text" ${idleAttr}>${escapeHtml(
    text
  )}</${tag}>`;
}
