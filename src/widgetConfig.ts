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

function shouldRewriteAssetUrl(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:')
  ) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith('//')) {
    return false;
  }
  return true;
}

function rewriteAssetUrl(value: string, widgetBaseUrl: string): string {
  if (!shouldRewriteAssetUrl(value)) return value;
  try {
    return new URL(value, widgetBaseUrl).toString();
  } catch {
    return value;
  }
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
        // Keep base-uri permissive for future compatibility, but widgets should
        // not depend on it because some hosts reject runtime base injection.
        baseUriDomains: csp.resource_domains,
      },
    },
  };
}

export function rewriteWidgetHtmlAssetUrls(html: string, widgetBaseUrl: string) {
  if (!widgetBaseUrl) return html;

  let rewritten = html.replace(/<base\b[^>]*>\s*/gi, '');

  rewritten = rewritten.replace(
    /\b(href|src|poster)=("([^"]*)"|'([^']*)')/gi,
    (match, attr, quotedValue, doubleQuotedValue, singleQuotedValue) => {
      const value =
        typeof doubleQuotedValue === 'string'
          ? doubleQuotedValue
          : singleQuotedValue;
      const nextValue = rewriteAssetUrl(value, widgetBaseUrl);
      if (nextValue === value) return match;
      const quote = quotedValue[0] === "'" ? "'" : '"';
      return `${attr}=${quote}${nextValue}${quote}`;
    }
  );

  rewritten = rewritten.replace(
    /\bsrcset=("([^"]*)"|'([^']*)')/gi,
    (match, quotedValue, doubleQuotedValue, singleQuotedValue) => {
      const value =
        typeof doubleQuotedValue === 'string'
          ? doubleQuotedValue
          : singleQuotedValue;
      const rewrittenCandidates = value
        .split(',')
        .map((candidate: string) => {
          const trimmed = candidate.trim();
          if (!trimmed) return trimmed;
          const [url, descriptor] = trimmed.split(/\s+/, 2);
          const nextUrl = rewriteAssetUrl(url, widgetBaseUrl);
          return descriptor ? `${nextUrl} ${descriptor}` : nextUrl;
        })
        .join(', ');
      if (rewrittenCandidates === value) return match;
      const quote = quotedValue[0] === "'" ? "'" : '"';
      return `srcset=${quote}${rewrittenCandidates}${quote}`;
    }
  );

  return rewritten;
}
