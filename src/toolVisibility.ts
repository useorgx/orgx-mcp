import {
  WIDGET_CALLABLE_TOOL_IDS,
  isWidgetOnlyTool,
} from './widgetToolContract';

/**
 * The one visibility rule for every registered tool.
 *
 * Hosts read two keys: the MCP Apps standard `ui.visibility` and ChatGPT's
 * legacy `openai/visibility`. They used to disagree (a tool could be
 * `openai/visibility: "private"` with no `ui.visibility`, or `ui.visibility:
 * ["app"]` while the bootstrap and the submission listed it as callable), so
 * ChatGPT, Claude and the bootstrap each showed a different tool set.
 *
 * Now both keys are derived from one list:
 *   - widget-only tools (WIDGET_ONLY_TOOL_IDS): hidden from the model,
 *     `ui.visibility: ["app"]`, `openai/visibility: "private"`;
 *   - every other registered tool: callable by the model,
 *     `ui.visibility: ["model", "app"]`, `openai/visibility: "public"`.
 * Any tool a widget calls also gets `openai/widgetAccessible: true`, which
 * ChatGPT requires before window.openai.callTool may run it.
 */
export function withConsistentToolVisibility(
  toolId: string,
  meta: Record<string, unknown> | undefined
): Record<string, unknown> {
  const base = meta ?? {};
  const existingUi =
    base.ui && typeof base.ui === 'object' && !Array.isArray(base.ui)
      ? (base.ui as Record<string, unknown>)
      : {};
  const widgetOnly = isWidgetOnlyTool(toolId);
  const widgetCallable =
    widgetOnly ||
    WIDGET_CALLABLE_TOOL_IDS.has(toolId) ||
    base['openai/widgetAccessible'] === true;

  return {
    ...base,
    'openai/visibility': widgetOnly ? 'private' : 'public',
    ...(widgetCallable ? { 'openai/widgetAccessible': true } : {}),
    ui: {
      ...existingUi,
      visibility: widgetOnly ? ['app'] : ['model', 'app'],
    },
  };
}

/** True when a listed tool is callable by the model (not widget-only). */
export function isModelVisibleToolMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return true;
  const ui = (meta as Record<string, unknown>).ui as
    | { visibility?: unknown }
    | undefined;
  if (ui && Array.isArray(ui.visibility)) {
    return ui.visibility.includes('model');
  }
  return (meta as Record<string, unknown>)['openai/visibility'] !== 'private';
}
