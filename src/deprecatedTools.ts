type ToolArgs = Record<string, unknown>;

export type DeprecatedToolWarning = {
  deprecatedToolId: string;
  replacementToolId: string;
  replacementAction?: string;
  routed: boolean;
};

type DeprecatedToolRoute = {
  replacementToolId: string;
  replacementAction?: string;
  route?: (args: ToolArgs) => ToolArgs | null;
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBillingCycle(value: unknown): 'monthly' | 'annual' | undefined {
  const normalized = asNonEmptyString(value);
  return normalized === 'monthly' || normalized === 'annual'
    ? normalized
    : undefined;
}

function compactArgs(args: ToolArgs): ToolArgs {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined)
  );
}

const DEPRECATED_TOOL_ROUTES: Record<string, DeprecatedToolRoute> = {
  get_pending_decisions: {
    replacementToolId: 'list_entities',
    route: (args) => {
      const urgencyFilter = asNonEmptyString(args.urgency_filter);
      if (urgencyFilter && urgencyFilter !== 'all') {
        return null;
      }

      return compactArgs({
        type: 'decision',
        status: 'pending',
        limit: asFiniteNumber(args.limit),
        initiative_id: asNonEmptyString(args.initiative_id),
      });
    },
  },
  get_decision_history: {
    replacementToolId: 'query_org_memory',
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

      return compactArgs({
        target_plan: 'pro',
        billing_cycle: asBillingCycle(args.billing_cycle),
        user_id: asNonEmptyString(args.user_id),
      });
    },
  },
};

export function resolveDeprecatedToolCall(
  toolId: string,
  args: ToolArgs = {}
): {
  resolvedToolId: string;
  resolvedArgs: ToolArgs;
  warning?: DeprecatedToolWarning;
} {
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
  warning?: DeprecatedToolWarning
): Response {
  if (!warning) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('x-orgx-deprecated-tool', warning.deprecatedToolId);
  headers.set('x-orgx-replacement-tool', warning.replacementToolId);
  headers.set('x-orgx-deprecation-routed', warning.routed ? 'true' : 'false');

  if (warning.replacementAction) {
    headers.set('x-orgx-replacement-action', warning.replacementAction);
  }

  const replacement = warning.replacementAction
    ? `${warning.replacementToolId} (action=${warning.replacementAction})`
    : warning.replacementToolId;
  const suffix = warning.routed
    ? ' The request was routed automatically.'
    : ' The legacy tool was left in place for compatibility.';
  headers.set(
    'Warning',
    `299 orgx-mcp "${warning.deprecatedToolId} is deprecated; use ${replacement}.${suffix}"`
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
