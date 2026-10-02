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

const WIDGET_DECIDE_DETAIL_KEYS = ['reason', 'status', 'widget_actions'] as const;

/**
 * The app's refusal messages, for app builds that send the message without
 * its `data.code` (the tools/execute route drops `data` on failure). Each
 * maps to the code the app attaches to that message; the out-of-date message
 * covers several codes, so it gets its own.
 */
const WIDGET_DECIDE_MESSAGE_CODES: Array<[RegExp, string]> = [
  [/^This view is out of date/i, 'widget_view_out_of_date'],
  [/^This decision was already settled/i, 'decision_already_resolved'],
  [/^Deciding from chat is switched off/i, 'widget_approval_disabled'],
  [/^This decision has to be made in OrgX/i, 'widget_decision_lifecycle_required'],
  [/not found/i, 'widget_decision_not_found'],
  [/^Type an answer to send/i, 'answer_required'],
  [/^This decision does not take an answer/i, 'answer_not_accepted'],
  [/^Choose an option first/i, 'option_required'],
  [/^(This decision has no options to choose|Choose one option \(option_id\)|Choose options as a list)/i, 'options_not_accepted'],
  [/^(That option is no longer available|Each option can be chosen once)/i, 'option_unavailable'],
  [/can only be chosen to (approve|reject)/i, 'option_action_mismatch'],
  [/^Choose between \d+ and \d+ options/i, 'selection_out_of_range'],
  [/^Say (why you chose|what should change)/i, 'reason_required'],
];

/**
 * A refused widget click keeps the app's code and the details the widget
 * needs to say what happened: `reason` (decide in OrgX), `status` (already
 * settled) and `widget_actions` (validation: re-render from the current
 * contract). Without a code, the app's message decides it.
 */
export function widgetDecideFailure(
  message: string,
  data: unknown
): { code: string; details?: Record<string, unknown> } {
  const record =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const text = typeof message === 'string' ? message.trim() : '';
  const inferred = WIDGET_DECIDE_MESSAGE_CODES.find(([pattern]) => pattern.test(text));
  const code =
    typeof record.code === 'string' && record.code.trim()
      ? record.code.trim()
      : inferred
        ? inferred[1]
        : 'tool_execution_failed';
  const details: Record<string, unknown> = {};
  for (const key of WIDGET_DECIDE_DETAIL_KEYS) {
    if (record[key] !== undefined && record[key] !== null) details[key] = record[key];
  }
  return Object.keys(details).length ? { code, details } : { code };
}
