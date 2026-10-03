export interface WidgetEnv {
  MCP_SERVER_URL?: string;
  ORGX_WEB_URL?: string;
  ORGX_API_URL?: string;
}

// Standard MIME type for MCP Apps widget resources (ChatGPT, Claude, VS Code, etc.)
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const SKYBRIDGE_MIME_TYPE = 'text/html+skybridge';

const DEFAULT_WIDGET_BASE_URL = 'https://mcp.useorgx.com/widgets/';
const DEFAULT_WIDGET_DOMAIN = 'https://mcp.useorgx.com';
const DEFAULT_RESOURCE_DOMAINS = ['https://cdn.useorgx.com'];
const DEFAULT_REDIRECT_DOMAINS = [
  'https://mcp.useorgx.com',
  'https://useorgx.com',
  'https://www.useorgx.com',
  'https://github.com',
];

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
  return url?.origin ?? DEFAULT_WIDGET_DOMAIN;
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

/**
 * What a widget really loads or connects to, beyond the host bridge
 * (postMessage needs no CSP entry).
 *
 * - connect: the widget opens a network connection to the MCP origin: a live
 *   feed (shared/live-store.js EventSource), the scaffold stream, or the
 *   search diagnostics beacon (fetch). Widgets that only talk to the host
 *   declare no connect domain at all.
 * - cdnMedia: the widget renders artifact media from https://cdn.useorgx.com.
 *
 * Every widget loads its assets and agent avatars from the MCP origin, so that
 * origin is always a resource domain. ORGX_API_URL is never a widget domain:
 * widgets reach the API only through tool calls the host makes.
 */
export interface WidgetCspNeeds {
  connect: boolean;
  cdnMedia: boolean;
}

/** The widest set, used when a caller does not name a widget. */
export const DEFAULT_WIDGET_CSP_NEEDS: WidgetCspNeeds = Object.freeze({
  connect: true,
  cdnMedia: true,
});

/**
 * Per-widget needs, keyed by the widget file stem. tests/surfaceContract.spec.ts
 * derives the same answers from each widget's source and fails on drift.
 */
export const WIDGET_CSP_NEEDS: Readonly<Record<string, WidgetCspNeeds>> =
  Object.freeze({
    decisions: { connect: true, cdnMedia: false },
    'agent-status': { connect: true, cdnMedia: false },
    'search-results': { connect: true, cdnMedia: false },
    'scaffolded-initiative': { connect: true, cdnMedia: false },
    'initiative-pulse': { connect: true, cdnMedia: false },
    'task-spawned': { connect: true, cdnMedia: false },
    'workspace-map': { connect: true, cdnMedia: false },
    'entity-card': { connect: true, cdnMedia: false },
    'work-ledger': { connect: true, cdnMedia: false },
    'morning-brief': { connect: true, cdnMedia: false },
    'artifact-review': { connect: true, cdnMedia: true },
    'plan-session-live': { connect: true, cdnMedia: false },
    'proof-receipt': { connect: false, cdnMedia: false },
    'orgx-panel': { connect: false, cdnMedia: false },
  });

export function widgetCspNeedsForUri(uri: string): WidgetCspNeeds {
  const stem = parseWidgetResourceUri(uri)
    .widgetFile.replace(/\.skybridge\.html$/, '')
    .replace(/\.html$/, '');
  return WIDGET_CSP_NEEDS[stem] ?? DEFAULT_WIDGET_CSP_NEEDS;
}

function mcpOrigins(env: WidgetEnv): string[] {
  const origins = new Set<string>();
  addOrigin(origins, env.MCP_SERVER_URL);
  if (origins.size === 0) origins.add(DEFAULT_WIDGET_DOMAIN);
  return Array.from(origins);
}

/**
 * Shared widget code loads agent avatars and the OrgX mark from this fixed
 * origin whatever the deployment (the kit's avatarConfig.baseUrl and the
 * decisions widget's logo fallback), so it is always a resource domain, also
 * on staging where MCP_SERVER_URL is a different origin.
 */
export const WIDGET_SHARED_ASSET_ORIGIN = 'https://mcp.useorgx.com';

function buildWidgetCsp(
  env: WidgetEnv,
  needs: WidgetCspNeeds = DEFAULT_WIDGET_CSP_NEEDS
) {
  const mcp = mcpOrigins(env);
  const connectOrigins = new Set<string>(needs.connect ? mcp : []);
  const resourceOrigins = new Set<string>([...mcp, WIDGET_SHARED_ASSET_ORIGIN]);
  if (needs.cdnMedia) {
    for (const domain of DEFAULT_RESOURCE_DOMAINS) {
      resourceOrigins.add(domain);
    }
  }
  const redirectDomains = new Set(DEFAULT_REDIRECT_DOMAINS);
  addOrigin(redirectDomains, env.MCP_SERVER_URL);
  addOrigin(redirectDomains, env.ORGX_WEB_URL);
  return {
    // Widgets communicate with the MCP origin (including the streaming demo)
    // and load their rewritten static assets from that same origin. ORGX_API_URL
    // is server-side only; web-app URLs are outbound links covered separately.
    connect_domains: Array.from(connectOrigins),
    resource_domains: Array.from(resourceOrigins),
    redirect_domains: Array.from(redirectDomains),
  };
}

export function buildWidgetMeta(
  env: WidgetEnv,
  needs: WidgetCspNeeds = DEFAULT_WIDGET_CSP_NEEDS
) {
  return {
    'openai/widgetPrefersBorder': true,
    'openai/widgetDomain': resolveWidgetDomain(env),
    'openai/widgetCSP': buildWidgetCsp(env, needs),
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
export function buildMcpAppsMeta(
  env: WidgetEnv,
  profile?: string,
  needs: WidgetCspNeeds = DEFAULT_WIDGET_CSP_NEEDS,
  options: { chatgptHost?: boolean } = {}
) {
  const csp = buildWidgetCsp(env, needs);
  return {
    ui: {
      // The standard MCP Apps domain is set only for ChatGPT: the explicit
      // ChatGPT profile, or any profile (such as the default v2 endpoint)
      // whose connected client identified itself as ChatGPT. ChatGPT reads
      // ui.* ahead of the openai/* keys, so without ui.domain it ignored
      // openai/widgetDomain and ran the widget without its declared CSP.
      // Claude requires a dedicated `{hash}.claudemcpcontent.com` origin, so
      // every other client lets the host choose its sandbox.
      ...(profile === 'chatgpt' || options.chatgptHost
        ? { domain: resolveWidgetDomain(env) }
        : {}),
      prefersBorder: true,
      csp: {
        // resourceDomains allows loading external scripts/styles/images
        // Required for widgets that use <script src="..."> or ES module imports
        resourceDomains: csp.resource_domains,
        // connectDomains allows fetch/XHR/WebSocket connections
        connectDomains: csp.connect_domains,
        // Base URLs stay pinned to the widget server; allowing the media CDN
        // here would broaden navigation without helping resource loads.
        baseUriDomains: mcpOrigins(env),
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
  // Base design tokens — widgets that used `@import url()` to pull this
  // rendered unstyled in Claude's sandbox. Inline it so the served
  // document is fully self-contained regardless of how it's referenced.
  // OrgX design kit (vendored from @useorgx/orgx-ui-kit by
  // scripts/sync-ui-kit.mjs). Widgets load ox-tokens.css first so their own
  // theme still wins for shared names until each widget is rebuilt on the kit.
  // Elements: either ox-elements.js (all) or ox-elements-core.js followed by
  // the add-ons the widget uses; scripts/build-widgets.mjs checks the choice.
  'shared/kit/ox-tokens.css',
  'shared/kit/ox-elements.js',
  'shared/kit/ox-elements-core.js',
  'shared/kit/ox-elements-footer.js',
  'shared/kit/ox-elements-glyph.js',
  'shared/kit/ox-elements-avatar.js',
  'shared/agent-identity.js',
  'shared/tokens.css',
  'shared/widget-theme.css',
  'shared/components/domain-accent.css',
  'shared/components/domain-accent.js',
  'shared/components/liveness-indicator.js',
  'shared/widget-state.js',
  // Live state layer. Order matters: the store and panel both assert that
  // live-machine.js is already installed.
  'shared/live-machine.js',
  'shared/live-store.js',
  'shared/live-panel.js',
  // OrgX icon set (entity types, statuses, actions): OrgXIcons.icon(name).
  'shared/orgx-icons.js',
  'shared/mcp-apps-sdk.umd.js',
  'shared/widget-runtime.js',
  // OpenAI MCP Apps extensions shim (deep link, model context); used by the
  // OrgX panel only. See the file header for its package source.
  'shared/openai-extensions.js',
];

/**
 * Where the worker reads a shared file's body for inlining: the minified
 * copy `pnpm widget:build` writes to public/widgets/inline/<path> (see
 * scripts/lib/inlineAssets.mjs). Relative to the widget base URL. The
 * readable source at <path> stays what standalone previews load.
 */
export const MCP_APPS_INLINE_ASSET_DIR = 'inline/';
export function mcpAppsInlineAssetPath(path: string): string {
  return MCP_APPS_INLINE_ASSET_DIR + path.replace(/^\.?\//, '');
}

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
      () => `<style data-inline-asset="${path}">\n${body}\n</style>\n`
    );
  }
  if (path.endsWith('.js')) {
    return html.replace(
      scriptPattern,
      () =>
        `<script data-inline-asset="${path}">\n${escapeInlineScriptBody(body)}\n</script>\n`
    );
  }
  return html;
}

function escapeInlineScriptBody(body: string) {
  // Inline scripts must never contain a literal closing script tag, even in
  // comments or strings, because the HTML parser terminates the element
  // before JavaScript parsing begins. The escaped slash evaluates to the
  // same string value inside JavaScript while remaining safe in HTML.
  return body.replace(/<\/script/gi, '<\\/script');
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
      () =>
        `<style data-inline-asset="interaction-kit.css">\n${assets.interactionKitCss}\n</style>\n`
    );
  }

  if (assets.interactionKitJs) {
    sanitized = sanitized.replace(
      /<script\b[^>]*\bsrc=("|')[^"']*interaction-kit\.js[^"']*\1[^>]*><\/script>\s*/gi,
      () =>
        `<script data-inline-asset="interaction-kit.js">\n${escapeInlineScriptBody(assets.interactionKitJs || '')}\n</script>\n`
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
