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

export function withWidgetResourceVersion(uri: string, version: string): string {
  if (!version) return uri;
  const separator = uri.includes('?') ? '&' : '?';
  return `${uri}${separator}v=${encodeURIComponent(version)}`;
}

export function toSkybridgeResourceUri(uri: string): string {
  return uri.replace(/\.html(\?.*)?$/, '.skybridge.html$1');
}

export function toWidgetHtmlResourceUri(uri: string): string {
  return uri.replace(/\.skybridge\.html(\?.*)?$/, '.html$1');
}

export function toVersionTolerantWidgetResourceUri(uri: string): string {
  const [baseUri] = uri.split('?');
  return `${baseUri}{?v}`;
}

export function parseWidgetResourceUri(uri: string) {
  const widgetTarget = uri.replace(/^ui:\/\/widget\//, '');
  const [widgetFile, ...queryParts] = widgetTarget.split('?');
  const query = queryParts.length > 0 ? `?${queryParts.join('?')}` : '';
  return { widgetFile, query };
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
 * Build metadata for MCP Apps clients and AI-tool hosts.
 * Current install targets include ChatGPT, Claude, Cursor, Codex, VS Code,
 * Windsurf, and Zed; all should receive the same border and CSP contract.
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

  const rewriteHtmlFragment = (fragment: string) => {
    let rewritten = fragment.replace(/<base\b[^>]*>\s*/gi, '');

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
  };

  // Only rewrite actual HTML markup, not inline JavaScript template strings.
  const blocks = html.split(
    /(<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>)/gi
  );
  return blocks
    .map((block, index) => {
      if (index % 2 === 0) return rewriteHtmlFragment(block);
      if (/^<script\b/i.test(block) || /^<style\b/i.test(block)) {
        return block.replace(/^<(script|style)\b[^>]*>/i, (openingTag) =>
          rewriteHtmlFragment(openingTag)
        );
      }
      return block;
    })
    .join('');
}

export interface McpAppsHtmlAssets {
  interactionKitCss?: string | null;
  interactionKitJs?: string | null;
  /**
   * Arbitrary shared-component bundles to inline. Keys are asset paths
   * relative to the widget base (e.g. "shared/components/domain-accent.js"),
   * values are the asset body (or null to skip). Any `<link>` or `<script>`
   * tag whose URL ends with the key (case-insensitive) gets inlined.
   *
   * Used to enforce the Claude MCP Apps widget-sandbox rule that shared
   * modules ship in-document rather than as external fetches.
   */
  sharedComponents?: Record<string, string | null>;
}

/**
 * Shared-component asset paths that are automatically inlined for MCP
 * Apps widget resources. Any widget referencing one of these paths gets
 * the corresponding file content inlined at resource-serve time.
 *
 * This is the enforceable "shared layer" contract. To add a new shared
 * module, add it here AND serve it under /widgets/<path>.
 */
export const MCP_APPS_SHARED_COMPONENT_PATHS: ReadonlyArray<string> = [
  'shared/components/domain-accent.css',
  'shared/components/domain-accent.js',
  'shared/components/liveness-indicator.js',
];

function inlineSharedAsset(
  html: string,
  path: string,
  body: string
): string {
  const pathSuffix = path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\//g, '[\\\\/]');
  const stylePattern = new RegExp(
    `<link\\b[^>]*\\bhref=("|')[^"']*${pathSuffix}(?:\\?[^"']*)?\\1[^>]*>\\s*`,
    'gi'
  );
  const scriptPattern = new RegExp(
    `<script\\b[^>]*\\bsrc=("|')[^"']*${pathSuffix}(?:\\?[^"']*)?\\1[^>]*><\\/script>\\s*`,
    'gi'
  );

  if (path.endsWith('.css')) {
    return html.replace(
      stylePattern,
      `<style data-inline-asset="${path}">\n${body}\n</style>\n`
    );
  }
  if (path.endsWith('.js')) {
    return html.replace(
      scriptPattern,
      `<script data-inline-asset="${path}">\n${body}\n</script>\n`
    );
  }
  return html;
}

export function sanitizeMcpAppsHtml(
  html: string,
  assets: McpAppsHtmlAssets = {}
) {
  let sanitized = html;

  // Claude's sandbox renderer appears to choke on percent-encoded favicon data
  // URIs inside the injected resource document. Favicons are not useful inside
  // the chat iframe, so drop them from MCP Apps payloads.
  sanitized = sanitized.replace(
    /<link\b[^>]*\brel=("|')[^"']*\b(?:icon|apple-touch-icon)\b[^"']*\1[^>]*>\s*/gi,
    ''
  );

  if (assets.interactionKitCss) {
    sanitized = sanitized.replace(
      /<link\b[^>]*\bhref=("|')[^"']*interaction-kit\.css[^"']*\1[^>]*>\s*/gi,
      `<style data-inline-asset="interaction-kit.css">\n${assets.interactionKitCss}\n</style>\n`
    );
  }

  if (assets.interactionKitJs) {
    sanitized = sanitized.replace(
      /<script\b[^>]*\bsrc=("|')[^"']*interaction-kit\.js[^"']*\1[^>]*><\/script>\s*/gi,
      `<script data-inline-asset="interaction-kit.js">\n${assets.interactionKitJs}\n</script>\n`
    );
  }

  if (assets.sharedComponents) {
    for (const [path, body] of Object.entries(assets.sharedComponents)) {
      if (!body) continue;
      sanitized = inlineSharedAsset(sanitized, path, body);
    }
  }

  return sanitized;
}
