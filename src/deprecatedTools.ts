import { routeBatchCreateEntitiesToScaffoldInitiative } from './batchCreateHierarchyRoute';
import {
  asFiniteNumber,
  asNonEmptyString,
  compactArgs,
  type ToolArgs,
} from './toolRoutingUtils';

export type DeprecatedToolWarning = {
  deprecatedToolId: string;
  replacementToolId: string;
  replacementAction?: string;
  routed: boolean;
};

/** The owner updates clients and reconnects as part of the coordinated release. */
export const MCP_COMPATIBILITY_RETIREMENT_POLICY = 'coordinated-upgrade';

type DeprecatedToolRoute = {
  replacementToolId: string;
  replacementAction?: string;
  route?: (args: ToolArgs) => ToolArgs | null;
};

function asBillingCycle(value: unknown): 'monthly' | 'annual' | undefined {
  const normalized = asNonEmptyString(value);
  return normalized === 'monthly' || normalized === 'annual'
    ? normalized
    : undefined;
}

const DEPRECATED_TOOL_ROUTES: Record<string, DeprecatedToolRoute> = {
  get_pending_decisions: {
    replacementToolId: 'approve_agent_work',
    route: (args) => {
      return compactArgs({
        action: 'list',
        limit: asFiniteNumber(args.limit),
        urgency_filter: asNonEmptyString(args.urgency_filter),
        initiative_id: asNonEmptyString(args.initiative_id),
      });
    },
  },
  get_decision_history: {
    replacementToolId: 'recall_memory',
    route: (args) => {
      const topic = asNonEmptyString(args.topic);
      if (!topic || asNonEmptyString(args.initiative_id)) {
        return null;
      }

      return compactArgs({
        query: topic,
        scope: 'decisions',
        limit: asFiniteNumber(args.limit),
      });
    },
  },
  score_next_up_queue: {
    replacementToolId: 'recommend_next_action',
    route: (args) => {
      const initiativeId = asNonEmptyString(args.initiative_id);
      return compactArgs({
        entity_type: initiativeId ? 'initiative' : 'workspace',
        entity_id: initiativeId,
        workspace_id: asNonEmptyString(args.workspace_id),
        command_center_id: asNonEmptyString(args.command_center_id),
        limit: asFiniteNumber(args.limit),
      });
    },
  },
  batch_create_entities: {
    replacementToolId: 'scaffold_initiative',
    route: routeBatchCreateEntitiesToScaffoldInitiative,
  },
  start_autonomous_session: {
    replacementToolId: 'entity_action',
    replacementAction: 'auto_run',
  },
  complete_plan: {
    replacementToolId: 'entity_action',
    replacementAction: 'complete_plan',
  },
  get_outcome_attribution: {
    replacementToolId: 'get_morning_brief',
  },
  create_checkout_session: {
    replacementToolId: 'account_upgrade',
    route: (args) => {
      const plan = asNonEmptyString(args.plan);
      if (plan && plan !== 'starter' && plan !== 'team') {
        return null;
      }

      // SECURITY: never forward a caller-supplied user_id. account_upgrade
      // acts as the authenticated session user only.
      return compactArgs({
        target_plan: 'pro',
        billing_cycle: asBillingCycle(args.billing_cycle),
      });
    },
  },
};

/**
 * Legacy tool names that a v2-core tool fully covers: same upstream effect,
 * every legacy argument maps onto the canonical tool without loss, the same
 * auth requirement, and the canonical result is the result the legacy tool
 * already returned.
 *
 * These are aliases at the handler, not at the transport. The legacy name
 * stays registered exactly as before (name, input schema, annotations, _meta,
 * profile and run-token gating), so no caller and no listed surface changes;
 * its handler checks the legacy auth requirement, maps the arguments and runs
 * the canonical tool's implementation (executeLegacyToolAlias in
 * src/index.ts). A transport rename is deliberately not used: it would make
 * the call depend on the canonical name being registered on the connection,
 * which a profile or run-token grant naming only the legacy tool does not
 * guarantee, and the legacy input schema would no longer validate the call.
 *
 * Only add an entry after checking every condition above. Tools whose
 * coverage is partial (an argument the canonical schema cannot carry, a
 * different result shape, a different auth requirement) stay standalone.
 * Decision approval and rejection never belong here.
 */
export type LegacyToolAlias = {
  canonicalToolId: string;
  canonicalAction: string;
  mapArgs: (args: ToolArgs) => ToolArgs;
};

export const LEGACY_TOOL_ALIASES: Readonly<Record<string, LegacyToolAlias>> =
  Object.freeze({
    start_plan_session: {
      canonicalToolId: 'orgx_plan',
      canonicalAction: 'start',
      mapArgs: (args: ToolArgs) => ({ ...args, action: 'start' }),
    },
    improve_plan: {
      canonicalToolId: 'orgx_plan',
      canonicalAction: 'improve',
      mapArgs: (args: ToolArgs) => ({ ...args, action: 'improve' }),
    },
    validate_studio_content: {
      canonicalToolId: 'orgx_act',
      canonicalAction: 'validate',
      mapArgs: (args: ToolArgs) => ({
        ...args,
        type: 'studio_content',
        action: 'validate',
      }),
    },
  });

export function resolveLegacyToolAlias(toolId: string): LegacyToolAlias | null {
  return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_ALIASES, toolId)
    ? LEGACY_TOOL_ALIASES[toolId]!
    : null;
}

export const DEPRECATED_TOOL_IDS = Object.freeze([
  ...Object.keys(DEPRECATED_TOOL_ROUTES),
  ...Object.keys(LEGACY_TOOL_ALIASES),
]);

export function resolveDeprecatedToolCall(
  toolId: string,
  args: ToolArgs = {}
): {
  resolvedToolId: string;
  resolvedArgs: ToolArgs;
  warning?: DeprecatedToolWarning;
} {
  const alias = resolveLegacyToolAlias(toolId);
  if (alias) {
    // Name and arguments pass through untouched: the registered legacy
    // handler runs the canonical implementation, so the call is routed.
    return {
      resolvedToolId: toolId,
      resolvedArgs: args,
      warning: {
        deprecatedToolId: toolId,
        replacementToolId: alias.canonicalToolId,
        replacementAction: alias.canonicalAction,
        routed: true,
      },
    };
  }

  const route = DEPRECATED_TOOL_ROUTES[toolId];
  if (!route) {
    return { resolvedToolId: toolId, resolvedArgs: args };
  }

  if (!route.route) {
    return {
      resolvedToolId: toolId,
      resolvedArgs: args,
      warning: {
        deprecatedToolId: toolId,
        replacementToolId: route.replacementToolId,
        replacementAction: route.replacementAction,
        routed: false,
      },
    };
  }

  const routedArgs = route.route(args);
  if (!routedArgs) {
    return {
      resolvedToolId: toolId,
      resolvedArgs: args,
      warning: {
        deprecatedToolId: toolId,
        replacementToolId: route.replacementToolId,
        replacementAction: route.replacementAction,
        routed: false,
      },
    };
  }

  return {
    resolvedToolId: route.replacementToolId,
    resolvedArgs: routedArgs,
    warning: {
      deprecatedToolId: toolId,
      replacementToolId: route.replacementToolId,
      replacementAction: route.replacementAction,
      routed: true,
    },
  };
}

export function withDeprecatedToolWarningHeaders(
  response: Response,
  warning?: DeprecatedToolWarning | DeprecatedToolWarning[]
): Response {
  const warnings = Array.isArray(warning) ? warning : warning ? [warning] : [];
  if (!warnings.length) {
    return response;
  }
  const first = warnings[0];
  const headers = new Headers(response.headers);
  headers.set('x-orgx-deprecated-tool', first.deprecatedToolId);
  headers.set('x-orgx-replacement-tool', first.replacementToolId);
  headers.set('x-orgx-deprecation-routed', first.routed ? 'true' : 'false');
  headers.set('x-orgx-deprecation-retirement-policy', MCP_COMPATIBILITY_RETIREMENT_POLICY);
  headers.delete('x-orgx-deprecation-min-quiet-days');
  // Remove stale declarations from old middleware; no automatic expiry exists.
  headers.delete('x-orgx-deprecation-sunset-at');
  headers.delete('x-orgx-deprecation-window-days');
  headers.delete('Sunset');
  if (warnings.length > 1) {
    headers.set('x-orgx-deprecated-tools', [...new Set(warnings.map((item) => item.deprecatedToolId))].slice(0, 16).join(', '));
    headers.set('x-orgx-deprecated-call-count', String(warnings.length));
  }
  if (first.replacementAction) headers.set('x-orgx-replacement-action', first.replacementAction);
  else headers.delete('x-orgx-replacement-action');
  const replacement = first.replacementAction
    ? `${first.replacementToolId} (action=${first.replacementAction})` : first.replacementToolId;
  const suffix = first.routed ? ' The request was routed automatically.' : ' The legacy call was retained.';
  headers.set('Warning', `299 orgx-mcp "${first.deprecatedToolId} is deprecated; use ${replacement}.${suffix} Update the client and reconnect to refresh OrgX tools."`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
