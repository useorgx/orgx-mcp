/**
 * Small self-contained theme bootstrap for generated HTML widgets that cannot
 * depend on the shared public runtime.
 *
 * Precedence: explicit ?theme= override, host theme, then system preference
 * through CSS. Host changes remain live in ChatGPT and MCP Apps containers.
 */
export const INLINE_WIDGET_THEME_BOOTSTRAP = `(function () {
  var explicit = null;
  try {
    var requested = new URLSearchParams(window.location.search).get('theme');
    explicit = requested === 'dark' || requested === 'light' ? requested : null;
  } catch (_) {}

  function apply(value, source) {
    var theme = value === 'dark' || value === 'light' ? value : null;
    if (explicit) {
      theme = explicit;
      source = 'url';
    }
    if (!theme) return;
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-source', source || 'host');
    document.documentElement.style.colorScheme = theme;
  }

  apply(explicit || (window.openai && window.openai.theme), explicit ? 'url' : 'host');

  window.addEventListener('openai:set_globals', function (event) {
    var globals = event.detail && event.detail.globals;
    if (globals) apply(globals.theme, 'host');
  });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.method === 'ui/notifications/host-context-changed') {
      apply(data.params && data.params.theme, 'host');
    }
    if (data.result && data.result.hostContext) {
      apply(data.result.hostContext.theme, 'host');
    }
  });
})();`;
