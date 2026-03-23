export interface WidgetEnv {
  MCP_SERVER_URL?: string;
  ORGX_WEB_URL?: string;
  ORGX_API_URL?: string;
}

// Standard MIME type for MCP Apps widget resources (ChatGPT, Claude, VS Code, etc.)
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const SKYBRIDGE_MIME_TYPE = 'text/html+skybridge';

const DEFAULT_WIDGET_BASE_URL = 'https://mcp.useorgx.com/widgets/';
const DEFAULT_WIDGET_DOMAIN = 'mcp.useorgx.com';

function normalizeUrl(value?: string | null): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function resolveWidgetBaseUrl(env: WidgetEnv): string {
  const url = normalizeUrl(env.MCP_SERVER_URL);
  if (!url) return DEFAULT_WIDGET_BASE_URL;
  return new URL('/widgets/', url).toString();
}

export function resolveWidgetDomain(env: WidgetEnv): string {
  const url = normalizeUrl(env.MCP_SERVER_URL);
  return url?.host ?? DEFAULT_WIDGET_DOMAIN;
}

export function toSkybridgeResourceUri(uri: string): string {
  return uri.replace(/\.html$/, '.skybridge.html');
}

function addOrigin(origins: Set<string>, value?: string | null) {
  const url = normalizeUrl(value);
  if (!url) return;
  origins.add(url.origin);
  const hostParts = url.hostname.split('.');
  if (hostParts.length === 2 && !url.hostname.startsWith('www.')) {
    origins.add(`${url.protocol}//www.${url.hostname}`);
  }
}

function buildWidgetCsp(env: WidgetEnv) {
  const origins = new Set<string>();
  addOrigin(origins, env.MCP_SERVER_URL);
  addOrigin(origins, env.ORGX_WEB_URL);
  addOrigin(origins, env.ORGX_API_URL);
  if (origins.size === 0) {
    origins.add('https://mcp.useorgx.com');
    origins.add('https://useorgx.com');
    origins.add('https://www.useorgx.com');
  }
  return {
    connect_domains: Array.from(origins),
    resource_domains: Array.from(origins),
  };
}

export function buildWidgetMeta(env: WidgetEnv) {
  return {
    'openai/widgetPrefersBorder': true,
    'openai/widgetDomain': resolveWidgetDomain(env),
    'openai/widgetCSP': buildWidgetCsp(env),
  };
}

/**
 * Build metadata for MCP Apps clients (Claude, VS Code, Goose).
 * Per MCP Apps spec:
 * - resourceDomains: For loading scripts, styles, images
 * - connectDomains: For fetch/WebSocket API calls
 */
export function buildMcpAppsMeta(env: WidgetEnv) {
  const csp = buildWidgetCsp(env);
  return {
    ui: {
      prefersBorder: true,
      csp: {
        // resourceDomains allows loading external scripts/styles/images
        // Required for widgets that use <script src="..."> or ES module imports
        resourceDomains: csp.resource_domains,
        // connectDomains allows fetch/XHR/WebSocket connections
        connectDomains: csp.connect_domains,
      },
    },
  };
}

export function injectWidgetBase(html: string, baseHref: string) {
  if (!baseHref || /<base\s/i.test(html)) return html;
  const baseTag = `  <base href="${baseHref}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${baseTag}`);
  }
  return `${baseTag}\n${html}`;
}
