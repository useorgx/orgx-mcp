/**
 * Widget ↔ tool contract.
 *
 * Widgets call tools from inside the host (ChatGPT's window.openai.callTool or
 * the MCP Apps `tools/call` bridge). A host can only run a call when the tool
 * is in the list it imported for the connection, and ChatGPT only lets a widget
 * call a tool marked widget-accessible. When either is missing the click fails
 * inside the host (ChatGPT answers `{"detail":"MCP Resource not found"}`)
 * before it ever reaches this server.
 *
 * This module is the single source of truth for:
 *   - which tools each widget calls (checked against the widget source in CI),
 *   - which tools are widget-only (hidden from the model, callable by widgets),
 *   - where a profile intentionally serves a widget without one of its tools.
 *
 * tests/surfaceContract.spec.ts fails when any of these drift from the
 * runtime `tools/list`, the widget source, or public/widgets/shared/widget-runtime.js.
 */

import { TOOL_FEED_BINDINGS } from './live/streamGrant';

/**
 * Tools that exist only for a person's click inside a widget. They are hidden
 * from the model (`ui.visibility: ["app"]`, `openai/visibility: "private"`) and
 * callable by widgets (`openai/widgetAccessible: true`).
 *
 * - orgx_widget_decide: settles a decision; also requires the single-use HMAC
 *   widget approval token that only the widget sees, so approvals stay a
 *   human click.
 * - orgx_panel_snapshot: the OrgX panel's own read.
 * - orgx_widget_receipt_call: a person's call on a Work Ledger receipt, from the panel.
 * - resume_agent_run: the agent-status widget's Resume button.
 */
export const WIDGET_ONLY_TOOL_IDS = [
  'orgx_widget_decide',
  'orgx_panel_snapshot',
  'orgx_widget_receipt_call',
  'resume_agent_run',
  'orgx_widget_select_workspace',
  'orgx_widget_approve_artifact',
  'orgx_widget_request_artifact_changes',
] as const;

const WIDGET_ONLY_TOOL_ID_SET = new Set<string>(WIDGET_ONLY_TOOL_IDS);

export function isWidgetOnlyTool(toolId: string): boolean {
  return WIDGET_ONLY_TOOL_ID_SET.has(toolId);
}

/**
 * The current widget uses the explicit operation catalog directly. Retain the
 * exported map for the source contract check; it deliberately has no aliases.
 */
export const WIDGET_RUNTIME_TOOL_ALIASES: Readonly<
  Record<string, { tool: string; args: Readonly<Record<string, unknown>> }>
> = Object.freeze({});

export function resolveWidgetCalledTool(name: string): string {
  return Object.prototype.hasOwnProperty.call(WIDGET_RUNTIME_TOOL_ALIASES, name)
    ? WIDGET_RUNTIME_TOOL_ALIASES[name]!.tool
    : name;
}

/**
 * Every tool name each widget passes to callTool / callToolResult, exactly as
 * written in public/widgets/<widget>.html. CI parses the widget source and
 * fails when this list is stale.
 */
export const WIDGET_TOOL_CALLS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'agent-status': ['orgx_get_operation_status', 'resume_agent_run'],
    'artifact-review': ['orgx_get_operation_status', 'orgx_widget_approve_artifact', 'orgx_widget_request_artifact_changes'],
    decisions: ['orgx_get_operation_status', 'orgx_list_pending_decisions', 'orgx_widget_decide'],
    'entity-card': ['orgx_get_operation_status', 'orgx_inspect'],
    'initiative-pulse': [],
    'morning-brief': [],
    // Reads and a person's workspace selection are separate operations.
    'orgx-panel': ['orgx_get_operation_status', 'orgx_get_work_receipt', 'orgx_list_work_receipts', 'orgx_panel_snapshot', 'orgx_widget_decide', 'orgx_widget_receipt_call', 'orgx_widget_select_workspace'],
    'plan-session-live': ['orgx_get_operation_status', 'orgx_record_plan_edit'],
    'proof-receipt': [],
    // orgx_widget_decide: "Agree and launch" settles the Agree on done decision
    // with its single-use approval token.
    'scaffolded-initiative': ['orgx_get_operation_status', 'orgx_launch_initiative', 'orgx_widget_decide'],
    'search-results': ['orgx_search'],
    'task-spawned': ['orgx_get_operation_status'],
    'work-ledger': ['orgx_get_operator_brief'],
    'workspace-map': ['orgx_get_workspace_context'],
  });

/** Canonical tools a widget calls (after runtime aliases). */
export function widgetCalledTools(widget: string): string[] {
  return [
    ...new Set((WIDGET_TOOL_CALLS[widget] ?? []).map(resolveWidgetCalledTool)),
  ];
}

/**
 * Tools a widget re-invokes to refresh a live grant (live-store.js calls
 * grant.refreshTool through the runtime), after runtime aliases.
 */
export function liveRefreshToolFor(toolId: string): string | null {
  const binding = Object.prototype.hasOwnProperty.call(TOOL_FEED_BINDINGS, toolId)
    ? TOOL_FEED_BINDINGS[toolId]
    : undefined;
  return binding ? resolveWidgetCalledTool(binding.refreshTool) : null;
}

/** Every canonical tool some widget may call from inside the host. */
export const WIDGET_CALLABLE_TOOL_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(WIDGET_TOOL_CALLS).flatMap(widgetCalledTools),
  ...Object.values(TOOL_FEED_BINDINGS).map((binding) =>
    resolveWidgetCalledTool(binding.refreshTool)
  ),
]);

/**
 * Profiles that serve a widget without one of the tools it calls. The widget
 * runtime reports such a call as `tool_unavailable`, and the widget offers
 * the OrgX link instead. Every entry needs a reason; the two ChatGPT-facing
 * profiles (`chatgpt`, and `v2`, the default endpoint the public ChatGPT
 * install steps hand out) may have none. CI fails on new gaps and on stale
 * entries.
 */
export const WIDGET_CALL_PROFILE_EXCEPTIONS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
  'claude-plugin': {
    orgx_get_workspace_context: 'Claude Code has no widget host; bootstrap binds session scope through its existing API.',
    orgx_get_operation_status: 'Claude Code has no widget host; this profile retains its existing command-status API.',
    orgx_get_agent_status: 'Claude Code has no widget host; live refresh retains the last widget snapshot.',
    orgx_get_initiative_progress: 'Claude Code has no widget host; live refresh retains the last widget snapshot.',
    orgx_get_operator_brief: 'Claude Code has no widget host; the existing chronicle read remains the API.',
    orgx_list_pending_decisions: 'Claude Code has no widget host; the existing decision API remains available.',
    orgx_widget_decide: 'Claude Code has no widget host; people record decisions in OrgX.',
    resume_agent_run: 'Claude Code has no widget host; people resume stalled runs in OrgX.',
  },
  'read-only': {
    resume_agent_run: 'Fail-closed fallback has no write tools.',
  },
});

/** Profiles a ChatGPT connector can be pointed at; no exceptions allowed. */
export const CHATGPT_REACHABLE_PROFILES = ['chatgpt', 'v2'] as const;
