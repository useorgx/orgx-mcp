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
 *   - the legacy names the widget runtime rewrites to canonical tools,
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
 * - resume_agent_run: the agent-status widget's Resume button.
 */
export const WIDGET_ONLY_TOOL_IDS = [
  'orgx_widget_decide',
  'orgx_panel_snapshot',
  'resume_agent_run',
] as const;

const WIDGET_ONLY_TOOL_ID_SET = new Set<string>(WIDGET_ONLY_TOOL_IDS);

export function isWidgetOnlyTool(toolId: string): boolean {
  return WIDGET_ONLY_TOOL_ID_SET.has(toolId);
}

/**
 * Legacy tool names a widget (or a live grant's refresh tool) may still use,
 * rewritten by the widget runtime to the canonical tool before the host sees
 * the call. Mirrors TOOL_ALIASES in public/widgets/shared/widget-runtime.js.
 *
 * get_pending_decisions is not on any public profile. orgx_decide
 * action=list_pending runs the same read (orgx_decide → approve_agent_work →
 * get_pending_decisions) and returns the same payload and widget approval
 * tokens.
 */
export const WIDGET_RUNTIME_TOOL_ALIASES: Readonly<
  Record<string, { tool: string; args: Readonly<Record<string, unknown>> }>
> = Object.freeze({
  get_pending_decisions: Object.freeze({
    tool: 'orgx_decide',
    args: Object.freeze({ action: 'list_pending' }),
  }),
});

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
    'agent-status': ['orgx_command_status', 'resume_agent_run'],
    'artifact-review': ['orgx_act', 'orgx_command_status', 'orgx_decide'],
    decisions: ['get_pending_decisions', 'orgx_command_status', 'orgx_widget_decide'],
    'entity-card': ['orgx_command_status', 'orgx_inspect'],
    'initiative-pulse': [],
    'morning-brief': [],
    'orgx-panel': ['orgx_command_status', 'orgx_panel_snapshot', 'orgx_widget_decide'],
    'plan-session-live': ['orgx_command_status', 'orgx_plan'],
    'proof-receipt': [],
    'scaffolded-initiative': ['orgx_act', 'orgx_command_status'],
    'search-results': ['orgx_search'],
    'task-spawned': ['orgx_command_status'],
    'work-ledger': ['get_operator_chronicle'],
    'workspace-map': ['orgx_bootstrap'],
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
const LIVE_REFRESH_ONLY =
  'Live refresh only: when the stream token expires the widget keeps its last snapshot.';

export const WIDGET_CALL_PROFILE_EXCEPTIONS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
  'claude-directory': {},
  'read-only': {
    orgx_command_status:
      'Fail-closed fallback keeps its seven informational tools.',
    resume_agent_run: 'Fail-closed fallback has no write tools.',
  },
  'claude-plugin': {
    orgx_widget_decide:
      'Claude Code renders no widgets; decisions are settled in OrgX.',
    resume_agent_run: 'Claude Code renders no widgets; agents use manage_lifecycle.',
  },
  memory: {
    orgx_command_status: 'Agent memory profile; no widget polling.',
    orgx_widget_decide: 'Agent memory profile; decisions are settled in OrgX.',
    get_agent_status: LIVE_REFRESH_ONLY,
    get_initiative_pulse: LIVE_REFRESH_ONLY,
  },
  commander: {
    orgx_widget_decide: 'Agent profile; decisions are settled in OrgX.',
    get_agent_status: LIVE_REFRESH_ONLY,
    get_initiative_pulse: LIVE_REFRESH_ONLY,
  },
  planner: {
    orgx_widget_decide: 'Agent profile; decisions are settled in OrgX.',
    get_agent_status: LIVE_REFRESH_ONLY,
    get_initiative_pulse: LIVE_REFRESH_ONLY,
  },
  executor: {
    get_agent_status: LIVE_REFRESH_ONLY,
    get_initiative_pulse: LIVE_REFRESH_ONLY,
  },
  observer: {
    orgx_widget_decide: 'Read-only monitoring profile; decisions are settled in OrgX.',
    get_agent_status: LIVE_REFRESH_ONLY,
    get_initiative_pulse: LIVE_REFRESH_ONLY,
  },
});

/** Profiles a ChatGPT connector can be pointed at; no exceptions allowed. */
export const CHATGPT_REACHABLE_PROFILES = ['chatgpt', 'v2'] as const;
