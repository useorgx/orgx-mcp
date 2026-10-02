/**
 * Widget approval tokens travel from the app to the decisions widget only.
 *
 * The app adds `_widget_meta` to a pending-decisions payload when the worker
 * asks for it. Everything in `content` and `structuredContent` reaches the
 * model, so the worker always lifts `_widget_meta` out of the payload and
 * returns it in the tool result's `_meta`, which hosts hand to the widget and
 * never to the model.
 */
export const WIDGET_APPROVAL_META_KEY = 'orgx/widgetApproval';

/** Tools whose app payload may carry approval tokens for the decisions widget. */
export const WIDGET_APPROVAL_SOURCE_TOOLS = new Set(['get_pending_decisions']);

export function splitWidgetApprovalMeta<T extends Record<string, unknown>>(
  data: T
): { data: Omit<T, '_widget_meta'>; meta: Record<string, unknown> | null } {
  if (!data || typeof data !== 'object' || !('_widget_meta' in data)) {
    return { data, meta: null };
  }
  const { _widget_meta: raw, ...rest } = data;
  const meta =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  return { data: rest, meta };
}
